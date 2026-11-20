import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/runner/store";
import {
  deleteProjectGitAccess, fetchBranchPipelines, fetchBranchPipelineDetail, fetchBranchJobErrors, listBranchPipelines,
  listProjectGitAccess, fetchLatestPipelines, pipelineState, normalizeHost, parseRemote, putCategoryGitAccess, putProjectGitAccess,
  executeDeleteBranch, executeRenameBranch, isValidBranchName,
} from "../src/runner/branch-pipelines";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("only supported Git remotes can receive a token", () => {
  expect(parseRemote("git@github.com:team/repo.git")).toMatchObject({ provider: "github", repository: "team/repo" });
  expect(parseRemote("https://gitlab.com/group/subgroup/repo.git")).toMatchObject({ provider: "gitlab", repository: "group/subgroup/repo" });
  expect(parseRemote("git@git.matrix.et:ERP/core-engines/backend/auth-service.git", ["git.matrix.et"]))
    .toMatchObject({ provider: "gitlab", repository: "ERP/core-engines/backend/auth-service", api: "https://git.matrix.et/api/v4" });
  expect(parseRemote("ssh://git@git.matrix.et:2222/a/b.git", ["git.matrix.et"]).api).toBe("https://git.matrix.et/api/v4");
  expect(parseRemote("git@git.matrix.et:a/b.git", ["git.matrix.et=gitlab.matrix.et"]))
    .toMatchObject({ host: "gitlab.matrix.et", api: "https://gitlab.matrix.et/api/v4" });
  expect(normalizeHost("git.matrix.et = https://gitlab.matrix.et/")).toBe("git.matrix.et=gitlab.matrix.et");
  expect(() => parseRemote("git@git.matrix.et:a/b.git")).toThrow("self-hosted");
  expect(() => parseRemote("https://other.matrix.et/a/b", ["git.matrix.et"])).toThrow("origin");
  for (const remote of ["https://evil.example/repo", "https://token@github.com/team/repo", "file:///tmp/repo"])
    expect(() => parseRemote(remote)).toThrow("origin");
});

test("GitHub branch status uses the latest returned workflow run", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return Response.json(String(url).includes("/branches?")
      ? [{ name: "main" }, { name: "feature" }]
      : { workflow_runs: [{ head_branch: "main", status: "completed", conclusion: "success", name: "CI", html_url: "https://github.com/team/repo/actions/runs/1", updated_at: "2026-11-14T00:00:00Z" }] });
  }) as typeof fetch;
  const result = await fetchBranchPipelines(parseRemote("https://github.com/team/repo.git"), "test-token");
  expect(result.branches).toEqual([
    { branch: "main", status: "completed", conclusion: "success", name: "CI", url: "https://github.com/team/repo/actions/runs/1", updatedAt: "2026-11-14T00:00:00Z" },
    { branch: "feature", status: "no recent pipeline" },
  ]);
  expect(requests).toHaveLength(2);
  expect(requests.every(({ url, init }) => url.startsWith("https://api.github.com/repos/team/repo/") && init?.redirect === "error" && (init?.headers as Record<string, string>).Authorization === "Bearer test-token")).toBe(true);
});

test("GitLab branch status and errors do not disclose the token", async () => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("secret-token");
    return Response.json(String(url).includes("/repository/branches?")
      ? [{ name: "main" }]
      : [{ ref: "main", status: "success", web_url: "https://gitlab.com/group/repo/-/pipelines/2", updated_at: "2026-11-14T00:00:00Z" }]);
  }) as typeof fetch;
  const remote = parseRemote("git@gitlab.com:group/repo.git");
  const result = await fetchBranchPipelines(remote, "secret-token");
  expect(result.branches[0]).toMatchObject({ branch: "main", status: "success" });
  globalThis.fetch = (async () => new Response("secret-token", { status: 403 })) as unknown as typeof fetch;
  await expect(fetchBranchPipelines(remote, "secret-token")).rejects.toThrow("token was rejected");
});

