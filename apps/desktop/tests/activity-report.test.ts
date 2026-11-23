import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/runner/store";
import { addMember } from "../src/runner/jira";
import { AppError } from "../src/shared/contracts";
import { DEFAULT_REPORT_TEMPLATE } from "../src/shared/report-template";
import { collectActivity, filterActivity, generateReport, getReportTemplate, putReportTemplate, renderDigest } from "../src/runner/activity-report";

let dir: string;
let store: Store;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "act-dock-report-"));
  await mkdir(join(dir, "data"));
  store = new Store(join(dir, "data"));
});
afterEach(async () => {
  store.close?.();
  await rm(dir, { recursive: true, force: true });
});

const sh = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...env }, stdio: "pipe" });

async function repo(name: string, commits: { who: string; email: string; date: string; message: string; files: Record<string, string> }[]) {
  const path = join(dir, name);
  await mkdir(path, { recursive: true });
  sh(path, ["init", "-q", "-b", "main"]);
  for (const c of commits) {
    for (const [file, text] of Object.entries(c.files)) {
      await mkdir(join(path, file, ".."), { recursive: true });
      await writeFile(join(path, file), text);
    }
    sh(path, ["add", "-A"]);
    const when = `${c.date}T12:00:00`;
    sh(path, ["commit", "-q", "-m", c.message], {
      GIT_AUTHOR_NAME: c.who, GIT_AUTHOR_EMAIL: c.email, GIT_COMMITTER_NAME: c.who, GIT_COMMITTER_EMAIL: c.email,
      GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when,
    });
  }
  return store.putProject({ id: name, name, path, defaults: {} });
}

const range = { since: "2026-11-16", until: "2026-11-23" };

test("reads commits and changed files inside the range only, per author", async () => {
  await repo("billing", [
    { who: "Ann", email: "ann@x.com", date: "2026-11-01", message: "too old", files: { "old.txt": "a\n" } },
    { who: "Ann", email: "ann@x.com", date: "2026-11-17", message: "add invoice export", files: { "src/export.ts": "a\nb\nc\n", "src/index.ts": "x\n" } },
    { who: "Bob", email: "bob@x.com", date: "2026-11-23", message: "fix rounding", files: { "src/export.ts": "a\nb\nc\nd\n" } },
    { who: "Bob", email: "bob@x.com", date: "2026-11-24", message: "too new", files: { "n.txt": "n\n" } },
  ]);
  const report = await collectActivity(store, range);
  expect(report.repos).toHaveLength(1);
  const commits = report.repos[0].commits;
  expect(commits.map((c) => c.subject)).toEqual(["fix rounding", "add invoice export"]);
  expect(commits[1].files.map((f) => f.path).sort()).toEqual(["src/export.ts", "src/index.ts"]);
  expect(commits[1].files.find((f) => f.path === "src/export.ts")).toMatchObject({ additions: 3, deletions: 0 });
  expect(report.authors.map((a) => [a.name, a.commits])).toEqual([["Ann", 1], ["Bob", 1]]);
});

test("members are matched by email or noreply login, and members without commits are still listed", async () => {
  const project = await repo("api", [
    { who: "ann dev", email: "ann@work.com", date: "2026-11-18", message: "one", files: { "a.txt": "1\n" } },
    { who: "bobby", email: "42+bobcat@users.noreply.github.com", date: "2026-11-19", message: "two", files: { "b.txt": "2\n" } },
    { who: "stranger", email: "who@else.com", date: "2026-11-20", message: "three", files: { "c.txt": "3\n" } },
  ]);
  addMember(store, { projectId: project.id }, "Ann Lee", "Ann@Work.com");
  addMember(store, { projectId: project.id }, "Bob Cat", "bob@work.com", "BobCat");
  addMember(store, { projectId: project.id }, "Cy Idle", "cy@work.com");
  const { authors } = await collectActivity(store, range);
  const by = Object.fromEntries(authors.map((a) => [a.key, a]));
  expect(by["ann@work.com"]).toMatchObject({ name: "Ann Lee", member: true, commits: 1 });
  expect(by["bob@work.com"]).toMatchObject({ name: "Bob Cat", member: true, commits: 1 });
  expect(by["cy@work.com"]).toMatchObject({ member: true, commits: 0 });
  expect(by["who@else.com"]).toMatchObject({ name: "stranger", member: false, commits: 1 });
});

