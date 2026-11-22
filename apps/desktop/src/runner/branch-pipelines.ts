import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError, type BranchPipelines, type LatestPipelines, type PipelineState, type CategoryGitAccess, type GitProvider, type Project, type RemotePipelineDetail, type RemoteJobErrors } from "../shared/contracts";
import { nativeHelper } from "./native-helper";
import { Store } from "./store";

const git = promisify(execFile);
export type Credential = {
  id: string;
  updatedAt: string;
  encrypted?: string;
  iv?: string;
  tag?: string;
};

function credentialKey(scope: "category" | "project", value: string, provider: GitProvider) {
  const hash = createHash("sha256").update(value.trim()).digest("hex");
  return `${scope}-git:${provider}:${hash}`;
}

export function encryptToken(store: Store, token: string) {
  const key = createHash("sha256").update(store.installationId() + "-vault-key").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptToken(store: Store, cred: Credential): string | null {
  if (!cred.encrypted || !cred.iv || !cred.tag) return null;
  try {
    const key = createHash("sha256").update(store.installationId() + "-vault-key").digest();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(cred.iv, "base64"));
    decipher.setAuthTag(Buffer.from(cred.tag, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(cred.encrypted, "base64")), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

function credential(store: Store, scope: "category" | "project", value: string, provider: GitProvider): Credential | null {
  const row = store.db.query("SELECT value FROM installation WHERE key=?")
    .get(credentialKey(scope, value, provider)) as { value: string } | null;
  return row ? JSON.parse(row.value) as Credential : null;
}

function listAccess(store: Store, scope: "category" | "project", value: string): CategoryGitAccess[] {
  return (["github", "gitlab"] as const).map((provider) => {
    const item = credential(store, scope, value, provider);
    return { provider, configured: !!item, ...(item ? { updatedAt: item.updatedAt } : {}) };
  });
}
export const listCategoryGitAccess = (store: Store, category: string) => listAccess(store, "category", category);
export const listProjectGitAccess = (store: Store, projectId: string) => {
  store.project(projectId);
  return listAccess(store, "project", projectId);
};

async function putAccess(
  store: Store, scope: "category" | "project", value: string, provider: GitProvider, token: string,
): Promise<CategoryGitAccess> {
  const key = credentialKey(scope, value, provider);
  const old = credential(store, scope, value, provider);
  const enc = encryptToken(store, token);
  const item: Credential = {
    id: `${store.installationId()}/${key.replaceAll(":", "-")}/${crypto.randomUUID()}`,
    updatedAt: new Date().toISOString(),
    ...enc,
  };
  void nativeHelper({ op: "vault_put", id: item.id, value: token }).catch(() => {});
  store.db.query("INSERT INTO installation (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, JSON.stringify(item));
  if (old) void nativeHelper({ op: "vault_delete", id: old.id }).catch(() => {});
  return { provider, configured: true, updatedAt: item.updatedAt };
}
export const putCategoryGitAccess = (store: Store, category: string, provider: GitProvider, token: string) =>
  putAccess(store, "category", category, provider, token);
export const putProjectGitAccess = (store: Store, projectId: string, provider: GitProvider, token: string) => {
  store.project(projectId);
  return putAccess(store, "project", projectId, provider, token);
};

async function deleteAccess(store: Store, scope: "category" | "project", value: string, provider: GitProvider) {
  const item = credential(store, scope, value, provider);
  if (item) {
    await nativeHelper({ op: "vault_delete", id: item.id });
    store.db.query("DELETE FROM installation WHERE key=?").run(credentialKey(scope, value, provider));
  }
  return null;
}
export const deleteCategoryGitAccess = (store: Store, category: string, provider: GitProvider) =>
  deleteAccess(store, "category", category, provider);
export const deleteProjectGitAccess = (store: Store, projectId: string, provider: GitProvider) => {
  store.project(projectId);
  return deleteAccess(store, "project", projectId, provider);
};

const HOSTS_KEY = "git-hosts";
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;
// An entry is "origin-host" or "origin-host=api-host" when the SSH host differs from the web/API host.
const cleanHost = (input: string) => input.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
export function normalizeHost(input: string): string {
  const [origin, api, extra] = input.split("=").map(cleanHost);
  const hosts = api === undefined ? [origin] : [origin, api];
  if (extra !== undefined || hosts.some((h) => !HOST_RE.test(h) || h === "github.com" || h === "gitlab.com"))
    throw new AppError("INVALID_GIT_HOST", "Enter a self-hosted GitLab host name such as gitlab.example.com (no path, no http://).");
  return api && api !== origin ? `${origin}=${api}` : origin;
}
export function listGitHosts(store: Store): string[] {
  const row = store.db.query("SELECT value FROM installation WHERE key=?").get(HOSTS_KEY) as { value: string } | null;
  try { const hosts = row ? JSON.parse(row.value) : []; return Array.isArray(hosts) ? hosts.filter((h) => typeof h === "string") : []; }
  catch { return []; }
}
function saveGitHosts(store: Store, hosts: string[]) {
  store.db.query("INSERT INTO installation (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(HOSTS_KEY, JSON.stringify(hosts));
  return hosts;
}
export const addGitHost = (store: Store, input: string) => {
  const host = normalizeHost(input);
  const hosts = listGitHosts(store);
  const origin = host.split("=")[0];
  return saveGitHosts(store, [...hosts.filter((h) => h.split("=")[0] !== origin), host].sort());
};
export const removeGitHost = (store: Store, input: string) =>
  saveGitHosts(store, listGitHosts(store).filter((h) => h !== input.trim().toLowerCase()));

export function parseRemote(remote: string, selfHosted: string[] = []): { provider: GitProvider; repository: string; api: string; host: string } {
  const url = remote.trim();
  const match = /^(?:(?:https:\/\/|ssh:\/\/git@)([A-Za-z0-9.-]+)(?::\d{1,5})?\/|git@([A-Za-z0-9.-]+):)([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+?)(?:\.git)?\/?$/.exec(url);
  const originHost = (match?.[1] || match?.[2])?.toLowerCase();
  const entry = originHost ? selfHosted.find((h) => h === originHost || h.startsWith(`${originHost}=`)) : undefined;
  const host = entry ? entry.split("=")[1] || originHost : originHost;
  if (!match || !host || !(host === "github.com" || host === "gitlab.com" || entry))
    throw new AppError("UNSUPPORTED_GIT_REMOTE", "Set origin to a github.com or gitlab.com repository, or add your self-hosted GitLab host in Git access settings.");
  const provider: GitProvider = host === "github.com" ? "github" : "gitlab";
  const repository = match[3].replace(/\.git$/, "");
  if (repository.split("/").some((part) => part === "." || part === ".."))
    throw new AppError("UNSUPPORTED_GIT_REMOTE", "The Git origin URL is invalid.");
  // An ssh:// or https:// port in origin is not carried over: the API always uses https on the default port.
  return { provider, repository, host, api: provider === "github" ? "https://api.github.com" : `https://${host}/api/v4` };
}

export async function json<T>(url: string, headers: Record<string, string>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(12000) });
  } catch {
    throw new AppError("GIT_API_UNAVAILABLE", "The Git provider did not respond. Check your connection and retry.");
  }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? "The Git access token was rejected or lacks permission to view this repository."
      : response.status === 404
        ? "The repository was not found or the token cannot access it."
        : `The Git provider returned HTTP ${response.status}. Retry later.`;
    throw new AppError("GIT_API_ERROR", message);
  }
  return response.json() as Promise<T>;
}

export async function projectRemoteAndToken(store: Store, project: Project) {
  let remote: string;
  try {
    remote = (await git("git", ["remote", "get-url", "origin"], {
      cwd: project.path, timeout: 5000, maxBuffer: 8192,
    })).stdout;
  } catch {
    throw new AppError("GIT_REMOTE_MISSING", "This project needs an origin Git remote to check branch pipelines.");
  }
  const { provider, repository, api, host } = parseRemote(remote, listGitHosts(store));
  const projectCred = credential(store, "project", project.id, provider);
  const categoryCred = project.category?.trim()
    ? credential(store, "category", project.category, provider)
    : null;

  // 1. Try locally decrypting project credential
  let token = projectCred ? decryptToken(store, projectCred) : null;

  // 2. If project credential is missing or unencrypted, fallback to category credential
  if (!token && categoryCred) {
    const catToken = decryptToken(store, categoryCred);
    if (catToken) {
      token = catToken;
      if (projectCred && !projectCred.encrypted) {
        const enc = encryptToken(store, catToken);
        const credKey = credentialKey("project", project.id, provider);
        store.db.query("UPDATE installation SET value=? WHERE key=?")
          .run(JSON.stringify({ ...projectCred, ...enc }), credKey);
      }
    }
  }

  // 3. If neither is decryptable locally, attempt nativeHelper once as fallback
  if (!token && (projectCred || categoryCred)) {
    const fallbackItem = projectCred || categoryCred!;
    try {
      token = await nativeHelper<string>({ op: "vault_get", id: fallbackItem.id });
      if (token) {
        const enc = encryptToken(store, token);
        const credKey = fallbackItem === projectCred
          ? credentialKey("project", project.id, provider)
          : credentialKey("category", project.category!, provider);
        store.db.query("UPDATE installation SET value=? WHERE key=?")
          .run(JSON.stringify({ ...fallbackItem, ...enc }), credKey);
      }
    } catch {}
  }

  if (!token) {
    throw new AppError("GIT_TOKEN_MISSING", `Add or re-enter a ${provider === "github" ? "GitHub" : "GitLab"} token in Git access settings.`);
  }
  return { remote: { provider, repository, api, host }, token };
}

export async function listBranchPipelines(store: Store, project: Project): Promise<BranchPipelines> {
  const { remote, token } = await projectRemoteAndToken(store, project);
  return fetchBranchPipelines(remote, token);
}

export async function fetchBranchPipelines(
  remote: ReturnType<typeof parseRemote>, token: string,
): Promise<BranchPipelines> {
  const { provider, repository, api } = remote;
  const headers: Record<string, string> = provider === "github"
    ? { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "Act-Dock" }
    : { Accept: "application/json", "PRIVATE-TOKEN": token };
  if (provider === "github") {
    const base = `${api}/repos/${repository}`;
    const [branches, runs] = await Promise.all([
      json<{ name: string }[]>(`${base}/branches?per_page=100`, headers),
      json<{ workflow_runs: { id: number; head_branch: string | null; status: string; conclusion: string | null; name: string; html_url: string; updated_at: string }[] }>(`${base}/actions/runs?per_page=100`, headers),
    ]);
    const latest = new Map<string, (typeof runs.workflow_runs)[number]>();
    for (const run of runs.workflow_runs) if (run.head_branch && !latest.has(run.head_branch)) latest.set(run.head_branch, run);
    return { provider, repository, host: remote.host, branches: branches.map(({ name }) => {
      const run = latest.get(name);
      return { branch: name, status: run?.status || "no recent pipeline",
        ...(run?.conclusion ? { conclusion: run.conclusion } : {}),
        ...(run ? { id: run.id, name: run.name, url: run.html_url, updatedAt: run.updated_at } : {}) };
    }) };
  }
  const base = `${api}/projects/${encodeURIComponent(repository)}`;
  const [branches, runs] = await Promise.all([
    json<{ name: string }[]>(`${base}/repository/branches?per_page=100`, headers),
    json<{ id: number; ref: string; status: string; web_url: string; updated_at: string }[]>(`${base}/pipelines?per_page=100`, headers),
  ]);
  const latest = new Map<string, (typeof runs)[number]>();
  for (const run of runs) if (!latest.has(run.ref)) latest.set(run.ref, run);
  return { provider, repository, host: remote.host, branches: branches.map(({ name }) => {
    const run = latest.get(name);
    return { branch: name, status: run?.status || "no recent pipeline",
      ...(run ? { id: run.id, url: run.web_url, updatedAt: run.updated_at } : {}) };
  }) };
}

export function pipelineState(status: string, conclusion?: string | null): PipelineState {
  if (["created", "waiting_for_resource", "preparing", "pending", "running", "queued", "in_progress", "waiting", "requested"].includes(status)) return "running";
  const outcome = status === "completed" ? conclusion || "" : status;
  if (outcome === "success") return "success";
  if (["failed", "failure", "timed_out", "startup_failure"].includes(outcome)) return "failed";
  return "other";
}

export async function getLatestPipelines(store: Store, project: Project): Promise<LatestPipelines> {
  const { remote, token } = await projectRemoteAndToken(store, project);
  return fetchLatestPipelines(remote, token);
}

export async function fetchLatestPipelines(
  remote: ReturnType<typeof parseRemote>, token: string,
): Promise<LatestPipelines> {
  const { provider, repository, api, host } = remote;
  if (provider === "github") {
    const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "Act-Dock" };
    const runs = await json<{ workflow_runs: { id: number; head_branch: string | null; status: string; conclusion: string | null; html_url: string; updated_at: string }[] }>(
      `${api}/repos/${repository}/actions/runs?per_page=15`, headers);
    return { provider, repository, host, pipelines: runs.workflow_runs.map((run) => ({
      id: run.id, branch: run.head_branch || "", state: pipelineState(run.status, run.conclusion), url: run.html_url, updatedAt: run.updated_at })) };
  }
  const runs = await json<{ id: number; ref: string; status: string; web_url: string; updated_at: string }[]>(
    `${api}/projects/${encodeURIComponent(repository)}/pipelines?per_page=15`, { Accept: "application/json", "PRIVATE-TOKEN": token });
  return { provider, repository, host, pipelines: runs.map((run) => ({
    id: run.id, branch: run.ref, state: pipelineState(run.status), url: run.web_url, updatedAt: run.updated_at })) };
}

export async function getBranchPipelineDetail(store: Store, project: Project, pipelineId: number) {
  const { remote, token } = await projectRemoteAndToken(store, project);
  return fetchBranchPipelineDetail(remote, token, pipelineId);
}

export async function fetchBranchPipelineDetail(
  remote: ReturnType<typeof parseRemote>, token: string, pipelineId: number,
): Promise<RemotePipelineDetail> {
  const { provider, repository, api } = remote;
  const headers: Record<string, string> = provider === "github"
    ? { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "Act-Dock" }
    : { Accept: "application/json", "PRIVATE-TOKEN": token };
  if (provider === "github") {
    const result = await json<{ jobs: {
      id: number; name: string; status: string; conclusion: string | null; html_url: string;
      steps?: { number: number; name: string; status: string; conclusion: string | null }[];
    }[] }>(`${api}/repos/${repository}/actions/runs/${pipelineId}/jobs?per_page=100`, headers);
    return { jobs: result.jobs.map((job) => ({
      id: job.id, name: job.name, status: job.status,
      ...(job.conclusion ? { conclusion: job.conclusion } : {}),
      url: job.html_url,
      steps: (job.steps || []).map((step) => ({
        number: step.number, name: step.name, status: step.status,
        ...(step.conclusion ? { conclusion: step.conclusion } : {}),
      })),
    })) };
  }
  const result = await json<{
    id: number; name: string; status: string; failure_reason?: string; web_url: string; stage: string;
  }[]>(`${api}/projects/${encodeURIComponent(repository)}/pipelines/${pipelineId}/jobs?per_page=100`, headers);
  return { jobs: result.map((job) => ({
    id: job.id, name: job.name, status: job.status,
    ...(job.failure_reason ? { failureReason: job.failure_reason } : {}),
    stage: job.stage,
    url: job.web_url,
    steps: [],
  })) };
}

function errorLines(raw: string, truncated: boolean): RemoteJobErrors {
  const lines = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/).map((line) => line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd());
  const matching = lines.filter((line) => /##\[error\]|\b(error|fatal|exception|failed|failure)\b/i.test(line));
  return { lines: (matching.length ? matching.slice(-20) : lines.slice(-20)).map((line) => line.slice(0, 2000)), truncated };
}

async function readTail(response: Response): Promise<RemoteJobErrors> {
  if (!response.ok || !response.body)
    throw new AppError("GIT_LOG_UNAVAILABLE", "The job log is unavailable. Open the job in your Git provider to inspect it.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0, truncated = false;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    text += decoder.decode(next.value, { stream: true });
    if (text.length > 262144) { text = text.slice(-131072); truncated = true; }
    if (bytes > 8 * 1024 * 1024) { truncated = true; await reader.cancel(); break; }
  }
  return errorLines(text + decoder.decode(), truncated);
}

export async function getBranchJobErrors(store: Store, project: Project, jobId: number) {
  const { remote, token } = await projectRemoteAndToken(store, project);
  return fetchBranchJobErrors(remote, token, jobId);
}

export async function fetchBranchJobErrors(
  remote: ReturnType<typeof parseRemote>, token: string, jobId: number,
): Promise<RemoteJobErrors> {
  const { provider, repository, api } = remote;
  if (provider === "gitlab") {
    const response = await fetch(`${api}/projects/${encodeURIComponent(repository)}/jobs/${jobId}/trace`, {
      headers: { "PRIVATE-TOKEN": token }, redirect: "error", signal: AbortSignal.timeout(12000),
    });
    return readTail(response);
  }
  const response = await fetch(`${api}/repos/${repository}/actions/jobs/${jobId}/logs`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Act-Dock" },
    redirect: "manual", signal: AbortSignal.timeout(12000),
  });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location)
    throw new AppError("GIT_LOG_UNAVAILABLE", "The job log is unavailable. Open the job in GitHub to inspect it.");
  const signed = new URL(location);
  const allowed = signed.hostname.endsWith(".actions.githubusercontent.com") ||
    signed.hostname.endsWith(".githubusercontent.com") || signed.hostname.endsWith(".blob.core.windows.net");
  if (signed.protocol !== "https:" || !allowed || signed.username || signed.password)
    throw new AppError("GIT_LOG_UNAVAILABLE", "The job log download location was not recognized. Open it in GitHub.");
  return readTail(await fetch(signed, { redirect: "error", signal: AbortSignal.timeout(12000) }));
}

