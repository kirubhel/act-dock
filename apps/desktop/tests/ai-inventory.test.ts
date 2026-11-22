import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiToolkit } from "../src/runner/ai-inventory";

let home: string;
let trash: string;
let kit: AiToolkit;
const sha = (data: string) => createHash("sha256").update(data).digest("hex");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ad-ai-"));
  trash = join(home, ".Trash");
  kit = new AiToolkit({ home, trashDir: trash, fileScanMs: 2000, minFileBytes: 1024, fileRoots: [{ dir: "Downloads", depth: 3 }] });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const write = async (path: string, content: string) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
};
const skill = (name: string, description = `Does ${name}`, body = "") => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
const trashed = async () => (existsSync(trash) ? readdir(trash) : []);

async function ollama(tag: string, layers: { content: string; type?: string }[]) {
  const digests = layers.map((l) => ({ digest: `sha256:${sha(l.content)}`, size: l.content.length, mediaType: l.type ?? "application/vnd.ollama.image.model", content: l.content }));
  for (const d of digests) await write(join(home, ".ollama/models/blobs", d.digest.replace(":", "-")), d.content);
  const [name, version] = tag.split(":");
  await write(join(home, ".ollama/models/manifests/registry.ollama.ai/library", name, version), JSON.stringify({
    config: { digest: `sha256:${sha("cfg" + tag)}`, size: 3 }, layers: digests.map(({ digest, size, mediaType }) => ({ digest, size, mediaType })),
  }));
  return digests;
}

describe("models", () => {
  test("Ollama models list their size, how to run them, and what removing frees when layers are shared", async () => {
    const shared = "S".repeat(4000);
    await ollama("llama3:latest", [{ content: shared }, { content: "A".repeat(1000), type: "application/vnd.ollama.image.template" }]);
    await ollama("llama3:8b", [{ content: shared }]);
    const inv = await kit.scan();
    const latest = inv.models.find((m) => m.name === "llama3:latest")!;
    expect(latest).toMatchObject({ source: "ollama", howToUse: "Run it with: ollama run llama3:latest" });
    expect(latest.bytes).toBe(4000 + 1000 + 3);
    expect(latest.reclaimBytes).toBe(1000 + 3); // the 4000-byte weights are also used by llama3:8b
    expect(inv.duplicates.find((d) => d.subject === "model")).toMatchObject({ verdict: "identical", reclaimBytes: 0, name: "llama3" });
  });

  test("removing an Ollama model moves its manifest and only its own blobs, keeping shared ones", async () => {
    const shared = "S".repeat(4000), own = "A".repeat(1000);
    await ollama("llama3:latest", [{ content: shared }, { content: own, type: "application/vnd.ollama.image.template" }]);
    await ollama("llama3:8b", [{ content: shared }]);
    await kit.scan();
    const result = await kit.remove(["ollama:llama3:latest"], false);
    expect(result.removed).toEqual(["ollama:llama3:latest"]);
    expect(existsSync(join(home, ".ollama/models/manifests/registry.ollama.ai/library/llama3/latest"))).toBe(false);
    expect(existsSync(join(home, ".ollama/models/blobs", `sha256-${sha(own)}`))).toBe(false);
    expect(existsSync(join(home, ".ollama/models/blobs", `sha256-${sha(shared)}`))).toBe(true);
    expect(existsSync(join(home, ".ollama/models/manifests/registry.ollama.ai/library/llama3/8b"))).toBe(true);
    expect((await trashed()).length).toBe(2); // the manifest and the one blob only this model used
  });

  test("Hugging Face repos are listed with a readable name and moved to the Trash whole", async () => {
    const repo = join(home, ".cache/huggingface/hub/models--mlx-community--whisper-large-v3-mlx");
    await write(join(repo, "blobs/abc"), "x".repeat(50_000));
    await mkdir(join(repo, "snapshots/rev"), { recursive: true });
    await symlink("../../blobs/abc", join(repo, "snapshots/rev/weights.npz"));
    const inv = await kit.scan();
    const [m] = inv.models;
    expect(m).toMatchObject({ source: "huggingface", name: "mlx-community/whisper-large-v3-mlx" });
    expect(m.howToUse).toContain('from_pretrained("mlx-community/whisper-large-v3-mlx")');
    expect(m.bytes).toBeGreaterThan(40_000);
    await kit.remove([m.id], false);
    expect(existsSync(repo)).toBe(false);
    expect((await trashed())[0]).toContain("models--mlx-community--whisper-large-v3-mlx");
  });

  test("a loose GGUF identical to an Ollama model is reported as a duplicate by hash, and a different one is not", async () => {
    const weights = "G".repeat(5000);
    await ollama("tiny:latest", [{ content: weights }]);
    await write(join(home, "Downloads/tiny-copy.gguf"), weights);
    await write(join(home, "Downloads/other.gguf"), "H".repeat(5000)); // same size, different bytes
    await write(join(home, "Downloads/notes.txt"), "x".repeat(5000)); // not a model
    const inv = await kit.scan();
    expect(inv.models.filter((m) => m.source === "file").map((m) => m.name).sort()).toEqual(["other.gguf", "tiny-copy.gguf"]);
    const dups = inv.duplicates.filter((d) => d.subject === "model");
    expect(dups).toHaveLength(1);
    expect(dups[0]).toMatchObject({ verdict: "identical", name: "tiny-copy.gguf", reclaimBytes: 5000 });
    expect(dups[0].note).toContain("tiny:latest");
  });
});

