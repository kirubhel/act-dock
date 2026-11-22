import { existsSync, readdirSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { AiModel, AiUsage } from "../shared/contracts";

/**
 * Works out which apps use each local model. This is evidence, not proof: a model is "used by" an app when
 * the app's files, data, logs or a project's source name it, or when a process has it open right now.
 * Apps that download or locate models in ways that never write the model's name anywhere readable cannot be found.
 */

export type UsageJob = {
  kind: Exclude<AiUsage["kind"], "running">;
  paths: string[];
  include: string[];
  excludeDirs: string[];
  excludeFiles: string[];
};
export type UsageOptions = {
  home: string;
  jobs?: UsageJob[];
  /** Ask running processes and the Ollama server. Off in tests. */
  live?: boolean;
  /** Wall-clock limit for each search. */
  jobMs?: number;
};

const CODE = ["py", "ts", "tsx", "js", "jsx", "mjs", "swift", "rs", "go", "kt", "java", "json", "yaml", "yml", "toml", "env"];
const NOISE_DIRS = [
  "node_modules", ".git", ".venv", "venv", "site-packages", "dist", "build", "target", ".next", "__pycache__", "Pods", "DerivedData",
  ".uv-cache", ".cache", ".pnpm-store", ".npm", ".cargo", ".rustup", ".gradle", ".m2", ".pub-cache", "vendor", "bower_components", ".tox", "coverage", ".turbo",
];
const NOT_USAGE_FILES = ["*.test.*", "*.spec.*", "*.d.ts", "*.min.map", "*prices*", "*pricing*", "*history*", "*chat*", "*session*", "*transcript*", "*conversation*", "package-lock.json", "*.lock"];
// Apps whose files mostly hold conversations, browser data or catalogs of model names, so a mention there is not use.
const NOT_APP_DATA = [
  "Caches", "Cache", "Code Cache", "GPUCache", "IndexedDB", "Local Storage", "Service Worker", "blob_storage", "Session Storage",
  "Claude", "Code", "Cursor", "Antigravity", "Antigravity IDE", "Codex", "Kiro", "Kimi", "Poe", "MiniMax Agent", "Act Dock",
  "Google", "Firefox", "Mozilla", "Chromium", "Arc", "Microsoft", "Slack", "Discord", "JetBrains", "Notion", "CrashReporter",
];

export async function defaultUsageJobs(home: string): Promise<UsageJob[]> {
  const present = async (paths: string[]) => (await Promise.all(paths.map(async (p) => ((await stat(p).catch(() => null))?.isDirectory() ? p : null)))).filter((p): p is string => !!p);
  const appResources = async (dir: string) => {
    const names = await readdir(dir).catch(() => [] as string[]);
    return present(names.filter((n) => n.endsWith(".app")).map((n) => join(dir, n, "Contents/Resources")));
  };
  const apps = [...(await appResources("/Applications")), ...(await appResources(join(home, "Applications")))];
  const jobs: UsageJob[] = [];
  if (apps.length) jobs.push({ kind: "app", paths: apps, include: ["py", "js", "mjs", "cjs", "ts", "json", "yaml", "yml", "toml", "cfg", "ini", "txt", "html"], excludeDirs: [...NOISE_DIRS, "*.lproj", "locales", "Frameworks"], excludeFiles: ["*.d.ts", "*.map", "*prices*", "*pricing*"] });
  const data = await present([join(home, "Library/Application Support"), join(home, "Library/Logs")]);
  if (data.length) jobs.push({ kind: "app-data", paths: data, include: ["json", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "log", "txt"], excludeDirs: [...NOISE_DIRS, ...NOT_APP_DATA], excludeFiles: NOT_USAGE_FILES });
  const config = await present([join(home, ".config"), join(home, ".continue")]);
  if (config.length) jobs.push({ kind: "config", paths: config, include: ["json", "yaml", "yml", "toml", "env", "cfg", "ini", "conf"], excludeDirs: [...NOISE_DIRS, "types", "opencode"], excludeFiles: NOT_USAGE_FILES });
  const projects = await present([join(home, "Developer"), join(home, "Projects")]);
  if (projects.length) jobs.push({ kind: "project", paths: projects, include: CODE, excludeDirs: [...NOISE_DIRS, "tests", "test", "__tests__", "fixtures", "graphify-out", ".claude", ".agents"], excludeFiles: NOT_USAGE_FILES });
  return jobs;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A name only counts when it stands alone: a base name must not match its point releases or its suffixed variants.
const standalone = (body: string) => new RegExp(`(?<![A-Za-z0-9._])(?:${body})(?![A-Za-z0-9._-])`, "i");

/** How each model is likely to be written in a config, a script or a log. `loose` is what grep looks for first. */
export function modelNeedles(model: AiModel): { label: string; loose: string[]; strict: RegExp } {
  if (model.source === "ollama") {
    const [name, tag = "latest"] = model.name.split(":");
    const full = escapeRegex(`${name}:${tag}`);
    // The bare name stands for the default tag only.
    const bare = tag === "latest" ? `|${escapeRegex(name)}(?![:])` : "";
    return { label: model.name, loose: [name], strict: new RegExp(`(?<![A-Za-z0-9._])(?:${full}${bare})(?![A-Za-z0-9._-])`, "i") };
  }
  if (model.source === "huggingface") {
    const repo = model.name.split("/").pop() ?? model.name;
    // A one-word repo name ("OmniVoice") is too common on its own, so it only counts with its owner.
    const distinctive = repo.length >= 10 && /[-\d]/.test(repo);
    const forms = distinctive ? [escapeRegex(model.name), escapeRegex(repo)] : [escapeRegex(model.name), escapeRegex(model.name.replace("/", "--"))];
    return { label: model.name, loose: [distinctive ? repo : model.name.split("/").pop() ?? model.name], strict: standalone(forms.join("|")) };
  }
  const file = basename(model.path);
  return { label: file, loose: [file], strict: standalone(escapeRegex(file)) };
}

type Hit = { path: string; line: string; count: number };

async function searchJob(job: UsageJob, loose: string[], ms: number): Promise<{ files: string[]; partial: boolean }> {
  const args = ["-rIl", "-F", "--line-buffered", ...loose.flatMap((l) => ["-e", l])];
  for (const ext of job.include) args.push(`--include=*.${ext}`);
  for (const dir of job.excludeDirs) args.push(`--exclude-dir=${dir}`);
  for (const file of job.excludeFiles) args.push(`--exclude=${file}`);
  args.push("--", ...job.paths);
  try {
    const child = Bun.spawn([existsSync("/usr/bin/grep") ? "/usr/bin/grep" : "grep", ...args], { stdout: "pipe", stderr: "ignore", timeout: ms, killSignal: "SIGKILL" });
    const out = await new Response(child.stdout).text();
    await child.exited;
    return { files: out.split("\n").filter(Boolean).slice(0, 1500), partial: child.signalCode !== null };
  } catch { return { files: [], partial: false }; }
}

function attribute(job: UsageJob, file: string): string {
  if (job.kind === "app") {
    const app = file.split(sep).find((s) => s.endsWith(".app"));
    return app ? app.slice(0, -4) : basename(file);
  }
  const root = job.paths.find((p) => file.startsWith(p + sep));
  if (!root) return basename(file);
  const rel = relative(root, file).split(sep);
  if (job.kind === "project") {
    // The project is the nearest folder above the file that is a repository, then the nearest with a project file.
    // A folder that only groups projects (Developer/Work) is never the answer when something closer exists.
    const dirs = rel.slice(0, -1).map((_, i) => join(root, ...rel.slice(0, i + 1))).reverse();
    const marked = (d: string, names: string[]) => names.some((n) => existsSync(join(d, n)));
    const repo = dirs.find((d) => marked(d, [".git"]));
    const project = repo ?? dirs.find((d) => marked(d, ["package.json", "pyproject.toml", "Package.swift", "Cargo.toml", "go.mod", "requirements.txt"]) || readdirSafe(d).some((n) => n.endsWith(".xcodeproj")));
    return basename(project ?? join(root, rel[0]));
  }
  const containers = ["Application Support", "Logs", ".config"];
  return containers.includes(basename(root)) ? rel[0] : basename(root).replace(/^\./, "");
}

/** Reads a file once and reports which models it names, with the first line that does. */
async function matchFile(file: string, needles: Map<string, { strict: RegExp }>): Promise<[string, Hit][]> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) return [];
    const text = await readFile(file, "utf8");
    const out: [string, Hit][] = [];
    for (const [id, { strict }] of needles) {
      const global = new RegExp(strict.source, "gi");
      const first = global.exec(text);
      if (!first) continue;
      let count = 1;
      while (global.exec(text) && count < 500) count++;
      const start = text.lastIndexOf("\n", first.index) + 1, endAt = text.indexOf("\n", first.index);
      const line = text.slice(start, endAt === -1 ? undefined : endAt).trim();
      out.push([id, { path: file, line: line.length > 160 ? line.slice(Math.max(0, first.index - start - 60), first.index - start + 100).trim() : line, count }]);
    }
    return out;
  } catch { return []; }
}