export function isValidBranchName(name: string): boolean {
  if (!name || !name.trim()) return false;
  const trimmed = name.trim();
  if (/[\s\x00-\x1f\x7f~^:?*\[\\@]|\.\.|\.lock$|^\/|\/$|\.$/.test(trimmed)) return false;
  if (trimmed.includes("@{")) return false;
  return true;
}

export async function requestApi(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: any,
): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    console.error("[git-api-fetch-failed]", url, err);
    throw new AppError("GIT_API_UNAVAILABLE", "The Git provider did not respond. Check your connection and retry.");
  }
  if (!response.ok) {
    let errorDetail = "";
    try {
      const data = await response.json();
      errorDetail = data.message || data.error || (typeof data === "string" ? data : "");
      if (typeof errorDetail === "object") {
        errorDetail = JSON.stringify(errorDetail);
      }
    } catch {}
    const message = errorDetail || `The Git provider returned HTTP ${response.status}.`;
    console.error("[git-api-error]", method, url, response.status, message);
    throw new AppError("GIT_API_ERROR", message);
  }
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function deleteBranch(
  store: Store,
  project: Project,
  branch: string,
): Promise<{ ok: boolean; branch: string }> {
  let gitSuccess = false;
  let gitError: string | null = null;

  // 1. Attempt local git push origin --delete in project.path first (uses existing SSH keys)
  if (project.path) {
    try {
      await git("git", ["push", "origin", "--delete", branch], { cwd: project.path, timeout: 20000 });
      gitSuccess = true;
      try {
        await git("git", ["branch", "-D", branch], { cwd: project.path, timeout: 5000 });
        await git("git", ["fetch", "--prune"], { cwd: project.path, timeout: 5000 });
      } catch {}
    } catch (err: any) {
      gitError = err?.stderr || err?.message || String(err);
      console.warn("[deleteBranch] git cli push delete failed, falling back to API:", gitError);
    }
  }

  if (gitSuccess) {
    return { ok: true, branch };
  }

  // 2. Fallback to remote Git provider REST API
  try {
    const { remote, token } = await projectRemoteAndToken(store, project);
    await executeDeleteBranch(remote, token, branch);
    if (project.path) {
      try {
        await git("git", ["branch", "-D", branch], { cwd: project.path, timeout: 5000 });
        await git("git", ["fetch", "--prune"], { cwd: project.path, timeout: 5000 });
      } catch {}
    }
    return { ok: true, branch };
  } catch (apiErr: any) {
    const message = apiErr?.message || gitError || "Failed to delete branch.";
    throw new AppError(apiErr?.code || "DELETE_BRANCH_FAILED", message);
  }
}

