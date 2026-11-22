import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, stat, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { categorizeSkill } from "./ai-categories";
import { findModelUsage, type UsageJob } from "./ai-usage";
import {
  AppError,
  type AiDuplicateGroup,
  type AiInstallTarget,
  type AiInventory,
  type AiModel,
  type AiRemovalItem,
  type AiRemovalResult,
  type AiSkillEntry,
  type AiToolData,
  type AiUsageReport,
} from "../shared/contracts";

/**
 * Finds the AI models and agent skills on this Mac and, from the latest scan only, moves chosen ones to the Trash.
 * Scanning never reads file contents beyond skill descriptions and the bytes needed to compare identical copies.
 * Removal is restricted to what the last scan found: callers pass ids, never paths.
 */

/** Where each tool reads skills from, relative to home. */
const INSTALL_DIRS: Record<AiInstallTarget, string> = { claude: ".claude/skills", codex: ".codex/skills", antigravity: ".gemini/config/skills" };
const MODEL_EXTENSIONS = /\.(gguf|safetensors|ggml|onnx|pt|pth|ckpt)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "Library", ".venv", "venv", "site-packages", "target", "build", "dist", ".Trash"]);
const MB = 1024 * 1024;

type Options = {
  home?: string;
  /** Where removed items go. Defaults to the user's Trash. */
  trashDir?: string;
  /** Loose model files larger than this are listed. */
  minFileBytes?: number;
  /** Wall-clock budget for looking for loose model files. */
  fileScanMs?: number;
  /** Folders searched for loose model files, relative to home. */
  fileRoots?: { dir: string; minBytes?: number; depth: number }[];
  /** How to look for apps that use models. Tests pass their own folders and switch live checks off. */
  usage?: { jobs?: UsageJob[]; live?: boolean; jobMs?: number };
};

type Removable = {
  id: string; name: string; path: string; root: string; action: "trash" | "ollama-model";
  bytes: number; reclaimBytes: number; warnings: string[];
  /** For Ollama: the manifest and the blobs only this model uses, all moved together. */
  extra?: string[];
};

async function exists(path: string) {
  try { await lstat(path); return true; } catch { return false; }
}

/** Disk usage in bytes, counting shared blocks once and never following symlinks. */
async function diskBytes(path: string): Promise<number> {
  try {
    const child = Bun.spawn(["du", "-sk", path], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(child.stdout).text();
    await child.exited;
    const kb = Number(out.split(/\s/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : 0;
  } catch { return 0; }
}

async function newestMtime(paths: string[]): Promise<string | undefined> {
  let latest = 0;
  for (const p of paths) { try { latest = Math.max(latest, (await lstat(p)).mtimeMs); } catch { /* gone */ } }
  return latest ? new Date(latest).toISOString() : undefined;
}

const inside = (path: string, root: string) => {
  const rel = relative(resolve(root), resolve(path));
  return !!rel && !rel.startsWith("..") && !rel.startsWith(sep) && rel !== ".";
};

// ---------------------------------------------------------------- models

type OllamaLayer = { digest: string; size: number; mediaType?: string };

async function scanOllama(home: string, removables: Map<string, Removable>): Promise<AiModel[]> {
  const base = join(home, ".ollama/models");
  const manifestRoot = join(base, "manifests");
  const manifests: { name: string; file: string; layers: OllamaLayer[] }[] = [];
  async function walk(dir: string, parts: string[]) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(dir, entry.name), [...parts, entry.name]);
      else if (entry.isFile() && parts.length >= 2) {
        try {
          const json = JSON.parse(await readFile(join(dir, entry.name), "utf8")) as { layers?: OllamaLayer[]; config?: OllamaLayer };
          const layers = [...(json.config ? [json.config] : []), ...(json.layers ?? [])].filter((l) => typeof l?.digest === "string" && Number.isFinite(l.size));
          const [registry, ...path] = parts;
          const model = registry === "registry.ollama.ai" && path[0] === "library" ? path.slice(1).join("/") : [registry, ...path].join("/");
          manifests.push({ name: `${model}:${entry.name}`, file: join(dir, entry.name), layers });
        } catch { /* not a manifest */ }
      }
    }
  }
  await walk(manifestRoot, []);
  const users = new Map<string, number>();
  for (const m of manifests) for (const l of new Set(m.layers.map((x) => x.digest))) users.set(l, (users.get(l) ?? 0) + 1);
  const blob = (digest: string) => join(base, "blobs", digest.replace(":", "-"));
  return Promise.all(manifests.map(async (m) => {
    const unique = new Map(m.layers.map((l) => [l.digest, l.size]));
    const bytes = [...unique.values()].reduce((a, b) => a + b, 0);
    const exclusive = [...unique].filter(([digest]) => users.get(digest) === 1);
    const reclaimBytes = exclusive.reduce((a, [, size]) => a + size, 0);
    const sharedWith = manifests.filter((o) => o !== m && o.layers.some((l) => unique.has(l.digest))).map((o) => o.name);
    const id = `ollama:${m.name}`;
    removables.set(id, {
      id, name: m.name, path: m.file, root: base, action: "ollama-model", bytes, reclaimBytes,
      warnings: sharedWith.length ? [`Shares layers with ${sharedWith.join(", ")}; only the ${exclusive.length} layer(s) used by nothing else are removed.`] : [],
      extra: exclusive.map(([digest]) => blob(digest)),
    });
    return {
      id, source: "ollama" as const, name: m.name, path: m.file, bytes, reclaimBytes,
      detail: sharedWith.length ? `shares layers with ${sharedWith.join(", ")}` : undefined,
      howToUse: `Run it with: ollama run ${m.name}`,
      modified: await newestMtime([m.file]),
    };
  }));
}