test("GitHub detail identifies failed steps and reads an error excerpt without forwarding the token", async () => {
  const remote = parseRemote("https://github.com/team/repo.git");
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    if (String(url).includes("/runs/42/jobs")) return Response.json({ jobs: [{
      id: 9, name: "build", status: "completed", conclusion: "failure", html_url: "https://github.com/team/repo/actions/runs/42/job/9",
      steps: [{ number: 1, name: "Checkout", status: "completed", conclusion: "success" },
        { number: 2, name: "Compile", status: "completed", conclusion: "failure" }],
    }] });
    if (String(url).includes("/jobs/9/logs")) return new Response(null, {
      status: 302, headers: { Location: "https://pipelines.actions.githubusercontent.com/log.txt" },
    });
    return new Response("start\n##[error]Compiler failed at src/main.ts:7\nend", { status: 200 });
  }) as typeof fetch;
  const detail = await fetchBranchPipelineDetail(remote, "token", 42);
  expect(detail.jobs[0].steps[1]).toMatchObject({ name: "Compile", conclusion: "failure" });
  const errors = await fetchBranchJobErrors(remote, "token", 9);
  expect(errors.lines).toEqual(["##[error]Compiler failed at src/main.ts:7"]);
  expect(requests[1].init?.redirect).toBe("manual");
  expect((requests[1].init?.headers as Record<string, string>).Authorization).toBe("Bearer token");
  expect((requests[2].init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
});

test("GitLab detail exposes job failure reason and trace errors", async () => {
  const remote = parseRemote("git@gitlab.com:group/repo.git");
  globalThis.fetch = (async (url: string | URL | Request) => String(url).includes("/trace")
    ? new Response("\u001b[31mERROR: command failed\u001b[0m\n", { status: 200 })
    : Response.json([{ id: 12, name: "test", status: "failed", failure_reason: "script_failure", stage: "verify", web_url: "https://gitlab.com/group/repo/-/jobs/12" }])) as typeof fetch;
  const detail = await fetchBranchPipelineDetail(remote, "token", 7);
  expect(detail.jobs[0]).toMatchObject({ name: "test", status: "failed", stage: "verify", failureReason: "script_failure", steps: [] });
  expect((await fetchBranchJobErrors(remote, "token", 12)).lines).toEqual(["ERROR: command failed"]);
});

test("project token overrides a shared category token and values stay out of SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ad-git-access-"));
  const helper = join(directory, "vault-helper");
  const vault = join(directory, "vault.json");
  await writeFile(helper, `#!${process.execPath}\nconst fs = await import("node:fs");\nconst request = JSON.parse(await Bun.stdin.text());\nconst path = ${JSON.stringify(vault)};\nconst values = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};\nif (request.op === "vault_put") values[request.id] = request.value;\nif (request.op === "vault_delete") delete values[request.id];\nfs.writeFileSync(path, JSON.stringify(values));\nconsole.log(JSON.stringify({ ok: true, value: request.op === "vault_get" ? values[request.id] : null }));\n`);
  await chmod(helper, 0o700);
  const oldHelper = process.env.ACT_DOCK_HELPER_PATH;
  process.env.ACT_DOCK_HELPER_PATH = helper;
  const store = new Store(directory);
  try {
    execFileSync("git", ["init", "-q", directory]);
    execFileSync("git", ["-C", directory, "remote", "add", "origin", "https://github.com/team/repo.git"]);
    const project = store.putProject({ id: "project", name: "Repo", path: directory, category: "Group", defaults: {} });
    await putCategoryGitAccess(store, "Group", "github", "group-secret-canary");
    expect(listProjectGitAccess(store, project.id)[0].configured).toBe(false);
    const tokens: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      tokens.push((init?.headers as Record<string, string>).Authorization);
      return Response.json(String(url).includes("/branches?") ? [{ name: "main" }] : { workflow_runs: [] });
    }) as typeof fetch;
    await listBranchPipelines(store, project);
    expect(tokens).toEqual(["Bearer group-secret-canary", "Bearer group-secret-canary"]);
    tokens.length = 0;
    await putProjectGitAccess(store, project.id, "github", "project-secret-canary");
    await listBranchPipelines(store, project);
    expect(tokens).toEqual(["Bearer project-secret-canary", "Bearer project-secret-canary"]);
    expect(JSON.stringify(store.db.query("SELECT key,value FROM installation").all())).not.toContain("secret-canary");
    await deleteProjectGitAccess(store, project.id, "github");
    tokens.length = 0;
    await listBranchPipelines(store, project);
    expect(tokens).toEqual(["Bearer group-secret-canary", "Bearer group-secret-canary"]);
  } finally {
    store.close();
    if (oldHelper) process.env.ACT_DOCK_HELPER_PATH = oldHelper;
    else delete process.env.ACT_DOCK_HELPER_PATH;
    await rm(directory, { recursive: true, force: true });
  }
});