const readdirSafe = (d: string) => { try { return readdirSync(d); } catch { return [] as string[]; } };

const ORDER: AiUsage["kind"][] = ["running", "app", "app-data", "config", "project"];

/** Returns usage per model id, plus notes about anything that could not be searched fully. */
export async function findModelUsage(models: AiModel[], options: UsageOptions): Promise<{ usage: Map<string, AiUsage[]>; notes: string[] }> {
  const usage = new Map<string, AiUsage[]>(), notes: string[] = [];
  if (!models.length) return { usage, notes };
  const needles = new Map(models.map((m) => [m.id, modelNeedles(m)]));
  const add = (id: string, entry: Omit<AiUsage, "matches"> & { matches?: number }) => {
    const list = usage.get(id) ?? [];
    const existing = list.find((u) => u.kind === entry.kind && u.app === entry.app);
    if (existing) existing.matches += entry.matches ?? 1;
    else list.push({ ...entry, matches: entry.matches ?? 1 });
    usage.set(id, list);
  };

  const jobs = options.jobs ?? await defaultUsageJobs(options.home);
  // The first pass is case-sensitive because that is several times faster; each variant is searched as written and in lower case.
  const loose = [...new Set([...needles.values()].flatMap((n) => n.loose).flatMap((l) => [l, l.toLowerCase()]))];
  const ms = options.jobMs ?? 40_000;
  const searched = await Promise.all(jobs.map(async (job) => {
    if (job.kind !== "app") return { job, ...(await searchJob(job, loose, ms)) };
    // Each app is searched on its own, a few at a time, so one huge app cannot use up the time of all the others.
    const results: { files: string[]; partial: boolean }[] = [];
    const queue = [...job.paths];
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let path = queue.shift(); path; path = queue.shift()) results.push(await searchJob({ ...job, paths: [path] }, loose, Math.min(ms, 8000)));
    }));
    return { job, files: results.flatMap((r) => r.files), partial: results.some((r) => r.partial) };
  }));
  for (const { job, files, partial } of searched) {
    if (partial) notes.push(`Looking for apps that use models took too long in ${job.kind === "app" ? "installed apps" : job.kind === "app-data" ? "app data" : job.kind === "config" ? "config folders" : "your projects"}, so some may be missing.`);
    const hits = await Promise.all(files.map((file) => matchFile(file, needles)));
    for (const matches of hits) for (const [id, hit] of matches) {
      const where = relative(job.paths.find((p) => hit.path.startsWith(p + sep)) ?? "", hit.path) || hit.path;
      add(id, { app: attribute(job, hit.path), kind: job.kind, path: hit.path, evidence: `Names "${needles.get(id)!.label}" in ${where}`, snippet: hit.line, matches: hit.count });
    }
  }

  if (options.live !== false) await addRunning(models, needles, add);
  for (const [id, list] of usage) usage.set(id, list.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.matches - a.matches).slice(0, 8));
  return { usage, notes };
}