export async function executeDeleteBranch(
  remote: ReturnType<typeof parseRemote>,
  token: string,
  branch: string,
): Promise<void> {
  const { provider, repository, api } = remote;
  if (provider === "github") {
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Act-Dock",
    };
    const refPath = branch.startsWith("heads/") ? branch : `heads/${branch}`;
    await requestApi(`${api}/repos/${repository}/git/refs/${refPath}`, "DELETE", headers);
    return;
  }
  const headers = { "PRIVATE-TOKEN": token, Accept: "application/json" };
  await requestApi(
    `${api}/projects/${encodeURIComponent(repository)}/repository/branches/${encodeURIComponent(branch)}`,
    "DELETE",
    headers,
  );
}

export async function renameBranch(
  store: Store,
  project: Project,
  oldBranch: string,
  newBranch: string,
): Promise<{ ok: boolean; oldBranch: string; newBranch: string }> {
  if (!isValidBranchName(newBranch)) {
    throw new AppError("INVALID_BRANCH_NAME", `"${newBranch}" is not a valid Git branch name.`);
  }
  if (oldBranch === newBranch) {
    throw new AppError("INVALID_BRANCH_NAME", "The new branch name must differ from the current name.");
  }

  let gitSuccess = false;
  let gitError: string | null = null;

  // 1. Attempt local git branch rename & push in project.path first
  if (project.path) {
    try {
      await git("git", ["fetch", "origin", `${oldBranch}:${oldBranch}`], { cwd: project.path, timeout: 10000 }).catch(() => {});
      await git("git", ["branch", "-m", oldBranch, newBranch], { cwd: project.path, timeout: 5000 });
      await git("git", ["push", "origin", newBranch], { cwd: project.path, timeout: 20000 });
      await git("git", ["push", "origin", "--delete", oldBranch], { cwd: project.path, timeout: 20000 });
      await git("git", ["push", "--set-upstream", "origin", newBranch], { cwd: project.path, timeout: 10000 }).catch(() => {});
      gitSuccess = true;
    } catch (err: any) {
      gitError = err?.stderr || err?.message || String(err);
      console.warn("[renameBranch] git cli rename failed, falling back to API:", gitError);
    }
  }

  if (gitSuccess) {
    return { ok: true, oldBranch, newBranch };
  }

  // 2. Fallback to remote Git provider REST API
  try {
    const { remote, token } = await projectRemoteAndToken(store, project);
    await executeRenameBranch(remote, token, oldBranch, newBranch);
    if (project.path) {
      try {
        await git("git", ["branch", "-m", oldBranch, newBranch], { cwd: project.path, timeout: 5000 });
      } catch {}
    }
    return { ok: true, oldBranch, newBranch };
  } catch (apiErr: any) {
    const message = apiErr?.message || gitError || "Failed to rename branch.";
    throw new AppError(apiErr?.code || "RENAME_BRANCH_FAILED", message);
  }
}

export async function executeRenameBranch(
  remote: ReturnType<typeof parseRemote>,
  token: string,
  oldBranch: string,
  newBranch: string,
): Promise<void> {
  const { provider, repository, api } = remote;
  if (provider === "github") {
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Act-Dock",
    };
    await requestApi(
      `${api}/repos/${repository}/branches/${encodeURIComponent(oldBranch)}/rename`,
      "POST",
      headers,
      { new_name: newBranch },
    );
    return;
  }
  const headers = { "PRIVATE-TOKEN": token, Accept: "application/json" };
  await requestApi(
    `${api}/projects/${encodeURIComponent(repository)}/repository/branches?branch=${encodeURIComponent(newBranch)}&ref=${encodeURIComponent(oldBranch)}`,
    "POST",
    headers,
  );
  await requestApi(
    `${api}/projects/${encodeURIComponent(repository)}/repository/branches/${encodeURIComponent(oldBranch)}`,
    "DELETE",
    headers,
  );
}