describe("skills", () => {
  test("a skill installed once and linked from other tools is one skill, not a duplicate", async () => {
    await write(join(home, ".agents/skills/orca-cli/SKILL.md"), skill("orca-cli", "Drive Orca"));
    await mkdir(join(home, ".claude/skills"), { recursive: true });
    await symlink(join(home, ".agents/skills/orca-cli"), join(home, ".claude/skills/orca-cli"));
    const inv = await kit.scan();
    expect(inv.skills.map((s) => [s.tool, s.name, s.isLink])).toEqual([["agents", "orca-cli", false], ["claude", "orca-cli", true]]);
    expect(inv.duplicates).toEqual([]);
    const link = inv.skills.find((s) => s.isLink)!;
    expect(link.reclaimBytes).toBe(0);
    expect(link.howToUse).toContain("/orca-cli");
  });

  test("separate copies are duplicates: identical when the content matches, different when it does not", async () => {
    await write(join(home, ".agents/skills/lint/SKILL.md"), skill("lint", "Lint code", "same"));
    await write(join(home, ".claude/skills/lint/SKILL.md"), skill("lint", "Lint code", "same"));
    await write(join(home, ".agents/skills/deploy/SKILL.md"), skill("deploy", "Deploy", "v1"));
    await write(join(home, ".claude/skills/deploy/SKILL.md"), skill("deploy", "Deploy", "v2 changed"));
    const inv = await kit.scan();
    const lint = inv.duplicates.find((d) => d.name === "lint")!, deploy = inv.duplicates.find((d) => d.name === "deploy")!;
    expect(lint.verdict).toBe("identical");
    expect(lint.reclaimBytes).toBeGreaterThan(0);
    expect(inv.skills.find((s) => s.id === lint.keepId)?.tool).toBe("agents"); // the shared folder is the one to keep
    expect(deploy.verdict).toBe("different");
    expect(deploy.note).toContain("different content");
  });

  test("agents and commands are read from their markdown files, and system skills are listed but not removable", async () => {
    await write(join(home, ".claude/agents/reviewer.md"), "---\nname: Code Reviewer\ndescription: Reviews code\n---\nbody");
    await write(join(home, ".claude/commands/ship.md"), "---\ndescription: Ship it\n---\nbody");
    await write(join(home, ".codex/skills/.system/imagegen/SKILL.md"), skill("imagegen", "Make images"));
    const inv = await kit.scan();
    expect(inv.skills.find((s) => s.kind === "agent")).toMatchObject({ name: "Code Reviewer", description: "Reviews code" });
    expect(inv.skills.find((s) => s.kind === "command")?.howToUse).toBe("Type /ship in Claude Code.");
    const system = inv.skills.find((s) => s.name === "imagegen")!;
    expect(system).toMatchObject({ managed: "system", removable: false });
    expect((await kit.remove([system.id], false)).failed[0].message).toContain("Not part of the latest scan");
  });

  test("removing a linked skill moves only the link; removing the original warns about links that will break", async () => {
    await write(join(home, ".agents/skills/orca-cli/SKILL.md"), skill("orca-cli"));
    await mkdir(join(home, ".claude/skills"), { recursive: true });
    await symlink(join(home, ".agents/skills/orca-cli"), join(home, ".claude/skills/orca-cli"));
    const inv = await kit.scan();
    const link = inv.skills.find((s) => s.isLink)!, original = inv.skills.find((s) => !s.isLink)!;
    const warn = await kit.remove([original.id], true);
    expect(warn.items[0].warnings.join(" ")).toContain("1 link(s) point here (claude/orca-cli)");
    await kit.remove([link.id], false);
    expect(existsSync(join(home, ".claude/skills/orca-cli"))).toBe(false);
    expect(existsSync(join(home, ".agents/skills/orca-cli/SKILL.md"))).toBe(true);
  });
});

