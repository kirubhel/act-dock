import { afterEach, expect, test } from "bun:test";
import { AppError, type Project, type PullRequestList } from "../src/shared/contracts";
import { json, rateLimitedUntil, resetGitHttpCache } from "../src/runner/branch-pipelines";
import { RemoteWatcher, type RemoteFetch } from "../src/runner/remote-watch";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; resetGitHttpCache(); });

const project = (id: string) => ({ id, name: id, path: `/tmp/${id}` }) as Project;
const prs = (n: number): PullRequestList => ({ provider: "github", repository: "t/r", pullRequests: Array.from({ length: n }, (_, i) => ({
  number: i + 1, title: "t", author: "a", own: false, draft: false, branch: "b", base: "main", url: "u", updatedAt: "x", headSha: "s",
  reviewers: "unknown", reviewDecision: "unknown", checkStatus: "unknown", mergeable: "unknown", isCurrentUserRequestedReviewer: "unknown",
})) });

function clock(start = 1_000_000) {
  const t = { now: start };
  return { t, now: () => t.now };
}

test("a tick never runs more projects at once than the concurrency cap", async () => {
  let inFlight = 0, peak = 0;
  const fetchProject: RemoteFetch = async () => {
    peak = Math.max(peak, ++inFlight);
    await Bun.sleep(5);
    inFlight--;
    return { api: "https://api.github.com", pullRequests: prs(1) };
  };
  const watcher = new RemoteWatcher(() => ["a", "b", "c", "d", "e"].map(project), fetchProject, { concurrency: 2 });
  await watcher.tick();
  expect(peak).toBe(2);
  expect(Object.keys(watcher.snapshot().projects)).toHaveLength(5);
});

test("the version only advances when a project's data changes", async () => {
  let count = 1;
  const watcher = new RemoteWatcher(() => [project("a")], async () => ({ api: "x", pullRequests: prs(count) }));
  const v0 = watcher.version;
  await watcher.tick();
  expect(watcher.version).toBe(v0 + 1);
  await watcher.tick();
  expect(watcher.version).toBe(v0 + 1);
  count = 2;
  await watcher.tick();
  expect(watcher.version).toBe(v0 + 2);
  expect(watcher.snapshot().projects.a.pullRequests?.pullRequests).toHaveLength(2);
});

test("wait resolves as soon as a newer snapshot exists and times out otherwise", async () => {
  const watcher = new RemoteWatcher(() => [project("a")], async () => ({ api: "x", pullRequests: prs(1) }), { intervalMs: 60_000 });
  const since = watcher.version;
  const woke = await watcher.wait(since, 2000); // touch() starts the first poll
  expect(woke.version).toBe(since + 1);
  const start = Date.now();
  const quiet = await watcher.wait(woke.version, 30);
  expect(quiet.version).toBe(woke.version);
  expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  watcher.stop();
});

test("a failing project keeps its last data, backs off exponentially, then recovers", async () => {
  const { t, now } = clock();
  let fail = false, calls = 0;
  const fetchProject: RemoteFetch = async () => {
    calls++;
    if (fail) throw new AppError("GIT_API_ERROR", "boom");
    return { api: "x", pullRequests: prs(1) };
  };
  const watcher = new RemoteWatcher(() => [project("a")], fetchProject, { now, intervalMs: 1000, maxBackoffMs: 3000 });
  await watcher.tick();
  fail = true;
  await watcher.tick();
  const state = watcher.snapshot().projects.a;
  expect(state.error).toEqual({ code: "GIT_API_ERROR", message: "boom" });
  expect(state.pullRequests?.pullRequests).toHaveLength(1);
  expect(calls).toBe(2);
  t.now += 1500; await watcher.tick(); expect(calls).toBe(2);        // first backoff is 2s
  t.now += 600; await watcher.tick(); expect(calls).toBe(3);         // due; fails again, backoff 3s (capped)
  t.now += 2500; await watcher.tick(); expect(calls).toBe(3);
  fail = false;
  t.now += 600; await watcher.tick(); expect(calls).toBe(4);
  expect(watcher.snapshot().projects.a.error).toBeUndefined();
  t.now += 1; await watcher.tick(); expect(calls).toBe(5);           // success cleared the backoff
});