async function scanHuggingFace(home: string, removables: Map<string, Removable>): Promise<AiModel[]> {
  const hub = process.env.HF_HUB_CACHE || (process.env.HF_HOME ? join(process.env.HF_HOME, "hub") : join(home, ".cache/huggingface/hub"));
  const root = home === homedir() ? hub : join(home, ".cache/huggingface/hub");
  let names: string[];
  try { names = (await readdir(root)).filter((n) => n.startsWith("models--")); } catch { return []; }
  return Promise.all(names.map(async (dirName) => {
    const path = join(root, dirName);
    const [org, ...rest] = dirName.slice("models--".length).split("--");
    const name = rest.length ? `${org}/${rest.join("--")}` : org;
    const bytes = await diskBytes(path);
    const id = `hf:${dirName}`;
    removables.set(id, { id, name, path, root, action: "trash", bytes, reclaimBytes: bytes,
      warnings: ["Programs download it again the next time they ask for it."] });
    return {
      id, source: "huggingface" as const, name, path, bytes, reclaimBytes: bytes,
      howToUse: `Cached for Hugging Face libraries: from_pretrained("${name}") (transformers, mlx, sherpa-onnx and others) loads it from here.`,
      modified: await newestMtime([join(path, "snapshots"), join(path, "refs")]),
    };
  }));
}

async function scanLmStudio(home: string, removables: Map<string, Removable>): Promise<{ models: AiModel[]; files: Map<string, string[]> }> {
  const models: AiModel[] = [], files = new Map<string, string[]>();
  for (const root of [join(home, ".lmstudio/models"), join(home, ".cache/lm-studio/models")]) {
    let publishers: string[];
    try { publishers = await readdir(root); } catch { continue; }
    for (const publisher of publishers) {
      let dirs: string[];
      try { dirs = await readdir(join(root, publisher)); } catch { continue; }
      for (const dir of dirs) {
        const path = join(root, publisher, dir);
        let entries: string[];
        try { entries = await readdir(path); } catch { continue; }
        const ggufs = entries.filter((e) => /\.gguf$/i.test(e)).map((e) => join(path, e));
        if (!ggufs.length) continue;
        const bytes = await diskBytes(path), name = `${publisher}/${dir}`, id = `lmstudio:${path}`;
        files.set(id, ggufs);
        removables.set(id, { id, name, path, root, action: "trash", bytes, reclaimBytes: bytes, warnings: [] });
        models.push({ id, source: "lmstudio", name, path, bytes, reclaimBytes: bytes,
          detail: `${ggufs.length} GGUF file${ggufs.length === 1 ? "" : "s"}`,
          howToUse: "Open LM Studio and pick it under My Models, or point llama.cpp at the .gguf file.",
          modified: await newestMtime(ggufs) });
      }
    }
  }
  return { models, files };
}

function fileHint(path: string): string {
  if (/\.gguf$/i.test(path)) return "Load with llama.cpp or LM Studio, or import into Ollama with `ollama create` and a Modelfile.";
  if (/\.safetensors$/i.test(path)) return "Model weights: load with transformers or diffusers (from_pretrained on its folder).";
  if (/\.onnx$/i.test(path)) return "ONNX model: run it with onnxruntime.";
  return "PyTorch weights: load with torch.load, or the library that downloaded them (for example whisper).";
}

