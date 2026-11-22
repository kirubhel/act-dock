import { afterEach, expect, test } from "bun:test";
import { parseRemote } from "../src/runner/branch-pipelines";
import {
  fetchPullRequest, fetchPullRequests, githubCheckStatus, githubMergeable, githubReviewDecision, gitlabCheckStatus, gitlabMergeable, gitlabReviewDecision,
  sendReview, submitPullRequestReview,
} from "../src/runner/pull-requests";
import { parseReview } from "../src/runner/claude-review";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const github = parseRemote("https://github.com/team/repo.git");
const gitlab = parseRemote("https://gitlab.com/group/repo.git");

function mock(routes: Record<string, unknown>, calls: { url: string; method: string; body?: unknown }[] = []) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    calls.push({ url: String(url), method: init?.method || "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (!key) return new Response("{}", { status: 404 });
    return Response.json(routes[key]);
  }) as typeof fetch;
  return calls;
}

test("GitHub pull requests flag the viewer's own work", async () => {
  mock({
    "/user": { login: "Me" },
    "/pulls?": [
      { number: 7, title: "Mine", user: { login: "me" }, head: { ref: "a", sha: "abc1234" }, base: { ref: "main" }, html_url: "https://github.com/team/repo/pull/7", updated_at: "2026-11-20T00:00:00Z" },
      { number: 8, title: "Theirs", draft: true, user: { login: "bob" }, head: { ref: "b", sha: "def5678" }, base: { ref: "main" }, html_url: "https://github.com/team/repo/pull/8", updated_at: "2026-11-20T00:00:00Z" },
    ],
  });
  const list = await fetchPullRequests(github, "t");
  expect(list.viewer).toBe("me");
  expect(list.pullRequests.map((p) => [p.number, p.own, p.draft, p.headSha])).toEqual([[7, true, false, "abc1234"], [8, false, true, "def5678"]]);
});

test("a token that cannot read /user still lists pull requests", async () => {
  mock({ "/merge_requests?": [{ iid: 3, title: "T", author: { username: "ann" }, source_branch: "f", target_branch: "main", web_url: "https://gitlab.com/g/r/-/merge_requests/3", updated_at: "x", sha: "aaaaaaa" }] });
  const list = await fetchPullRequests(gitlab, "t");
  expect(list.viewer).toBeUndefined();
  expect(list.pullRequests[0]).toMatchObject({ number: 3, author: "ann", own: false, base: "main" });
});

test("GitLab merge request diffs become files with line counts", async () => {
  mock({
    "/user": { username: "me" },
    "/diffs": [
      { old_path: "a.ts", new_path: "a.ts", new_file: false, renamed_file: false, deleted_file: false, diff: "@@ -1 +1,2 @@\n-old\n+new\n+more\n" },
      { old_path: "b.ts", new_path: "c.ts", new_file: false, renamed_file: true, deleted_file: false, diff: "" },
    ],
    "/merge_requests/3": { iid: 3, title: "T", description: "why", author: { username: "ann" }, source_branch: "f", target_branch: "main", web_url: "u", updated_at: "x", sha: "aaaaaaa" },
  });
  const pr = await fetchPullRequest(gitlab, "t", 3);
  expect(pr.body).toBe("why");
  expect(pr.files).toEqual([
    { path: "a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-old\n+new\n+more\n" },
    { path: "c.ts", oldPath: "b.ts", status: "renamed", additions: 0, deletions: 0 },
  ]);
});

test("GitHub reviews pin the reviewed commit", async () => {
  const calls = mock({ "/reviews": { html_url: "https://github.com/team/repo/pull/7#pullrequestreview-1" } });
  const result = await sendReview(github, "t", { number: 7, decision: "request_changes", body: "Please fix", headSha: "abc1234" });
  expect(result).toEqual({ ok: true, decision: "request_changes", url: "https://github.com/team/repo/pull/7#pullrequestreview-1" });
  expect(calls[0]).toMatchObject({ method: "POST", body: { event: "REQUEST_CHANGES", body: "Please fix", commit_id: "abc1234" } });
});