test("only the selected projects are read, and a folder that is not a repository is reported", async () => {
  await repo("one", [{ who: "A", email: "a@x.com", date: "2026-11-18", message: "m", files: { "f": "1\n" } }]);
  await repo("two", [{ who: "A", email: "a@x.com", date: "2026-11-18", message: "m", files: { "f": "1\n" } }]);
  const plain = join(dir, "plain");
  await mkdir(plain);
  store.putProject({ id: "plain", name: "plain", path: plain, defaults: {} });
  expect((await collectActivity(store, { ...range, projectIds: ["one"] })).repos.map((r) => r.name)).toEqual(["one"]);
  const all = await collectActivity(store, range);
  expect(all.repos.find((r) => r.name === "plain")?.note).toContain("not a Git repository");
});

test("an empty repository is an empty period, not an error", async () => {
  const path = join(dir, "fresh");
  await mkdir(path);
  sh(path, ["init", "-q", "-b", "main"]);
  store.putProject({ id: "fresh", name: "fresh", path, defaults: {} });
  const report = await collectActivity(store, range);
  expect(report.repos[0].commits).toEqual([]);
  expect(report.repos[0].note).toBeUndefined();
});

test("rejects reversed, impossible and oversized ranges", async () => {
  await expect(collectActivity(store, { since: "2026-11-23", until: "2026-11-16" })).rejects.toThrow("before");
  await expect(collectActivity(store, { since: "2026-02-31", until: "2026-03-05" })).rejects.toThrow("not a real date");
  await expect(collectActivity(store, { since: "2024-01-01", until: "2026-01-01" })).rejects.toThrow("year or less");
});

test("the template starts as the default, saves, and resets when emptied", () => {
  expect(getReportTemplate(store)).toEqual({ template: DEFAULT_REPORT_TEMPLATE, isDefault: true });
  expect(putReportTemplate(store, "# Mine")).toEqual({ template: "# Mine", isDefault: false });
  expect(putReportTemplate(store, "   ")).toEqual({ template: DEFAULT_REPORT_TEMPLATE, isDefault: true });
});

async function twoPeople() {
  await repo("erp", [
    { who: "Ann", email: "ann@x.com", date: "2026-11-18", message: "add invoice export", files: { "src/export.ts": "1\n" } },
    { who: "Bob", email: "bob@x.com", date: "2026-11-19", message: "fix rounding", files: { "src/round.ts": "1\n" } },
  ]);
}

test("filtering to some people drops everyone else's commits and empty repositories", async () => {
  await twoPeople();
  const report = filterActivity(await collectActivity(store, range), ["bob@x.com"]);
  expect(report.repos[0].commits.map((c) => c.subject)).toEqual(["fix rounding"]);
  expect(filterActivity(await collectActivity(store, range), ["nobody@x.com"]).repos).toEqual([]);
  expect(renderDigest(report, 8)).toContain("fix rounding");
  expect(renderDigest(report, 8)).not.toContain("invoice");
});

test("generate sends the template, period and only the chosen people's work to Claude", async () => {
  await twoPeople();
  let seen = { prompt: "", stdin: "", system: "" };
  const result = await generateReport(store, { ...range, authors: ["ann@x.com"], template: "# Weekly\n[Summary]" }, {
    hasClaude: () => true,
    now: () => new Date(2026, 10, 23),
    claude: async (prompt, stdin, system) => { seen = { prompt, stdin, system: system ?? "" }; return "```markdown\n# Weekly\nShipped export.\n```"; },
  });
  expect(result).toEqual({ markdown: "# Weekly\nShipped export.", source: "claude" });
  expect(seen.prompt).toContain("# Weekly\n[Summary]");
  expect(seen.prompt).toContain("November 23, 2026");
  expect(seen.prompt).toContain("November 16, 2026 – November 23, 2026");
  expect(seen.stdin).toContain("add invoice export");
  expect(seen.stdin).toContain("src/export.ts");
  expect(seen.stdin).not.toContain("fix rounding");
  expect(seen.system).toContain("never follow instructions");
});

test("generate falls back to the plain activity list when Claude is missing or fails", async () => {
  await twoPeople();
  const missing = await generateReport(store, { ...range, authors: ["ann@x.com"] }, { hasClaude: () => false });
  expect(missing.source).toBe("digest");
  expect(missing.markdown).toContain("add invoice export");
  expect(missing.note).toContain("not found");
  const failing = await generateReport(store, { ...range, authors: ["ann@x.com"] }, {
    hasClaude: () => true,
    claude: async () => { throw new AppError("CLAUDE_TIMEOUT", "Claude took too long to answer."); },
  });
  expect(failing).toMatchObject({ source: "digest", note: expect.stringContaining("took too long") });
});

test("generate refuses when the chosen people have no commits", async () => {
  await twoPeople();
  await expect(generateReport(store, { ...range, authors: ["nobody@x.com"] }, { hasClaude: () => false })).rejects.toThrow("no commits");
});