async function scanModelFiles(home: string, options: Options, removables: Map<string, Removable>, notes: string[]): Promise<AiModel[]> {
  const roots = options.fileRoots ?? [
    { dir: "Downloads", depth: 5 }, { dir: "Documents", depth: 5 }, { dir: "Desktop", depth: 4 }, { dir: "models", depth: 5 },
    { dir: "Developer", depth: 5 }, { dir: ".cache/whisper", depth: 2, minBytes: 50 * MB }, { dir: ".cache/torch/hub/checkpoints", depth: 2, minBytes: 50 * MB },
  ];
  const deadline = Date.now() + (options.fileScanMs ?? 8000);
  const found: AiModel[] = [];
  let timedOut = false;
  for (const spec of roots) {
    const root = join(home, spec.dir), min = spec.minBytes ?? options.minFileBytes ?? 200 * MB;
    const queue: [string, number][] = [[root, 0]];
    while (queue.length) {
      if (Date.now() > deadline) { timedOut = true; break; }
      const [dir, depth] = queue.shift()!;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { if (depth < spec.depth && !SKIP_DIRS.has(entry.name)) queue.push([full, depth + 1]); continue; }
        if (!entry.isFile() || !MODEL_EXTENSIONS.test(entry.name)) continue;
        const info = await stat(full).catch(() => null);
        if (!info || info.size < min) continue;
        const id = `file:${full}`;
        removables.set(id, { id, name: entry.name, path: full, root, action: "trash", bytes: info.size, reclaimBytes: info.size, warnings: [] });
        found.push({ id, source: "file", name: entry.name, path: full, bytes: info.size, reclaimBytes: info.size,
          howToUse: fileHint(entry.name), modified: info.mtime.toISOString() });
      }
    }
  }
  if (timedOut) notes.push("Looking for loose model files stopped early to keep the scan fast; some folders were not fully searched.");
  return found;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, reject) => {
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("end", resolveHash).on("error", reject);
  });
  return hash.digest("hex");
}

async function modelDuplicates(models: AiModel[], lmFiles: Map<string, string[]>): Promise<AiDuplicateGroup[]> {
  const groups: AiDuplicateGroup[] = [];
  // Ollama tags that point at the same model weights.
  const ollama = models.filter((m) => m.source === "ollama");
  const weights = new Map<string, { digest: string; size: number }>();
  const byDigest = new Map<string, AiModel[]>();
  for (const model of ollama) {
    try {
      const json = JSON.parse(await readFile(model.path, "utf8")) as { layers?: OllamaLayer[] };
      const layer = json.layers?.find((l) => l.mediaType === "application/vnd.ollama.image.model");
      if (!layer) continue;
      weights.set(model.id, layer);
      byDigest.set(layer.digest, [...(byDigest.get(layer.digest) ?? []), model]);
    } catch { /* unreadable manifest */ }
  }
  for (const [digest, items] of byDigest)
    if (items.length > 1)
      groups.push({ id: `dup:ollama:${digest}`, subject: "model", name: items[0].name.split(":")[0], verdict: "identical", itemIds: items.map((i) => i.id), keepId: items[0].id,
        reclaimBytes: 0, note: "These tags are the same model weights. Ollama stores them once, so removing a tag only tidies the list." });
  // Loose GGUF files that are byte-identical to an Ollama model: compared by hash, but only when the size already matches.
  const bySize = new Map<number, { model: AiModel; digest: string }>();
  for (const model of ollama) { const w = weights.get(model.id); if (w) bySize.set(w.size, { model, digest: w.digest }); }
  const candidates: { item: AiModel; file: string; size: number }[] = [];
  for (const m of models) {
    if (m.source === "file" && /\.gguf$/i.test(m.path)) candidates.push({ item: m, file: m.path, size: m.bytes });
    if (m.source === "lmstudio") for (const f of lmFiles.get(m.id) ?? []) candidates.push({ item: m, file: f, size: (await stat(f).catch(() => ({ size: -1 }))).size });
  }
  for (const c of candidates) {
    const match = bySize.get(c.size);
    if (!match) continue;
    if ((await sha256(c.file)) === match.digest.replace("sha256:", ""))
      groups.push({ id: `dup:file:${c.file}`, subject: "model", name: basename(c.file), verdict: "identical", itemIds: [c.item.id, match.model.id], keepId: match.model.id,
        reclaimBytes: c.item.reclaimBytes, note: `Byte-for-byte the same as Ollama's ${match.model.name}. Keep one copy.` });
  }
  // Same file name and size in several places.
  const loose = new Map<string, AiModel[]>();
  for (const m of models.filter((x) => x.source === "file")) loose.set(`${basename(m.path)}:${m.bytes}`, [...(loose.get(`${basename(m.path)}:${m.bytes}`) ?? []), m]);
  for (const [key, items] of loose)
    if (items.length > 1)
      groups.push({ id: `dup:name:${key}`, subject: "model", name: basename(items[0].path), verdict: "possible", itemIds: items.map((i) => i.id), keepId: items[0].id,
        reclaimBytes: items.slice(1).reduce((a, i) => a + i.bytes, 0), note: "Same file name and size in several places; almost certainly the same file." });
  return groups;
}

