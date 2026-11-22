import { AppError, type LatestPipelines, type Project, type PullRequestList, type RemoteProjectState, type RemoteSnapshot } from "../shared/contracts";
import { fetchLatestPipelines, projectRemoteAndToken, rateLimitedUntil } from "./branch-pipelines";
import { mapLimit } from "./map-limit";
import { fetchPullRequests } from "./pull-requests";
import type { Store } from "./store";

/** One project's refresh. Each half may fail on its own; `api` lets the watcher honor a host-wide rate limit. */
export type RemoteFetch = (project: Project) => Promise<{
  api: string; pullRequests?: PullRequestList; pipelines?: LatestPipelines; error?: { code: string; message: string };
}>;

export function remoteFetcher(store: Store): RemoteFetch {
  return async (project) => {
    const { remote, token } = await projectRemoteAndToken(store, project);
    const [prs, pipelines] = await Promise.allSettled([fetchPullRequests(remote, token), fetchLatestPipelines(remote, token)]);
    const failure = [prs, pipelines].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    const error = failure && { code: failure.reason instanceof AppError ? failure.reason.code : "GIT_API_ERROR", message: failure.reason instanceof Error ? failure.reason.message : "The Git provider request failed." };
    return { api: remote.api, ...(prs.status === "fulfilled" ? { pullRequests: prs.value } : {}),
      ...(pipelines.status === "fulfilled" ? { pipelines: pipelines.value } : {}), ...(error ? { error } : {}) };
  };
}

type Options = {
  intervalMs: number; concurrency: number; interestMs: number; maxBackoffMs: number;
  now: () => number; rateLimitedUntil: (api: string) => number;
};

/**
 * Polls every project's pull requests and pipelines from the runner, so the desktop window only reads a cached snapshot.
 * Polling runs only while a client has asked for the snapshot recently, so a closed app does not spend the Git token's quota.
 * A project that fails backs off exponentially; a rate-limited host is skipped until it allows requests again.
 */
export class RemoteWatcher {
  /** Starts from the clock so a restarted runner never reports a version a client has already seen. */
  version: number;
  private states = new Map<string, RemoteProjectState>();
  private failures = new Map<string, { count: number; until: number }>();
  private hosts = new Map<string, string>();
  private waiters = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastInterest = -Infinity;
  private ticking = false;
  private stopped = false;
  private opts: Options;

  constructor(private projects: () => Project[], private fetchProject: RemoteFetch, options: Partial<Options> = {}) {
    this.opts = { intervalMs: 60_000, concurrency: 3, interestMs: 3 * 60_000, maxBackoffMs: 15 * 60_000, now: Date.now, rateLimitedUntil, ...options };
    this.version = Math.floor(this.opts.now() / 1000);
  }

  snapshot(): RemoteSnapshot {
    return { version: this.version, projects: Object.fromEntries(this.states) };
  }

  /** Long-poll: resolves when the snapshot is newer than `since`, or after `waitMs`. Calling it keeps polling alive. */
  async wait(since: number, waitMs: number): Promise<RemoteSnapshot> {
    this.touch();
    if (this.version > since || waitMs <= 0 || this.stopped) return this.snapshot();
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, waitMs);
      this.waiters.add(done);
    });
    return this.snapshot();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const wake of [...this.waiters]) wake();
  }

  private touch() {
    this.lastInterest = this.opts.now();
    if (!this.timer && !this.ticking && !this.stopped) this.timer = setTimeout(() => void this.loop(), 0);
  }

  private async loop() {
    this.timer = undefined;
    await this.tick();
    if (!this.stopped && this.opts.now() - this.lastInterest < this.opts.interestMs)
      this.timer = setTimeout(() => void this.loop(), this.opts.intervalMs);
  }

  /** One pass over every due project. Exposed for tests. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const projects = this.projects(), ids = new Set(projects.map((p) => p.id));
      let changed = false;
      for (const id of [...this.states.keys()]) if (!ids.has(id)) { this.states.delete(id); this.failures.delete(id); this.hosts.delete(id); changed = true; }
      const now = this.opts.now();
      const due = projects.filter((p) => {
        if ((this.failures.get(p.id)?.until ?? 0) > now) return false;
        const api = this.hosts.get(p.id);
        return !(api && this.opts.rateLimitedUntil(api) > now);
      });
      const results = await mapLimit(due, this.opts.concurrency, (p) => this.refresh(p));
      if (changed || results.some(Boolean)) this.bump();
    } finally {
      this.ticking = false;
    }
  }

  private async refresh(project: Project): Promise<boolean> {
    const previous = this.states.get(project.id);
    let next: RemoteProjectState;
    try {
      const result = await this.fetchProject(project);
      this.hosts.set(project.id, result.api);
      next = { pullRequests: result.pullRequests ?? previous?.pullRequests, pipelines: result.pipelines ?? previous?.pipelines, ...(result.error ? { error: result.error } : {}) };
      if (result.error) this.fail(project.id, result.error.code, result.api); else this.failures.delete(project.id);
    } catch (error) {
      const code = error instanceof AppError ? error.code : "GIT_API_ERROR";
      next = { pullRequests: previous?.pullRequests, pipelines: previous?.pipelines,
        error: { code, message: error instanceof Error ? error.message : "The Git provider request failed." } };
      this.fail(project.id, code, this.hosts.get(project.id));
    }
    if (!next.pullRequests) delete next.pullRequests;
    if (!next.pipelines) delete next.pipelines;
    const digest = (s?: RemoteProjectState) => JSON.stringify([s?.pullRequests, s?.pipelines, s?.error]);
    if (digest(previous) === digest(next)) return false;
    this.states.set(project.id, { ...next, updatedAt: new Date(this.opts.now()).toISOString() });
    return true;
  }

  private fail(projectId: string, code: string, api: string | undefined) {
    const count = (this.failures.get(projectId)?.count ?? 0) + 1, now = this.opts.now();
    const backoff = Math.min(this.opts.intervalMs * 2 ** count, this.opts.maxBackoffMs);
    const limited = code === "GIT_RATE_LIMITED" && api ? this.opts.rateLimitedUntil(api) : 0;
    this.failures.set(projectId, { count, until: Math.max(now + backoff, limited) });
  }

  private bump() {
    this.version++;
    for (const wake of [...this.waiters]) wake();
  }
}