async function run(cmd: string[], ms: number): Promise<string> {
  try {
    const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", timeout: ms, killSignal: "SIGKILL" });
    const out = await new Response(child.stdout).text();
    await child.exited;
    return out;
  } catch { return ""; }
}

/** Processes that have the model open or name it on their command line, and models the Ollama server holds in memory. */
async function addRunning(
  models: AiModel[], needles: Map<string, { strict: RegExp }>,
  add: (id: string, entry: Omit<AiUsage, "matches">) => void,
) {
  const [ps, lsof, ollama] = await Promise.all([
    run(["ps", "-axo", "command="], 5000),
    run(["lsof", "-nP", "-Fcn"], 8000),
    fetch("http://127.0.0.1:11434/api/ps", { signal: AbortSignal.timeout(800) }).then((r) => r.json() as Promise<{ models?: { name?: string; model?: string }[] }>).catch(() => ({ models: [] })),
  ]);
  const loaded = new Set((ollama.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => !!n));
  for (const model of models) {
    if (model.source === "ollama" && (loaded.has(model.name) || (model.name.endsWith(":latest") && loaded.has(model.name.slice(0, -7)))))
      add(model.id, { app: "Ollama", kind: "running", path: model.path, evidence: "Loaded in memory by the Ollama server right now." });
  }
  for (const line of ps.split("\n")) {
    if (!line.trim() || /\b(ps -axo|lsof -nP)\b/.test(line)) continue;
    for (const model of models) {
      if (model.source === "ollama" && /\bollama\b/.test(line) === false) continue;
      if (needles.get(model.id)!.strict.test(line)) add(model.id, { app: basename(line.trim().split(/\s+/)[0]), kind: "running", path: model.path, evidence: `A running process names it: ${line.trim().slice(0, 140)}` });
    }
  }
  let command = "";
  const open = new Map<string, Set<string>>();
  for (const line of lsof.split("\n")) {
    if (line[0] === "c") command = line.slice(1);
    else if (line[0] === "n") {
      for (const model of models) {
        if (line.slice(1).startsWith(model.path) || (model.source === "huggingface" && line.includes(`/${basename(model.path)}/`))) {
          const set = open.get(model.id) ?? new Set<string>(); set.add(command); open.set(model.id, set);
        }
      }
    }
  }
  for (const [id, commands] of open) for (const command of commands)
    add(id, { app: command, kind: "running", path: models.find((m) => m.id === id)!.path, evidence: `${command} has the model's files open right now.` });
}