// ---------------------------------------------------------------- skills

const SKILL_ROOTS: { tool: string; dir: string; kind: AiSkillEntry["kind"] }[] = [
  { tool: "claude", dir: ".claude/skills", kind: "skill" },
  { tool: "agents", dir: ".agents/skills", kind: "skill" },
  { tool: "codex", dir: ".codex/skills", kind: "skill" },
  { tool: "gemini", dir: ".gemini/skills", kind: "skill" },
  { tool: "antigravity", dir: ".gemini/config/skills", kind: "skill" },
  { tool: "cursor", dir: ".cursor/skills", kind: "skill" },
  { tool: "opencode", dir: ".config/opencode/skills", kind: "skill" },
  { tool: "claude", dir: ".claude/agents", kind: "agent" },
  { tool: "claude", dir: ".claude/commands", kind: "command" },
  { tool: "codex", dir: ".codex/prompts", kind: "command" },
];

function skillHint(entry: { kind: AiSkillEntry["kind"]; tool: string; name: string }): string {
  if (entry.kind === "agent") return "A Claude Code subagent: Claude hands matching work to it, or you can ask for it by name.";
  if (entry.kind === "command") return entry.tool === "codex" ? `Type /prompts:${entry.name} in Codex.` : `Type /${entry.name} in Claude Code.`;
  if (entry.tool === "claude") return `Ask for the task in Claude Code, or type /${entry.name}. Claude loads it when the request matches the description.`;
  if (entry.tool === "codex") return `Mention $${entry.name} in Codex, or describe the task; Codex loads it when it matches the description.`;
  if (entry.tool === "antigravity") return `Ask Antigravity for the task; it loads ${entry.name} when the request matches the description.`;
  if (entry.tool === "agents") return "A shared skills folder read by several coding agents; other tools may link their own skill folders here.";
  return "The tool loads it when your request matches the description.";
}

function frontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  try {
    const data = parseDocument(match[1]).toJS() as Record<string, unknown> | null;
    return { name: typeof data?.name === "string" ? data.name : undefined, description: typeof data?.description === "string" ? data.description.replace(/\s+/g, " ").trim() : undefined };
  } catch { return {}; }
}

/** Size and a content hash of a skill folder, so identical copies can be recognised. */
async function hashTree(dir: string): Promise<{ hash: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  async function walk(current: string) {
    let entries;
    try { entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(current, entry.name), rel = relative(dir, full);
      if (entry.isDirectory()) { hash.update(`d:${rel}\n`); await walk(full); continue; }
      const info = await lstat(full).catch(() => null);
      if (!info) continue;
      bytes += info.size;
      if (info.isSymbolicLink()) hash.update(`l:${rel}\n`);
      else if (info.size <= 8 * MB) hash.update(`f:${rel}\n`).update(await readFile(full).catch(() => ""));
      else hash.update(`f:${rel}:${info.size}\n`);
    }
  }
  await walk(dir);
  return { hash: hash.digest("hex"), bytes };
}