describe("repairing broken links", () => {
  async function brokenSetup() {
    // A folder that was renamed: the link still points at the old name.
    await write(join(home, "Developer/Standards/skills/build-image/SKILL.md"), skill("build-image"));
    await mkdir(join(home, ".agents/skills"), { recursive: true });
    await symlink(join(home, "Developer/old-standards/skills/build-image"), join(home, ".agents/skills/build-image"));
    await symlink(join(home, "Developer/old-standards/skills/gone"), join(home, ".agents/skills/gone"));
  }

  test("a broken link is reported, with a suggested target only when one folder clearly matches", async () => {
    await brokenSetup();
    const inv = await kit.scan();
    const fixable = inv.skills.find((s) => s.name === "build-image")!, orphan = inv.skills.find((s) => s.name === "gone")!;
    expect(fixable).toMatchObject({ broken: true, repairTo: join(home, "Developer/Standards/skills/build-image") });
    expect(orphan.broken).toBe(true);
    expect(orphan.repairTo).toBeUndefined();
  });

  test("repair previews first, then re-points the link, and refuses links that cannot be repaired", async () => {
    await brokenSetup();
    const inv = await kit.scan();
    const fixable = inv.skills.find((s) => s.name === "build-image")!, orphan = inv.skills.find((s) => s.name === "gone")!;
    const preview = await kit.repair([fixable.id, orphan.id], true);
    expect(preview.items).toHaveLength(1);
    expect(preview.failed[0].id).toBe(orphan.id);
    expect(readlinkSync(fixable.path)).toContain("old-standards"); // a preview changes nothing
    const done = await kit.repair([fixable.id], false);
    expect(done.removed).toEqual([fixable.id]);
    expect(readlinkSync(fixable.path)).toBe(join(home, "Developer/Standards/skills/build-image"));
    expect(existsSync(join(fixable.path, "SKILL.md"))).toBe(true);
    expect((await kit.repair([fixable.id], false)).failed[0].message).toContain("The link works now");
  });
});

describe("removal safety", () => {
  test("nothing is moved by a preview", async () => {
    await write(join(home, ".claude/skills/a/SKILL.md"), skill("a"));
    const inv = await kit.scan();
    const result = await kit.remove([inv.skills[0].id], true);
    expect(result).toMatchObject({ dryRun: true, removed: [], freedBytes: inv.skills[0].reclaimBytes });
    expect(existsSync(join(home, ".claude/skills/a/SKILL.md"))).toBe(true);
    expect(await trashed()).toEqual([]);
  });

  test("only ids from the latest scan are accepted, never paths", async () => {
    await expect(kit.remove(["skill:/etc/passwd"], false)).rejects.toThrow("Scan first");
    await write(join(home, ".claude/skills/a/SKILL.md"), skill("a"));
    await kit.scan();
    const result = await kit.remove(["skill:/etc/passwd", `file:${home}/../outside`], false);
    expect(result.removed).toEqual([]);
    expect(result.failed.map((f) => f.message)).toEqual(Array(2).fill("Not part of the latest scan. Rescan and try again."));
  });

  test("an item that vanished since the scan is reported instead of failing the batch", async () => {
    await write(join(home, ".claude/skills/a/SKILL.md"), skill("a"));
    await write(join(home, ".claude/skills/b/SKILL.md"), skill("b"));
    const inv = await kit.scan();
    await rm(join(home, ".claude/skills/a"), { recursive: true });
    const result = await kit.remove(inv.skills.map((s) => s.id), false);
    expect(result.removed).toHaveLength(1);
    expect(result.failed[0].message).toContain("no longer exists");
  });

  test("removing the same item twice only moves it once", async () => {
    await write(join(home, ".claude/skills/a/SKILL.md"), skill("a"));
    const inv = await kit.scan();
    const id = inv.skills[0].id;
    const result = await kit.remove([id, id], false);
    expect(result.removed).toEqual([id]);
    await expect(kit.remove([id], false)).rejects.toThrow("Scan first"); // a removed item is not offered again
    expect(lstatSync(trash).isDirectory()).toBe(true);
  });
});