test("GitLab approves against the reviewed SHA and sends requested changes as a note", async () => {
  const calls = mock({ "/approve": {}, "/notes": { id: 1 } });
  await sendReview(gitlab, "t", { number: 3, decision: "approve", body: "LGTM", headSha: "aaaaaaa" });
  await sendReview(gitlab, "t", { number: 3, decision: "request_changes", body: "Fix it" });
  expect(calls.map((c) => [c.method, c.url.split("/merge_requests/3")[1], c.body])).toEqual([
    ["POST", "/approve", { sha: "aaaaaaa" }],
    ["POST", "/notes", { body: "LGTM" }],
    ["POST", "/notes", { body: "**Changes requested**\n\nFix it" }],
  ]);
});

test("agents cannot approve and sending back needs a reason", async () => {
  const none = {} as never;
  await expect(submitPullRequestReview(none, none, { number: 1, decision: "approve", body: "" }, "mcp")).rejects.toMatchObject({ code: "APPROVAL_NEEDS_PERSON" });
  await expect(submitPullRequestReview(none, none, { number: 1, decision: "request_changes", body: "  " }, "desktop")).rejects.toMatchObject({ code: "REVIEW_BODY_REQUIRED" });
});

test("Claude review output is normalized and prose is preserved", () => {
  const review = parseReview('Sure!\n{"verdict":"request_changes","summary":"Bug","findings":[{"severity":"high","comment":"Wrong op","file":"a.ts","line":3},{"severity":"weird","comment":"x"},{"comment":""}],"reviewBody":"Fix"}');
  expect(review.verdict).toBe("request_changes");
  expect(review.findings).toEqual([{ severity: "high", comment: "Wrong op", file: "a.ts", line: 3 }, { severity: "low", comment: "x" }]);
  expect(parseReview("Looks fine overall.")).toEqual({ verdict: null, summary: "Looks fine overall.", findings: [], reviewBody: "" });
  expect(parseReview('{"verdict":"merge","summary":"s"}').verdict).toBeNull();
});

/** Like mock(), but a numeric route value is returned as that HTTP status. Routes are matched in order, so list specific ones first. */
function mockStatus(routes: Record<string, unknown>) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) return new Response("{}", { status: 404 });
    const value = routes[key];
    return typeof value === "number" ? new Response("{}", { status: value }) : Response.json(value);
  }) as typeof fetch;
}
const ghPull = (n: number, extra: object = {}) => ({
  number: n, title: `PR ${n}`, user: { login: "bob" }, head: { ref: "f", sha: `sha${n}` }, base: { ref: "main" },
  html_url: `https://github.com/team/repo/pull/${n}`, updated_at: "2026-11-20T00:00:00Z", requested_reviewers: [{ login: "Me" }], ...extra,
});

test("GitHub PR state comes from reviews, checks and the single-PR endpoint", async () => {
  mockStatus({
    "/user": { login: "me" },
    "/pulls/7/reviews": [
      { user: { login: "ann" }, state: "CHANGES_REQUESTED" }, { user: { login: "ann" }, state: "APPROVED" },
      { user: { login: "cat" }, state: "COMMENTED" },
    ],
    "/pulls/7": { ...ghPull(7), mergeable: false },
    "/commits/sha7/check-runs": { check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }] },
    "/commits/sha7/status": { state: "pending", total_count: 0 },
    "/pulls?": [ghPull(7)],
  });
  const [pr] = (await fetchPullRequests(github, "t")).pullRequests;
  expect(pr).toMatchObject({ reviewers: ["Me"], reviewDecision: "approved", checkStatus: "failure", mergeable: "conflicting", isCurrentUserRequestedReviewer: true });
});

test("a forbidden sub-request blanks only its own field", async () => {
  mockStatus({
    "/user": { login: "me" },
    "/pulls/7/reviews": 403,
    "/pulls/7": { ...ghPull(7), mergeable: true },
    "/commits/sha7/check-runs": { check_runs: [{ status: "completed", conclusion: "success" }] },
    "/commits/sha7/status": { state: "success", total_count: 1 },
    "/pulls?": [ghPull(7)],
  });
  const [pr] = (await fetchPullRequests(github, "t")).pullRequests;
  expect(pr).toMatchObject({ reviewDecision: "unknown", checkStatus: "success", mergeable: "clean" });
});

test("review, check and merge state do not depend on the viewer", async () => {
  mockStatus({
    "/user": 401,
    "/pulls/7/reviews": [{ user: { login: "ann" }, state: "APPROVED" }],
    "/pulls/7": { ...ghPull(7), mergeable: true },
    "/commits/sha7/check-runs": { check_runs: [{ status: "completed", conclusion: "success" }] },
    "/commits/sha7/status": { state: "success", total_count: 1 },
    "/pulls?": [ghPull(7)],
  });
  const list = await fetchPullRequests(github, "t");
  expect(list.viewer).toBeUndefined();
  expect(list.pullRequests[0]).toMatchObject({ reviewDecision: "approved", checkStatus: "success", mergeable: "clean", isCurrentUserRequestedReviewer: "unknown" });
});