async function scanSkills(home: string, removables: Map<string, Removable>, notes: string[]): Promise<AiSkillEntry[]> {
  const entries: AiSkillEntry[] = [];
  for (const spec of SKILL_ROOTS) {
    const root = join(home, spec.dir);
    let names: string[];
    try { names = await readdir(root); } catch { continue; }
    const visit = async (dir: string, name: string, managed?: "system") => {
      const path = join(dir, name);
      const info = await lstat(path).catch(() => null);
      if (!info) return;
      const isLink = info.isSymbolicLink();
      const real = await realpath(path).catch(() => undefined);
      const target = real ? await stat(real).catch(() => null) : null;
      const base = { id: `skill:${path}`, path, kind: spec.kind, tool: spec.tool, isLink, category: "Other" as const, ...(managed ? { managed } : {}) };
      const removable = !managed;
      const register = (e: AiSkillEntry) => {
        if (removable) removables.set(e.id, { id: e.id, name: e.name, path, root, action: "trash", bytes: e.bytes, reclaimBytes: e.reclaimBytes,
          warnings: e.isLink ? [`Only the link is removed; the original at ${e.realPath ?? "its target"} stays.`] : [] });
        e.category = categorizeSkill(e.name, e.broken ? "" : e.description);
        entries.push(e);
      };
      if (isLink && !target) {
        register({ ...base, name: spec.kind === "skill" ? name : name.replace(/\.md$/, ""), description: "Broken link: its target no longer exists.", broken: true,
          bytes: 0, reclaimBytes: 0, howToUse: "Nothing to use: remove this link.", removable } as AiSkillEntry);
        return;
      }
      if (!target) return;
      if (spec.kind === "skill") {
        if (!target.isDirectory()) return;
        const text = await readFile(join(real!, "SKILL.md"), "utf8").catch(() => null);
        if (text === null) return;
        const meta = frontmatter(text), tree = await hashTree(real!);
        const skillName = meta.name || name;
        register({ ...base, name: skillName, description: meta.description ?? "No description.", broken: false, realPath: real, hash: tree.hash, bytes: tree.bytes,
          reclaimBytes: isLink ? 0 : tree.bytes, howToUse: skillHint({ kind: "skill", tool: spec.tool, name: skillName }),
          modified: target.mtime.toISOString(), removable } as AiSkillEntry);
        return;
      }
      if (!target.isFile() || !name.endsWith(".md")) return;
      const text = await readFile(real!, "utf8").catch(() => "");
      const meta = frontmatter(text), baseName = name.replace(/\.md$/, "");
      register({ ...base, name: meta.name || baseName, description: meta.description ?? "No description.", broken: false, realPath: real,
        hash: createHash("sha256").update(text).digest("hex"), bytes: target.size, reclaimBytes: isLink ? 0 : target.size,
        howToUse: skillHint({ kind: spec.kind, tool: spec.tool, name: meta.name || baseName }), modified: target.mtime.toISOString(), removable } as AiSkillEntry);
    };
    for (const name of names) {
      if (name === ".system") {
        // Skills a tool installs for itself: listed, but not removable from here.
        const sub = await readdir(join(root, name)).catch(() => [] as string[]);
        for (const child of sub) await visit(join(root, name), child, "system");
      } else if (!name.startsWith(".")) await visit(root, name);
    }
  }
  await addRepairHints(home, entries);
  const plugin = await countPluginSkills(home);
  if (plugin) notes.push(`${plugin} more skills come from Claude Code plugins. They are managed there (uninstall the plugin to remove them) and are not listed.`);
  return entries;
}

/** Skill folders under ~/Developer, by folder name, to find where a skill a broken link used to point at has moved. */
async function indexSkillFolders(home: string, budgetMs = 4000): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  const deadline = Date.now() + budgetMs;
  const queue: [string, number][] = [[join(home, "Developer"), 0]];
  while (queue.length && Date.now() < deadline) {
    const [dir, depth] = queue.shift()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) { index.set(basename(dir), [...(index.get(basename(dir)) ?? []), dir]); continue; }
    if (depth >= 7) continue;
    for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) queue.push([join(dir, e.name), depth + 1]);
  }
  return index;
}

const commonPrefix = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

/** A broken link is usually a folder that was renamed or moved. If exactly one best candidate exists, suggest it. */
async function addRepairHints(home: string, entries: AiSkillEntry[]) {
  const broken = entries.filter((e) => e.broken && e.isLink && e.kind === "skill");
  if (!broken.length) return;
  const index = await indexSkillFolders(home);
  for (const entry of broken) {
    const old = await readlink(entry.path).catch(() => "");
    const candidates = index.get(basename(old)) ?? [];
    if (!old || !candidates.length) continue;
    const scored = candidates.map((c) => ({ c, score: commonPrefix(c, old) })).sort((a, b) => b.score - a.score);
    if (scored.length === 1 || scored[0].score > scored[1].score) {
      entry.repairTo = scored[0].c;
      entry.description = `Broken link to ${old}. It most likely moved to ${scored[0].c}.`;
    } else entry.description = `Broken link to ${old}. Several folders with this name exist; pick the right one by hand.`;
  }
}