describe("skill categories", () => {
  test("skills are sorted by what they are for, using the name more than the description", async () => {
    const { categorizeSkill } = await import("../src/runner/ai-categories");
    expect(categorizeSkill("check-cicd", "Review the pipeline")).toBe("CI/CD & DevOps");
    expect(categorizeSkill("build-image", "Build and push a Docker image")).toBe("CI/CD & DevOps");
    expect(categorizeSkill("swiftui-patterns", "Build iOS screens")).toBe("Mobile");
    expect(categorizeSkill("react-components", "Accessible UI with Tailwind CSS")).toBe("Frontend & Design");
    expect(categorizeSkill("api-design", "REST endpoints and Postgres migrations")).toBe("Backend & API");
    expect(categorizeSkill("owasp-review", "Find vulnerabilities")).toBe("Security");
    expect(categorizeSkill("playwright-e2e", "Write end-to-end tests")).toBe("Testing & Quality");
    expect(categorizeSkill("zzz", "Does something unusual")).toBe("Other");
  });

  test("each scanned skill carries its category", async () => {
    await write(join(home, ".claude/skills/check-cicd/SKILL.md"), skill("check-cicd", "Check the CI/CD pipeline"));
    const inv = await kit.scan();
    expect(inv.skills[0].category).toBe("CI/CD & DevOps");
  });
});

describe("installing skills into other tools", () => {
  async function shared() {
    await write(join(home, ".agents/skills/check-cicd/SKILL.md"), skill("check-cicd", "Check pipelines"));
    await write(join(home, ".agents/skills/react-ui/SKILL.md"), skill("react-ui", "React components"));
    return kit.scan();
  }

  test("a preview lists every install and changes nothing", async () => {
    const inv = await shared();
    const source = inv.skills.find((s) => s.name === "check-cicd")!;
    const preview = await kit.install([source.id], ["claude", "codex", "antigravity"], "link", true);
    expect(preview.items.map((i) => i.path).sort()).toEqual([
      join(home, ".claude/skills/check-cicd"), join(home, ".codex/skills/check-cicd"), join(home, ".gemini/config/skills/check-cicd"),
    ]);
    expect(existsSync(join(home, ".claude/skills"))).toBe(false);
  });

  test("link mode points each tool at the one real folder, copy mode makes an independent folder", async () => {
    const inv = await shared();
    const cicd = inv.skills.find((s) => s.name === "check-cicd")!, ui = inv.skills.find((s) => s.name === "react-ui")!;
    const linked = await kit.install([cicd.id], ["claude", "antigravity"], "link", false);
    expect(linked.removed).toHaveLength(2);
    expect(readlinkSync(join(home, ".claude/skills/check-cicd"))).toBe(realpathSync(join(home, ".agents/skills/check-cicd")));
    expect(existsSync(join(home, ".gemini/config/skills/check-cicd/SKILL.md"))).toBe(true);
    await kit.install([ui.id], ["codex"], "copy", false);
    expect(lstatSync(join(home, ".codex/skills/react-ui")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(home, ".codex/skills/react-ui/SKILL.md"))).toBe(true);
    // A rescan sees a link as the same install, not a duplicate.
    const after = await kit.scan();
    expect(after.duplicates.filter((d) => d.name === "check-cicd")).toEqual([]);
    expect(after.skills.filter((s) => s.name === "check-cicd").map((s) => s.tool).sort()).toEqual(["agents", "antigravity", "claude"]);
  });

  test("a tool that already has the skill, and the tool it came from, are refused without touching anything", async () => {
    await write(join(home, ".claude/skills/check-cicd/SKILL.md"), skill("check-cicd", "mine"));
    await write(join(home, ".agents/skills/check-cicd/SKILL.md"), skill("check-cicd", "shared"));
    const inv = await kit.scan();
    const shared = inv.skills.find((s) => s.tool === "agents")!;
    const result = await kit.install([shared.id], ["claude", "codex"], "link", false);
    expect(result.removed).toEqual([`${shared.id}>codex`]);
    expect(result.failed.map((f) => f.message)).toEqual(["claude already has check-cicd."]);
    expect(lstatSync(join(home, ".claude/skills/check-cicd")).isSymbolicLink()).toBe(false);
  });

  test("broken, built-in and unknown skills cannot be installed", async () => {
    await mkdir(join(home, ".agents/skills"), { recursive: true });
    await symlink(join(home, "nowhere/gone"), join(home, ".agents/skills/gone"));
    await write(join(home, ".codex/skills/.system/imagegen/SKILL.md"), skill("imagegen"));
    const inv = await kit.scan();
    const broken = inv.skills.find((s) => s.name === "gone")!, system = inv.skills.find((s) => s.name === "imagegen")!;
    const result = await kit.install([broken.id, system.id, "skill:/etc/passwd"], ["claude"], "link", false);
    expect(result.removed).toEqual([]);
    expect(result.failed.map((f) => f.message.split(".")[0])).toEqual(["This skill's link is broken", "This is a tool's built-in skill and cannot be installed elsewhere", "Only skills from the latest scan can be installed"]);
    expect(existsSync(join(home, ".claude/skills"))).toBe(false);
  });
});