test("pipeline states map to deploying, success and failed", async () => {
  expect(pipelineState("running")).toBe("running");
  expect(pipelineState("in_progress")).toBe("running");
  expect(pipelineState("completed", "success")).toBe("success");
  expect(pipelineState("completed", "failure")).toBe("failed");
  expect(pipelineState("failed")).toBe("failed");
  expect(pipelineState("canceled")).toBe("other");
  globalThis.fetch = (async (url: string | URL | Request) => {
    expect(String(url)).toBe("https://gitlab.matrix.et/api/v4/projects/g%2Fr/pipelines?per_page=15");
    return Response.json([{ id: 7, ref: "dev", status: "running", web_url: "https://gitlab.matrix.et/g/r/-/pipelines/7", updated_at: "2026-11-14T10:00:00Z" }]);
  }) as typeof fetch;
  const result = await fetchLatestPipelines(parseRemote("git@git.matrix.et:g/r.git", ["git.matrix.et=gitlab.matrix.et"]), "t");
  expect(result.pipelines[0]).toMatchObject({ id: 7, branch: "dev", state: "running" });
});

test("isValidBranchName validates according to git conventions", () => {
  expect(isValidBranchName("main")).toBe(true);
  expect(isValidBranchName("feature/my-branch-1")).toBe(true);
  expect(isValidBranchName("bugfix/issue-123")).toBe(true);
  expect(isValidBranchName("")).toBe(false);
  expect(isValidBranchName("   ")).toBe(false);
  expect(isValidBranchName("feature/name with space")).toBe(false);
  expect(isValidBranchName("/leading-slash")).toBe(false);
  expect(isValidBranchName("trailing-slash/")).toBe(false);
  expect(isValidBranchName("branch..double-dot")).toBe(false);
  expect(isValidBranchName("branch~1")).toBe(false);
  expect(isValidBranchName("branch^1")).toBe(false);
  expect(isValidBranchName("branch:colon")).toBe(false);
  expect(isValidBranchName("branch.lock")).toBe(false);
});

test("GitHub and GitLab executeDeleteBranch sends correct request", async () => {
  const ghRequests: { url: string; method?: string; headers?: any }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    ghRequests.push({ url: String(url), method: init?.method, headers: init?.headers });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const ghRemote = parseRemote("https://github.com/team/repo.git");
  await executeDeleteBranch(ghRemote, "gh-token", "feature/awesome");
  expect(ghRequests).toHaveLength(1);
  expect(ghRequests[0].url).toBe("https://api.github.com/repos/team/repo/git/refs/heads/feature/awesome");
  expect(ghRequests[0].method).toBe("DELETE");
  expect(ghRequests[0].headers.Authorization).toBe("Bearer gh-token");

  const glRequests: { url: string; method?: string; headers?: any }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    glRequests.push({ url: String(url), method: init?.method, headers: init?.headers });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const glRemote = parseRemote("git@gitlab.com:group/subgroup/repo.git");
  await executeDeleteBranch(glRemote, "gl-token", "feature/awesome");
  expect(glRequests).toHaveLength(1);
  expect(glRequests[0].url).toBe("https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Frepo/repository/branches/feature%2Fawesome");
  expect(glRequests[0].method).toBe("DELETE");
  expect(glRequests[0].headers["PRIVATE-TOKEN"]).toBe("gl-token");
});

test("GitHub and GitLab executeRenameBranch sends correct request", async () => {
  const ghRequests: { url: string; method?: string; body?: any; headers?: any }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    ghRequests.push({ url: String(url), method: init?.method, body: init?.body, headers: init?.headers });
    return Response.json({ name: "feature/new" });
  }) as typeof fetch;

  const ghRemote = parseRemote("https://github.com/team/repo.git");
  await executeRenameBranch(ghRemote, "gh-token", "feature/old", "feature/new");
  expect(ghRequests).toHaveLength(1);
  expect(ghRequests[0].url).toBe("https://api.github.com/repos/team/repo/branches/feature%2Fold/rename");
  expect(ghRequests[0].method).toBe("POST");
  expect(JSON.parse(ghRequests[0].body)).toEqual({ new_name: "feature/new" });

  const glRequests: { url: string; method?: string; headers?: any }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    glRequests.push({ url: String(url), method: init?.method, headers: init?.headers });
    return init?.method === "POST" ? Response.json({ name: "feature/new" }) : new Response(null, { status: 204 });
  }) as typeof fetch;

  const glRemote = parseRemote("git@gitlab.com:group/repo.git");
  await executeRenameBranch(glRemote, "gl-token", "feature/old", "feature/new");
  expect(glRequests).toHaveLength(2);
  expect(glRequests[0].url).toBe("https://gitlab.com/api/v4/projects/group%2Frepo/repository/branches?branch=feature%2Fnew&ref=feature%2Fold");
  expect(glRequests[0].method).toBe("POST");
  expect(glRequests[1].url).toBe("https://gitlab.com/api/v4/projects/group%2Frepo/repository/branches/feature%2Fold");
  expect(glRequests[1].method).toBe("DELETE");
});