async function countPluginSkills(home: string): Promise<number> {
  const root = join(home, ".claude/plugins");
  let count = 0;
  const seen = new Set<string>();
  async function walk(dir: string, depth: number) {
    if (depth > 8) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (basename(dir) === "skills" && (await exists(join(full, "SKILL.md")))) {
        if (!seen.has(entry.name)) { seen.add(entry.name); count++; }
      } else await walk(full, depth + 1);
    }
  }
  await walk(root, 0);
  return count;
}

function skillDuplicates(skills: AiSkillEntry[]): AiDuplicateGroup[] {
  const groups: AiDuplicateGroup[] = [];
  const byName = new Map<string, AiSkillEntry[]>();
  for (const s of skills) if (!s.broken && !s.managed) byName.set(`${s.kind}:${s.name}`, [...(byName.get(`${s.kind}:${s.name}`) ?? []), s]);
  const rank = (s: AiSkillEntry) => (s.tool === "agents" ? 0 : s.tool === "claude" ? 1 : 2) + (s.isLink ? 10 : 0);
  for (const [key, items] of byName) {
    const real = new Map<string, AiSkillEntry[]>();
    for (const s of items) real.set(s.realPath ?? s.path, [...(real.get(s.realPath ?? s.path) ?? []), s]);
    // Several links to one folder are one skill installed once, not a duplicate.
    if (real.size < 2) continue;
    const copies = [...real.values()].map((list) => [...list].sort((a, b) => rank(a) - rank(b))[0]);
    const identical = new Set(copies.map((c) => c.hash)).size === 1;
    const keep = [...copies].sort((a, b) => rank(a) - rank(b))[0];
    const others = items.filter((s) => (s.realPath ?? s.path) !== (keep.realPath ?? keep.path));
    groups.push({
      id: `dup:skill:${key}`, subject: "skill", name: items[0].name,
      verdict: identical ? "identical" : "different", itemIds: items.map((i) => i.id), keepId: keep.id,
      reclaimBytes: others.reduce((a, i) => a + i.reclaimBytes, 0),
      note: identical
        ? `${real.size} separate copies with identical content. Keep one and remove the rest (or replace them with links).`
        : `${real.size} separate copies with the same name but different content. Compare them before deleting; the newest is not necessarily the best.`,
    });
  }
  return groups;
}

// ---------------------------------------------------------------- tool data

const TOOL_DATA: [string, string][] = [
  [".gemini", "Gemini / Antigravity"], [".codex", "Codex"], [".claude", "Claude Code"], [".cursor", "Cursor"],
  [".agents", "Shared agents"], [".continue", "Continue"], [".config/opencode", "OpenCode"],
];