test("GitLab MR state comes from approval_state and the single-MR endpoint", async () => {
  const mr = { iid: 3, title: "T", author: { username: "ann" }, reviewers: [{ username: "me" }], source_branch: "f", target_branch: "main", web_url: "u", updated_at: "x", sha: "aaaaaaa" };
  mockStatus({
    "/user": { username: "me" },
    "/merge_requests/3/approval_state": { rules: [{ approvals_required: 1, approved: false, approved_by: [] }] },
    "/merge_requests/3": { ...mr, has_conflicts: false, detailed_merge_status: "not_approved", head_pipeline: { status: "running" } },
    "/merge_requests?": [mr],
  });
  const [item] = (await fetchPullRequests(gitlab, "t")).pullRequests;
  expect(item).toMatchObject({ reviewers: ["me"], reviewDecision: "review_required", checkStatus: "pending", mergeable: "clean", isCurrentUserRequestedReviewer: true });
});

test("GitLab without pipeline visibility or approval access stays unknown", async () => {
  const mr = { iid: 3, title: "T", author: { username: "ann" }, source_branch: "f", target_branch: "main", web_url: "u", updated_at: "x", sha: "aaaaaaa" };
  mockStatus({ "/user": 401, "/merge_requests/3": 403, "/merge_requests?": [mr] });
  const [item] = (await fetchPullRequests(gitlab, "t")).pullRequests;
  expect(item).toMatchObject({ reviewers: "unknown", reviewDecision: "unknown", checkStatus: "unknown", mergeable: "unknown", isCurrentUserRequestedReviewer: "unknown" });
});

test("GitHub review decision uses each reviewer's latest review", () => {
  expect(githubReviewDecision(undefined)).toBe("unknown");
  expect(githubReviewDecision([])).toBe("review_required");
  expect(githubReviewDecision([{ user: { login: "a" }, state: "CHANGES_REQUESTED" }, { user: { login: "a" }, state: "DISMISSED" }])).toBe("review_required");
  expect(githubReviewDecision([{ user: { login: "a" }, state: "APPROVED" }, { user: { login: "b" }, state: "CHANGES_REQUESTED" }])).toBe("changes_requested");
});

test("GitHub check status covers none, pending, failing and partial data", () => {
  const ok = { check_runs: [{ status: "completed", conclusion: "success" }] };
  expect(githubCheckStatus({ check_runs: [] }, { state: "pending", total_count: 0 })).toBe("unknown");
  expect(githubCheckStatus({ check_runs: [{ status: "in_progress", conclusion: null }] }, { state: "success", total_count: 1 })).toBe("pending");
  expect(githubCheckStatus(ok, { state: "failure", total_count: 1 })).toBe("failure");
  expect(githubCheckStatus(ok, { state: "success", total_count: 1 })).toBe("success");
  expect(githubCheckStatus(ok, undefined)).toBe("unknown");
  expect(githubCheckStatus({ check_runs: [{ status: "completed", conclusion: "failure" }] }, undefined)).toBe("failure");
});

test("mergeable and GitLab helpers map provider values", () => {
  expect(githubMergeable({ mergeable: null })).toBe("unknown");
  expect(githubMergeable({ mergeable: true, mergeable_state: "dirty" })).toBe("conflicting");
  expect(gitlabMergeable({ has_conflicts: false, detailed_merge_status: "checking" })).toBe("unknown");
  expect(gitlabMergeable({ detailed_merge_status: "conflict" })).toBe("conflicting");
  expect(gitlabCheckStatus({ status: "failed" })).toBe("failure");
  expect(gitlabCheckStatus({ status: "skipped" })).toBe("unknown");
  expect(gitlabCheckStatus(null)).toBe("unknown");
  expect(gitlabReviewDecision({ rules: [{ approvals_required: 2, approved: true }, { approvals_required: 1, approved: true }] })).toBe("approved");
  expect(gitlabReviewDecision({ rules: [] })).toBe("unknown");
  expect(gitlabReviewDecision(undefined)).toBe("unknown");
});