describe("which apps use a model", () => {
  const usageKit = (extra: Record<string, unknown> = {}) => new AiToolkit({
    home, trashDir: trash, fileRoots: [], fileScanMs: 500,
    usage: {
      live: false,
      jobs: [
        { kind: "app", paths: [join(home, "Apps/VoiceStudio.app/Contents/Resources")], include: ["yaml", "py"], excludeDirs: ["node_modules"], excludeFiles: [] },
        { kind: "app-data", paths: [join(home, "Library/Application Support")], include: ["log", "json"], excludeDirs: [], excludeFiles: ["*prices*"] },
        { kind: "project", paths: [join(home, "Developer")], include: ["swift", "ts", "py"], excludeDirs: ["tests"], excludeFiles: [] },
      ],
      ...extra,
    },
  });

  async function hfRepo(id: string) {
    const repo = join(home, ".cache/huggingface/hub", `models--${id.replace("/", "--")}`);
    await write(join(repo, "blobs/b"), "x".repeat(2000));
    return repo;
  }

  test("finds the apps, app data and projects that name a model, with the line that names it", async () => {
    await hfRepo("mlx-community/whisper-large-v3-mlx");
    await write(join(home, "Apps/VoiceStudio.app/Contents/Resources/backend/models.yaml"), 'models:\n  - repo_id: "mlx-community/whisper-large-v3-mlx"\n');
    await write(join(home, "Library/Application Support/OmniVoice/app.log"), "INFO model install starting: mlx-community/whisper-large-v3-mlx\n");
    await write(join(home, "Developer/Work/dictate/.git/HEAD"), "ref");
    await write(join(home, "Developer/Work/dictate/src/main.py"), 'MODEL = "mlx-community/whisper-large-v3-mlx"\n');
    const k = usageKit();
    const inv = await k.scan();
    const { usage } = await k.scanUsage();
    const found = usage[inv.models[0].id];
    expect(found.map((u) => [u.kind, u.app])).toEqual([["app", "VoiceStudio"], ["app-data", "OmniVoice"], ["project", "dictate"]]);
    expect(found[0].snippet).toContain("mlx-community/whisper-large-v3-mlx");
    expect(found[1].evidence).toContain("OmniVoice/app.log");
  });

  test("a similar model, price lists and tests are not counted as use", async () => {
    await hfRepo("mlx-community/whisper-large-v3-mlx");
    await write(join(home, "Apps/Other.app/Contents/Resources/a.py"), 'm = "mlx-community/whisper-large-v3-mlx-4bit"\n'); // a different model
    await write(join(home, "Library/Application Support/Cost/prices.json"), '{"mlx-community/whisper-large-v3-mlx": 0}');
    await write(join(home, "Developer/app/tests/t.py"), 'm = "mlx-community/whisper-large-v3-mlx"\n');
    const k = usageKit();
    const inv = await k.scan();
    expect((await k.scanUsage()).usage[inv.models[0].id]).toEqual([]);
  });

  test("a bare Ollama name means its default tag only, and the preview warns before removing a model apps use", async () => {
    await ollama("llama3:latest", [{ content: "L".repeat(2000) }]);
    await ollama("llama3:8b", [{ content: "M".repeat(2000) }]);
    await write(join(home, "Developer/chat/ChatViewModel.swift"), 'let model = "llama3"\nlet other = "llama3.1"\n');
    const k = usageKit();
    const inv = await k.scan();
    const { usage } = await k.scanUsage();
    const latest = inv.models.find((m) => m.name === "llama3:latest")!, eight = inv.models.find((m) => m.name === "llama3:8b")!;
    expect(usage[latest.id].map((u) => u.app)).toEqual(["chat"]);
    expect(usage[eight.id]).toEqual([]);
    const preview = await k.remove([latest.id], true);
    expect(preview.items[0].warnings.join(" ")).toContain("Used by chat");
  });

  test("usage can only be searched after a scan", async () => {
    await expect(usageKit().scanUsage()).rejects.toThrow("Scan first");
  });
});