async function scanToolData(home: string): Promise<AiToolData[]> {
  const out: AiToolData[] = [];
  for (const [dir, tool] of TOOL_DATA) {
    const path = join(home, dir);
    if (!(await exists(path))) continue;
    const children = await readdir(path).catch(() => [] as string[]);
    const parts = (await Promise.all(children.map(async (c) => ({ name: c, bytes: await diskBytes(join(path, c)) }))))
      .sort((a, b) => b.bytes - a.bytes).slice(0, 8);
    out.push({ tool, path, bytes: await diskBytes(path), parts });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

// ---------------------------------------------------------------- service

export class AiToolkit {
  private removables = new Map<string, Removable>();
  private skillEntries: AiSkillEntry[] = [];
  private usage = new Map<string, string[]>();
  private models: AiModel[] = [];
  private options: Options & { home: string };

  constructor(options: Options = {}) {
    this.options = { ...options, home: options.home ?? homedir() };
  }

  async scan(): Promise<AiInventory> {
    const { home } = this.options;
    const removables = new Map<string, Removable>(), notes: string[] = [];
    const [ollama, hf, lm, files, skills, toolData] = await Promise.all([
      scanOllama(home, removables), scanHuggingFace(home, removables), scanLmStudio(home, removables),
      scanModelFiles(home, this.options, removables, notes), scanSkills(home, removables, notes), scanToolData(home),
    ]);
    const models = [...ollama, ...hf, ...lm.models, ...files].sort((a, b) => b.bytes - a.bytes);
    const duplicates = [...skillDuplicates(skills), ...(await modelDuplicates(models, lm.files))];
    this.models = models;
    this.usage = new Map();
    this.removables = removables;
    this.skillEntries = skills;
    skills.sort((a, b) => a.name.localeCompare(b.name) || a.tool.localeCompare(b.tool));
    return { scannedAt: new Date().toISOString(), home, models, skills, duplicates, toolData, notes };
  }

  /** Searches apps, app data, config and projects for use of the models found by the latest scan. Slow, so it is separate from scan(). */
  async scanUsage(): Promise<AiUsageReport> {
    if (!this.models.length && this.removables.size === 0) throw new AppError("AI_SCAN_REQUIRED", "Scan first.");
    const models = this.models;
    const found = await findModelUsage(models, { home: this.options.home, ...this.options.usage });
    // A rescan while this ran means these ids may no longer exist; they are only used for warnings, so a stale entry is harmless.
    this.usage = new Map(models.map((m) => [m.id, [...new Set((found.usage.get(m.id) ?? []).map((u) => u.app))]]));
    return { usage: Object.fromEntries(models.map((m) => [m.id, found.usage.get(m.id) ?? []])), notes: found.notes };
  }

  /** Previews or performs removal of items from the latest scan. Nothing is moved unless dryRun is false. */
  async remove(ids: string[], dryRun: boolean): Promise<AiRemovalResult> {
    if (this.removables.size === 0 && ids.length)
      throw new AppError("AI_SCAN_REQUIRED", "Scan first: removal only works on items from the latest scan.");
    const items: AiRemovalItem[] = [], removed: string[] = [], failed: AiRemovalResult["failed"] = [];
    let freedBytes = 0;
    const trash = this.options.trashDir ?? join(this.options.home, ".Trash");
    for (const id of [...new Set(ids)]) {
      const item = this.removables.get(id);
      if (!item) { failed.push({ id, message: "Not part of the latest scan. Rescan and try again." }); continue; }
      const users = this.usage.get(id) ?? [];
      const warnings = [
        ...item.warnings, ...this.dependents(item),
        ...(users.length ? [`Used by ${users.slice(0, 4).join(", ")}${users.length > 4 ? ", …" : ""}. Removing it may stop them working until the model is downloaded again.`] : []),
      ];
      items.push({ id, name: item.name, path: item.path, action: item.action, bytes: item.reclaimBytes, warnings });
      if (dryRun) { freedBytes += item.reclaimBytes; continue; }
      try {
        await this.trashItem(item, trash);
        removed.push(id); freedBytes += item.reclaimBytes;
        this.removables.delete(id);
      } catch (e) {
        failed.push({ id, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return { dryRun, items, freedBytes, removed, failed };
  }

  /** Re-points broken skill links at the folder they most likely moved to. Previews unless dryRun is false. */
  async repair(ids: string[], dryRun: boolean): Promise<AiRemovalResult> {
    if (this.removables.size === 0 && ids.length)
      throw new AppError("AI_SCAN_REQUIRED", "Scan first: repair only works on items from the latest scan.");
    const items: AiRemovalItem[] = [], removed: string[] = [], failed: AiRemovalResult["failed"] = [];
    for (const id of [...new Set(ids)]) {
      const entry = this.skillEntries.find((s) => s.id === id), item = this.removables.get(id);
      if (!entry || !item || !entry.broken || !entry.isLink || !entry.repairTo) { failed.push({ id, message: "No repair is known for this item. Rescan, or remove the broken link." }); continue; }
      items.push({ id, name: entry.name, path: entry.path, action: "relink", bytes: 0, warnings: [`Will point at ${entry.repairTo}.`] });
      if (dryRun) continue;
      try {
        if (!inside(entry.path, item.root)) throw new AppError("AI_PATH_REJECTED", `${entry.path} is outside ${item.root}.`);
        const current = await lstat(entry.path).catch(() => null);
        if (!current?.isSymbolicLink()) throw new AppError("AI_ITEM_GONE", "It is no longer a link. Rescan.");
        if (await stat(entry.path).catch(() => null)) throw new AppError("AI_ITEM_CHANGED", "The link works now. Rescan.");
        if (!(await exists(join(entry.repairTo, "SKILL.md")))) throw new AppError("AI_ITEM_CHANGED", "The new location no longer has this skill. Rescan.");
        // Swap atomically so there is never a moment without the link.
        const temp = `${entry.path}.repair-${process.pid}`;
        await unlink(temp).catch(() => {});
        await symlink(entry.repairTo, temp);
        await rename(temp, entry.path);
        removed.push(id);
      } catch (e) {
        failed.push({ id, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return { dryRun, items, freedBytes: 0, removed, failed };
  }

  /**
   * Installs skills from the latest scan into other tools' skill folders, as a link to the one real folder (default,
   * so there is still one copy to maintain) or as an independent copy. Item ids are `<skill id>><target>`.
   */
  async install(ids: string[], targets: AiInstallTarget[], mode: "link" | "copy", dryRun: boolean): Promise<AiRemovalResult> {
    if (this.skillEntries.length === 0 && ids.length)
      throw new AppError("AI_SCAN_REQUIRED", "Scan first: install only works on skills from the latest scan.");
    const items: AiRemovalItem[] = [], removed: string[] = [], failed: AiRemovalResult["failed"] = [];
    for (const id of [...new Set(ids)]) {
      const source = this.skillEntries.find((s) => s.id === id);
      for (const target of [...new Set(targets)]) {
        const key = `${id}>${target}`;
        const fail = (message: string) => failed.push({ id: key, message });
        if (!source || source.kind !== "skill") { fail("Only skills from the latest scan can be installed."); continue; }
        if (source.broken || !source.realPath) { fail("This skill's link is broken. Repair it first."); continue; }
        if (source.managed) { fail("This is a tool's built-in skill and cannot be installed elsewhere."); continue; }
        if (source.tool === target) { fail(`It is already in ${target}.`); continue; }
        const root = join(this.options.home, INSTALL_DIRS[target]), dest = join(root, basename(source.path));
        const present = this.skillEntries.find((s) => s.tool === target && s.kind === "skill" && !s.broken && (s.realPath === source.realPath || s.name === source.name));
        if (present) { fail(`${target} already has ${present.name}.`); continue; }
        if (await exists(dest)) { fail(`${dest} already exists.`); continue; }
        items.push({
          id: key, name: source.name, path: dest, action: "install", bytes: mode === "copy" ? source.bytes : 0,
          warnings: [mode === "link" ? `Links to ${source.realPath}. If that folder moves, the link breaks.` : "Makes an independent copy. It will not follow later edits to the original."],
        });
        if (dryRun) continue;
        try {
          if (!inside(dest, root)) throw new AppError("AI_PATH_REJECTED", `${dest} is outside ${root}.`);
          if (!(await exists(join(source.realPath, "SKILL.md")))) throw new AppError("AI_ITEM_GONE", "The skill no longer exists. Rescan.");
          await mkdir(root, { recursive: true });
          if (mode === "copy") await cp(source.realPath, dest, { recursive: true, errorOnExist: true, force: false });
          else {
            const temp = `${dest}.install-${process.pid}`;
            await unlink(temp).catch(() => {});
            await symlink(source.realPath, temp);
            await rename(temp, dest);
          }
          removed.push(key);
        } catch (e) { fail(e instanceof Error ? e.message : String(e)); }
      }
    }
    return { dryRun, items, freedBytes: 0, removed, failed };
  }

  /** Entries elsewhere that point into a skill about to be removed, which would be left dangling. */
  private dependents(item: Removable): string[] {
    const entry = this.skillEntries.find((s) => s.id === item.id);
    if (!entry || entry.isLink || !entry.realPath) return [];
    const real = entry.realPath;
    const links = this.skillEntries.filter((s) => s.id !== entry.id && s.isLink && s.realPath && (s.realPath === real || inside(s.realPath, real)));
    return links.length ? [`${links.length} link(s) point here (${links.slice(0, 4).map((l) => `${l.tool}/${l.name}`).join(", ")}${links.length > 4 ? ", …" : ""}) and will stop working.`] : [];
  }

  private async trashItem(item: Removable, trash: string) {
    // Re-check at the moment of removal: the path must still exist and still sit inside the folder it was found in.
    if (!inside(item.path, item.root)) throw new AppError("AI_PATH_REJECTED", `${item.path} is outside ${item.root}.`);
    if (!(await exists(item.path))) throw new AppError("AI_ITEM_GONE", "It no longer exists. Rescan.");
    const targets = item.action === "ollama-model" ? [item.path, ...(item.extra ?? []).filter((p) => inside(p, item.root))] : [item.path];
    for (const target of targets) if (await exists(target)) await moveToTrash(target, trash);
  }
}

async function moveToTrash(path: string, trashDir: string) {
  await mkdir(trashDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let dest = join(trashDir, `${basename(path)} ${stamp}`);
  for (let n = 1; await exists(dest); n++) dest = join(trashDir, `${basename(path)} ${stamp} ${n}`);
  try {
    await rename(path, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EXDEV")
      throw new AppError("AI_TRASH_OTHER_VOLUME", "It is on a different disk than your Trash, so it cannot be moved there. Remove it in Finder.");
    throw e;
  }
}