test("a rate-limited host is skipped until it allows requests again", async () => {
  const { t, now } = clock();
  let limitedUntil = 0;
  const seen: string[] = [];
  const fetchProject: RemoteFetch = async (p) => {
    seen.push(p.id);
    if (p.id === "a" && limitedUntil === 0) {
      limitedUntil = t.now + 10_000;
      return { api: "https://api.github.com", error: { code: "GIT_RATE_LIMITED", message: "slow down" } };
    }
    return { api: "https://api.github.com", pullRequests: prs(1) };
  };
  const watcher = new RemoteWatcher(() => [project("a"), project("b")], fetchProject, {
    now, intervalMs: 1000, concurrency: 1, rateLimitedUntil: () => (limitedUntil > t.now ? limitedUntil : 0),
  });
  await watcher.tick();                       // a is rate limited (the fetcher reports its host); b is a different project
  t.now += 3000; await watcher.tick();        // both share the limited host: nothing is requested
  expect(seen).toEqual(["a", "b"]);
  t.now += 8000; await watcher.tick();        // limit lifted
  expect(seen).toEqual(["a", "b", "a", "b"]);
});

test("polling only continues while a client keeps asking", async () => {
  let calls = 0;
  const watcher = new RemoteWatcher(() => [project("a")], async () => { calls++; return { api: "x", pullRequests: prs(1) }; }, { intervalMs: 10, interestMs: 0 });
  await watcher.wait(0, 0);
  await Bun.sleep(60);
  expect(calls).toBe(1);
  const keepAlive = new RemoteWatcher(() => [project("a")], async () => { calls++; return { api: "x", pullRequests: prs(1) }; }, { intervalMs: 10, interestMs: 60_000 });
  const before = calls;
  await keepAlive.wait(0, 0);
  await Bun.sleep(80);
  expect(calls - before).toBeGreaterThan(2);
  keepAlive.stop();
});

test("removed projects disappear from the snapshot", async () => {
  let list = [project("a"), project("b")];
  const watcher = new RemoteWatcher(() => list, async () => ({ api: "x", pullRequests: prs(1) }));
  await watcher.tick();
  list = [project("a")];
  const before = watcher.version;
  await watcher.tick();
  expect(Object.keys(watcher.snapshot().projects)).toEqual(["a"]);
  expect(watcher.version).toBe(before + 1);
});

test("json sends If-None-Match and reuses the cached body on 304", async () => {
  const seen: (string | null)[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const inm = new Headers(init?.headers).get("if-none-match");
    seen.push(inm);
    return inm === '"v1"' ? new Response(null, { status: 304 }) : new Response(JSON.stringify({ n: 1 }), { headers: { etag: '"v1"' } });
  }) as typeof fetch;
  const h = { Authorization: "Bearer one" };
  expect(await json("https://api.example.com/a", h)).toEqual({ n: 1 });
  expect(await json("https://api.example.com/a", h)).toEqual({ n: 1 });
  expect(seen).toEqual([null, '"v1"']);
  await json("https://api.example.com/a", { Authorization: "Bearer two" }); // another token never reuses the first token's cache
  expect(seen).toEqual([null, '"v1"', null]);
});

test("a rate-limit response pauses that host and raises GIT_RATE_LIMITED", async () => {
  const reset = Math.floor(Date.now() / 1000) + 120;
  globalThis.fetch = (async () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } })) as unknown as typeof fetch;
  await expect(json("https://api.github.com/repos/t/r/pulls", { Authorization: "Bearer t" })).rejects.toMatchObject({ code: "GIT_RATE_LIMITED" });
  expect(rateLimitedUntil("https://api.github.com")).toBe(reset * 1000);
  expect(rateLimitedUntil("https://gitlab.com/api/v4")).toBe(0);
  globalThis.fetch = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
  await expect(json("https://gitlab.com/api/v4/x", { "PRIVATE-TOKEN": "t" })).rejects.toMatchObject({ code: "GIT_API_ERROR" });
  expect(rateLimitedUntil("https://gitlab.com/api/v4")).toBe(0);
});
