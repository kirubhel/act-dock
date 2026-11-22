import { AppError, type Project, type PullRequestDecision, type PullRequestDetail, type PullRequestFile, type PullRequestCheckStatus, type PullRequestList, type PullRequestMergeable, type PullRequestReviewDecision, type PullRequestReviewResult, type PullRequestSummary } from "../shared/contracts";
import { json, projectRemoteAndToken, requestApi, type parseRemote } from "./branch-pipelines";
import { mapLimit } from "./map-limit";
import { Store } from "./store";

type Remote = ReturnType<typeof parseRemote>;
const MAX_FILES = 300;
const MAX_PATCH = 60_000;

function headers(remote: Remote, token: string): Record<string, string> {
  return remote.provider === "github"
    ? { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "Act-Dock" }
    : { Accept: "application/json", "PRIVATE-TOKEN": token };
}
const gitlabBase = (remote: Remote) => `${remote.api}/projects/${encodeURIComponent(remote.repository)}`;

function countLines(patch: string | undefined) {
  let additions = 0, deletions = 0;
  for (const line of (patch || "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}
const clip = (patch: string | undefined) =>
  patch === undefined ? undefined : patch.length > MAX_PATCH ? `${patch.slice(0, MAX_PATCH)}\n… patch truncated` : patch;

async function viewer(remote: Remote, token: string): Promise<string | undefined> {
  try {
    const user = await json<{ login?: string; username?: string }>(`${remote.api}/user`, headers(remote, token));
    return (user.login || user.username || "").toLowerCase() || undefined;
  } catch { return undefined; } // a token without user scope still lists pull requests
}

type GhPull = {
  number: number; title: string; draft?: boolean; html_url: string; updated_at: string;
  user?: { login: string } | null; head: { ref: string; sha: string }; base: { ref: string }; body?: string | null;
  requested_reviewers?: { login: string }[]; requested_teams?: { slug: string }[];
  mergeable?: boolean | null; mergeable_state?: string;
};
type GlMr = {
  iid: number; title: string; draft?: boolean; web_url: string; updated_at: string; sha?: string | null;
  author?: { username: string } | null; source_branch: string; target_branch: string; description?: string | null;
  reviewers?: { username: string }[]; detailed_merge_status?: string; has_conflicts?: boolean;
  head_pipeline?: { status?: string } | null;
};
type GhReview = { user?: { login: string } | null; state: string };
type GhCheckRuns = { check_runs: { status: string; conclusion: string | null }[] };
type GhCombinedStatus = { state: string; total_count?: number };
type GlApprovalState = { rules?: { approvals_required?: number; approved?: boolean; approved_by?: unknown[] }[] };

const MAX_ENRICHED = 50;
const ENRICH_CONCURRENCY = 5;

/** GitHub only fills `mergeable` on the single-PR endpoint, and returns null while it computes it. */
export function githubMergeable(pr: Pick<GhPull, "mergeable" | "mergeable_state">): PullRequestMergeable {
  if (pr.mergeable === false || pr.mergeable_state === "dirty") return "conflicting";
  return pr.mergeable === true ? "clean" : "unknown";
}

/** Approximates GitHub's review decision from each reviewer's latest review. Branch protection rules are not visible to us. */
export function githubReviewDecision(reviews: GhReview[] | undefined): PullRequestReviewDecision {
  if (!reviews) return "unknown";
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const who = (review.user?.login || "").toLowerCase();
    if (!who) continue;
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") latest.set(who, review.state);
    else if (review.state === "DISMISSED") latest.delete(who);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  return states.includes("APPROVED") ? "approved" : "review_required";
}

const FAILED_RUN = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"]);
const PASSED_RUN = new Set(["success", "neutral", "skipped"]);

export function githubCheckStatus(runs: GhCheckRuns | undefined, status: GhCombinedStatus | undefined): PullRequestCheckStatus {
  const items = runs?.check_runs ?? [];
  const legacy = status && (status.total_count ?? 1) > 0 ? status.state : undefined;
  if (items.some((r) => r.status === "completed" && FAILED_RUN.has(r.conclusion || "")) || legacy === "failure" || legacy === "error") return "failure";
  // One source failing to load means a failure there would be invisible, so do not claim success or pending.
  if (!runs || !status) return "unknown";
  if (items.some((r) => r.status !== "completed") || legacy === "pending") return "pending";
  if (items.length === 0 && !legacy) return "unknown";
  return items.every((r) => PASSED_RUN.has(r.conclusion || "")) ? "success" : "unknown";
}

export function gitlabReviewDecision(state: GlApprovalState | undefined): PullRequestReviewDecision {
  if (!state?.rules) return "unknown";
  const required = state.rules.filter((rule) => (rule.approvals_required ?? 0) > 0);
  if (required.length) return required.every((rule) => rule.approved) ? "approved" : "review_required";
  return state.rules.some((rule) => (rule.approved_by?.length ?? 0) > 0) ? "approved" : "unknown";
}

export function gitlabCheckStatus(pipeline: GlMr["head_pipeline"]): PullRequestCheckStatus {
  const status = (pipeline?.status || "").toLowerCase();
  if (!status || status === "skipped") return "unknown";
  if (status === "success") return "success";
  if (status === "failed" || status === "canceled") return "failure";
  return ["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled", "manual"].includes(status) ? "pending" : "unknown";
}

export function gitlabMergeable(mr: Pick<GlMr, "has_conflicts" | "detailed_merge_status">): PullRequestMergeable {
  const status = (mr.detailed_merge_status || "").toLowerCase();
  if (mr.has_conflicts === true || status === "conflict") return "conflicting";
  if (["checking", "unchecked", "preparing"].includes(status)) return "unknown";
  return mr.has_conflicts === false ? "clean" : "unknown";
}

function summarize(remote: Remote, raw: GhPull | GlMr, me: string | undefined): PullRequestSummary {
  const viewerIsRequested = (names: string[]) => (me ? names.some((name) => name.toLowerCase() === me) : "unknown" as const);
  if (remote.provider === "github") {
    const pr = raw as GhPull, author = pr.user?.login || "unknown";
    const requested = pr.requested_reviewers?.map((r) => r.login) || [];
    return { number: pr.number, title: pr.title, author, own: !!me && author.toLowerCase() === me, draft: !!pr.draft,
      branch: pr.head.ref, base: pr.base.ref, url: pr.html_url, updatedAt: pr.updated_at, headSha: pr.head.sha,
      reviewers: pr.requested_reviewers ? [...requested, ...(pr.requested_teams || []).map((t) => `team:${t.slug}`)] : "unknown",
      reviewDecision: "unknown", checkStatus: "unknown", mergeable: githubMergeable(pr),
      isCurrentUserRequestedReviewer: viewerIsRequested(requested) };
  }
  const mr = raw as GlMr, author = mr.author?.username || "unknown";
  const requested = mr.reviewers?.map((r) => r.username) || [];
  return { number: mr.iid, title: mr.title, author, own: !!me && author.toLowerCase() === me, draft: !!mr.draft,
    branch: mr.source_branch, base: mr.target_branch, url: mr.web_url, updatedAt: mr.updated_at, headSha: mr.sha || "",
    reviewers: mr.reviewers ? requested : "unknown",
    reviewDecision: "unknown", checkStatus: gitlabCheckStatus(mr.head_pipeline), mergeable: gitlabMergeable(mr),
    isCurrentUserRequestedReviewer: viewerIsRequested(requested) };
}

/** A sub-request that fails (no permission, rate limit, timeout) only blanks its own field. */
async function settle<T>(request: Promise<T>): Promise<T | undefined> {
  try { return await request; } catch { return undefined; }
}

/**
 * Fills reviewDecision, checkStatus and mergeable, which the list endpoints do not return.
 * `detail` is the single PR/MR when the caller already fetched it, so it is not requested twice.
 * These fields never depend on the authenticated viewer.
 */
async function enrich(remote: Remote, h: Record<string, string>, summary: PullRequestSummary, detail?: GhPull | GlMr): Promise<PullRequestSummary> {
  if (remote.provider === "github") {
    const base = `${remote.api}/repos/${remote.repository}`, n = summary.number, sha = summary.headSha;
    const [pr, reviews, runs, status] = await Promise.all([
      detail ? Promise.resolve(detail as GhPull) : settle(json<GhPull>(`${base}/pulls/${n}`, h)),
      settle(json<GhReview[]>(`${base}/pulls/${n}/reviews?per_page=100`, h)),
      sha ? settle(json<GhCheckRuns>(`${base}/commits/${sha}/check-runs?per_page=100`, h)) : undefined,
      sha ? settle(json<GhCombinedStatus>(`${base}/commits/${sha}/status`, h)) : undefined,
    ]);
    return { ...summary, mergeable: pr ? githubMergeable(pr) : summary.mergeable,
      reviewDecision: githubReviewDecision(reviews), checkStatus: githubCheckStatus(runs, status) };
  }
  const base = `${gitlabBase(remote)}/merge_requests/${summary.number}`;
  const [mr, approvals] = await Promise.all([
    detail ? Promise.resolve(detail as GlMr) : settle(json<GlMr>(base, h)),
    settle(json<GlApprovalState>(`${base}/approval_state`, h)),
  ]);
  return { ...summary, reviewDecision: gitlabReviewDecision(approvals),
    ...(mr ? { checkStatus: gitlabCheckStatus(mr.head_pipeline), mergeable: gitlabMergeable(mr) } : {}) };
}

export async function listPullRequests(store: Store, project: Project): Promise<PullRequestList> {
  const { remote, token } = await projectRemoteAndToken(store, project);
  return fetchPullRequests(remote, token);
}

export async function fetchPullRequests(remote: Remote, token: string): Promise<PullRequestList> {
  const h = headers(remote, token);
  const url = remote.provider === "github"
    ? `${remote.api}/repos/${remote.repository}/pulls?state=open&sort=updated&direction=desc&per_page=30`
    : `${gitlabBase(remote)}/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=30`;
  const [items, me] = await Promise.all([json<(GhPull | GlMr)[]>(url, h), viewer(remote, token)]);
  const { provider, repository, host } = remote;
  const summaries = items.map((item) => summarize(remote, item, me));
  const enriched = await mapLimit(summaries.slice(0, MAX_ENRICHED), ENRICH_CONCURRENCY, (pr) => enrich(remote, h, pr));
  return { provider, repository, host, ...(me ? { viewer: me } : {}), pullRequests: [...enriched, ...summaries.slice(MAX_ENRICHED)] };
}

export async function getPullRequest(store: Store, project: Project, number: number): Promise<PullRequestDetail> {
  const { remote, token } = await projectRemoteAndToken(store, project);
  return fetchPullRequest(remote, token, number);
}

export async function fetchPullRequest(remote: Remote, token: string, number: number): Promise<PullRequestDetail> {
  const h = headers(remote, token);
  const { provider, repository, host } = remote;
  if (provider === "github") {
    const base = `${remote.api}/repos/${repository}/pulls/${number}`;
    const [pr, me] = await Promise.all([json<GhPull>(base, h), viewer(remote, token)]);
    const files: PullRequestFile[] = [];
    let truncated = false;
    for (let page = 1; page <= MAX_FILES / 100; page++) {
      const batch = await json<{ filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string }[]>(
        `${base}/files?per_page=100&page=${page}`, h);
      for (const f of batch) files.push({
        path: f.filename, ...(f.previous_filename ? { oldPath: f.previous_filename } : {}),
        status: f.status === "added" ? "added" : f.status === "removed" ? "removed" : f.status === "renamed" ? "renamed" : "modified",
        additions: f.additions, deletions: f.deletions, ...(f.patch !== undefined ? { patch: clip(f.patch) } : {}),
      });
      if (batch.length < 100) break;
      if (page === MAX_FILES / 100) truncated = true;
    }
    return { ...(await enrich(remote, h, summarize(remote, pr, me), pr)), provider, repository, host, body: pr.body || "", files, truncated };
  }
  const base = `${gitlabBase(remote)}/merge_requests/${number}`;
  const [mr, me] = await Promise.all([json<GlMr>(base, h), viewer(remote, token)]);
  type Diff = { old_path: string; new_path: string; new_file: boolean; renamed_file: boolean; deleted_file: boolean; diff?: string };
  const files: PullRequestFile[] = [];
  let truncated = false;
  for (let page = 1; page <= MAX_FILES / 100; page++) {
    const batch = await json<Diff[]>(`${base}/diffs?per_page=100&page=${page}`, h);
    for (const d of batch) files.push({
      path: d.new_path, ...(d.renamed_file ? { oldPath: d.old_path } : {}),
      status: d.new_file ? "added" : d.deleted_file ? "removed" : d.renamed_file ? "renamed" : "modified",
      ...countLines(d.diff), ...(d.diff ? { patch: clip(d.diff) } : {}),
    });
    if (batch.length < 100) break;
    if (page === MAX_FILES / 100) truncated = true;
  }
  return { ...(await enrich(remote, h, summarize(remote, mr, me), mr)), provider, repository, host, body: mr.description || "", files, truncated };
}

export async function submitPullRequestReview(
  store: Store, project: Project,
  input: { number: number; decision: PullRequestDecision; body: string; headSha?: string },
  source: "desktop" | "cli" | "mcp",
): Promise<PullRequestReviewResult> {
  // Approving is the reviewer's call. Agents may comment or request changes, but a person approves.
  if (input.decision === "approve" && source === "mcp")
    throw new AppError("APPROVAL_NEEDS_PERSON", "Agents cannot approve. Post a comment or request changes, and ask the user to approve in Act Dock.");
  const body = input.body.trim();
  if (input.decision !== "approve" && !body)
    throw new AppError("REVIEW_BODY_REQUIRED", input.decision === "request_changes"
      ? "Explain what needs to change before sending the pull request back."
      : "Write a comment before posting.");
  const { remote, token } = await projectRemoteAndToken(store, project);
  return sendReview(remote, token, { ...input, body });
}

export async function sendReview(
  remote: Remote, token: string,
  input: { number: number; decision: PullRequestDecision; body: string; headSha?: string },
): Promise<PullRequestReviewResult> {
  const h = headers(remote, token);
  const { number, decision, body, headSha } = input;
  if (remote.provider === "github") {
    const event = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" }[decision];
    const result = await requestApi(`${remote.api}/repos/${remote.repository}/pulls/${number}/reviews`, "POST", h,
      { event, ...(body ? { body } : {}), ...(headSha ? { commit_id: headSha } : {}) });
    return { ok: true, decision, ...(result?.html_url ? { url: result.html_url } : {}) };
  }
  // GitLab has no REST "request changes": it is posted as a merge request note instead.
  const base = `${gitlabBase(remote)}/merge_requests/${number}`;
  if (decision === "approve") {
    await requestApi(`${base}/approve`, "POST", h, headSha ? { sha: headSha } : undefined);
    if (body) await requestApi(`${base}/notes`, "POST", h, { body });
    return { ok: true, decision };
  }
  await requestApi(`${base}/notes`, "POST", h,
    { body: decision === "request_changes" ? `**Changes requested**\n\n${body}` : body });
  return { ok: true, decision };
}
