import { AppError, type Project, type PullRequestDecision, type PullRequestDetail, type PullRequestFile, type PullRequestList, type PullRequestReviewResult, type PullRequestSummary } from "../shared/contracts";
import { json, projectRemoteAndToken, requestApi, type parseRemote } from "./branch-pipelines";
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
};
type GlMr = {
  iid: number; title: string; draft?: boolean; web_url: string; updated_at: string; sha?: string | null;
  author?: { username: string } | null; source_branch: string; target_branch: string; description?: string | null;
};

function summarize(remote: Remote, raw: GhPull | GlMr, me: string | undefined): PullRequestSummary {
  if (remote.provider === "github") {
    const pr = raw as GhPull, author = pr.user?.login || "unknown";
    return { number: pr.number, title: pr.title, author, own: !!me && author.toLowerCase() === me, draft: !!pr.draft,
      branch: pr.head.ref, base: pr.base.ref, url: pr.html_url, updatedAt: pr.updated_at, headSha: pr.head.sha };
  }
  const mr = raw as GlMr, author = mr.author?.username || "unknown";
  return { number: mr.iid, title: mr.title, author, own: !!me && author.toLowerCase() === me, draft: !!mr.draft,
    branch: mr.source_branch, base: mr.target_branch, url: mr.web_url, updatedAt: mr.updated_at, headSha: mr.sha || "" };
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
  return { provider, repository, host, ...(me ? { viewer: me } : {}), pullRequests: items.map((item) => summarize(remote, item, me)) };
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
    return { ...summarize(remote, pr, me), provider, repository, host, body: pr.body || "", files, truncated };
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
  return { ...summarize(remote, mr, me), provider, repository, host, body: mr.description || "", files, truncated };
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
