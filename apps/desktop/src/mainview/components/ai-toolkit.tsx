import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, Check, Copy, Download, FolderOpen, Link2, LoaderCircle, RefreshCw, Search, Trash2, TriangleAlert, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, revealPath } from "@/lib/api";
import { Empty, fail } from "./common";
import { AI_INSTALL_TARGETS, AI_SKILL_CATEGORIES } from "../../shared/contracts";
import type { AiDuplicateGroup, AiInstallTarget, AiInventory, AiItemBase, AiRemovalResult, AiSkillEntry, AiUsage } from "../../shared/contracts";

const bytesLabel = (n: number) => {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
};
const sourceLabel: Record<string, string> = { ollama: "Ollama", huggingface: "Hugging Face", lmstudio: "LM Studio", file: "File" };
const toolLabel = (tool: string) => ({ claude: "Claude", agents: "Shared (.agents)", codex: "Codex", gemini: "Gemini", antigravity: "Antigravity", cursor: "Cursor", opencode: "OpenCode" })[tool] ?? tool;
const usageKind: Record<AiUsage["kind"], string> = { running: "running now", app: "installed app", "app-data": "app data", config: "config", project: "project" };

type Pending =
  | { kind: "remove" | "repair"; ids: string[]; result?: AiRemovalResult; loading: boolean; error?: string }
  | { kind: "install"; ids: string[]; targets: AiInstallTarget[]; mode: "link" | "copy"; result?: AiRemovalResult; loading: boolean; error?: string };

/** Everything the toolkit knows about one skill name across the tools that hold it. */
type SkillGroup = { key: string; name: string; category: string; description: string; howToUse: string; entries: AiSkillEntry[]; source?: AiSkillEntry };

function groupSkills(skills: AiSkillEntry[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const s of skills.filter((e) => e.kind === "skill")) {
    const key = s.name.toLowerCase();
    const g = groups.get(key) ?? { key, name: s.name, category: s.category, description: s.description, howToUse: s.howToUse, entries: [] };
    g.entries.push(s);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    // The original folder is the best thing to install from; a link works too, as long as it is not broken.
    const usable = g.entries.filter((e) => !e.broken && !e.managed);
    g.source = usable.find((e) => !e.isLink) ?? usable[0];
    const described = g.entries.find((e) => !e.broken) ?? g.entries[0];
    g.description = described.description; g.howToUse = described.howToUse; g.category = described.category;
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function AiToolkitView() {
  const [inventory, setInventory] = useState<AiInventory | null>(null);
  const [usage, setUsage] = useState<Record<string, AiUsage[]> | null>(null);
  const [usageNotes, setUsageNotes] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [applying, setApplying] = useState(false);
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState<string>("all");
  // Which copy to keep in each duplicate group; unset means the scan's suggestion.
  const [keep, setKeep] = useState<Record<string, string>>({});
  const generation = useRef(0);

  const scan = useCallback(async () => {
    const mine = ++generation.current;
    setScanning(true); setError("");
    try {
      const inv = await api("scan_ai_inventory", {});
      if (mine !== generation.current) return;
      setInventory(inv); setSelected(new Set()); setKeep({}); setUsage(null); setUsageNotes([]);
      // Finding which apps use each model reads many files, so it follows the scan instead of delaying it.
      void api("scan_ai_usage", {}).then((report) => { if (mine === generation.current) { setUsage(report.usage); setUsageNotes(report.notes); } }).catch(() => { if (mine === generation.current) setUsage({}); });
    } catch (e) { setError(fail(e)); }
    finally { setScanning(false); }
  }, []);
  useEffect(() => { void scan(); }, [scan]);

  const byId = useMemo(() => {
    const map = new Map<string, AiItemBase & { removable?: boolean }>();
    for (const m of inventory?.models ?? []) map.set(m.id, m);
    for (const s of inventory?.skills ?? []) map.set(s.id, s);
    return map;
  }, [inventory]);
  const groups = useMemo(() => groupSkills(inventory?.skills ?? []), [inventory]);
  const selectedBytes = useMemo(() => [...selected].reduce((sum, id) => sum + (byId.get(id)?.reclaimBytes ?? 0), 0), [selected, byId]);
  const toggle = (id: string, on: boolean) => setSelected((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });

  async function run(p: Pending, dryRun: boolean): Promise<AiRemovalResult> {
    if (p.kind === "install") return api("install_ai_skills", { ids: p.ids, targets: p.targets, mode: p.mode, dryRun });
    return api(p.kind === "remove" ? "remove_ai_items" : "repair_ai_links", { ids: p.ids, dryRun });
  }
  async function preview(next: Pending) {
    setPending({ ...next, loading: true });
    try { setPending({ ...next, result: await run(next, true), loading: false }); }
    catch (e) { setPending({ ...next, loading: false, error: fail(e) }); }
  }
  async function apply() {
    if (!pending?.result) return;
    setApplying(true);
    try {
      const result = await run(pending, false);
      const verb = pending.kind === "remove" ? "Moved to Trash" : pending.kind === "repair" ? "Repaired" : "Installed";
      if (result.failed.length) toast.error(`${verb} ${result.removed.length}, ${result.failed.length} failed`, { description: result.failed[0].message });
      else toast.success(`${verb}: ${result.removed.length} item${result.removed.length === 1 ? "" : "s"}`, pending.kind === "remove" ? { description: `${bytesLabel(result.freedBytes)} freed. Restore from the Trash if you change your mind.` } : undefined);
      setPending(null);
      await scan();
    } catch (e) { toast.error(fail(e)); }
    finally { setApplying(false); }
  }

  const q = filter.trim().toLowerCase();
  const matches = (g: SkillGroup) => (category === "all" || g.category === category) && (!q || `${g.name} ${g.description} ${g.category}`.toLowerCase().includes(q));
  const visibleGroups = groups.filter(matches);
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const g of groups) out.set(g.category, (out.get(g.category) ?? 0) + 1);
    return out;
  }, [groups]);
  const others = (inventory?.skills ?? []).filter((s) => s.kind !== "skill" && (!q || `${s.name} ${s.description}`.toLowerCase().includes(q)));
  const totalModelBytes = (inventory?.models ?? []).reduce((a, m) => a + m.bytes, 0);
  const brokenCount = (inventory?.skills ?? []).filter((s) => s.broken).length;
  const dupSavings = (inventory?.duplicates ?? []).reduce((a, d) => a + d.reclaimBytes, 0);

  const keptIn = (g: AiDuplicateGroup) => keep[g.id] ?? g.keepId ?? g.itemIds[0];
  const removableIn = (id: string) => (byId.get(id) as { removable?: boolean } | undefined)?.removable !== false && byId.has(id);
  const othersIn = (g: AiDuplicateGroup) => g.itemIds.filter((id) => id !== keptIn(g) && removableIn(id));

  /** Skills in view that a tool does not have yet, so a whole category can be installed in one step. */
  const missingFor = (target: AiInstallTarget) => visibleGroups.filter((g) => g.source && g.source.tool !== target && !g.entries.some((e) => e.tool === target && !e.broken));
  const installFor = (target: AiInstallTarget, list: SkillGroup[]) =>
    void preview({ kind: "install", ids: list.map((g) => g.source!.id), targets: [target], mode: "link", loading: true });

  function usedBy(model: { id: string }) {
    if (usage === null) return <p className="ai-row-use ai-pending"><LoaderCircle className="size-3 animate-spin inline" /> Finding which apps use this…</p>;
    const list = usage[model.id] ?? [];
    if (!list.length) return <p className="ai-row-use"><span>Used by:</span> no app found. Apps that fetch models without writing their name anywhere readable cannot be detected.</p>;
    const apps = new Map<string, AiUsage[]>();
    for (const u of list) apps.set(u.app, [...(apps.get(u.app) ?? []), u]);
    return (
      <div className="ai-used">
        <span>Used by:</span>
        {[...apps].map(([app, uses]) => (
          <Badge key={app} variant={uses.some((u) => u.kind === "running") ? "default" : "secondary"}
            title={uses.map((u) => `${u.evidence}${u.snippet ? `\n  ${u.snippet}` : ""}`).join("\n")}>
            {app}<span className="ai-used-kind"> · {[...new Set(uses.map((u) => usageKind[u.kind]))].join(", ")}</span>
          </Badge>
        ))}
      </div>
    );
  }

  const itemRow = (item: AiItemBase, extra: { badges?: React.ReactNode; description?: string; removable?: boolean; repair?: boolean; footer?: React.ReactNode }) => (
    <li key={item.id} className="ai-row">
      <Checkbox aria-label={`Select ${item.name}`} disabled={extra.removable === false} checked={selected.has(item.id)}
        onCheckedChange={(on) => toggle(item.id, on === true)} />
      <div className="ai-row-main">
        <div className="ai-row-title"><strong>{item.name}</strong>{extra.badges}</div>
        {extra.description && <p className="ai-row-desc">{extra.description}</p>}
        <p className="ai-row-use"><span>How to use:</span> {item.howToUse}</p>
        {extra.footer}
        <p className="ai-row-path mono" title={item.path}>{item.path}</p>
      </div>
      <div className="ai-row-side">
        <span className="ai-size" title={item.reclaimBytes !== item.bytes ? `Removing frees ${bytesLabel(item.reclaimBytes)}` : undefined}>{bytesLabel(item.bytes)}</span>
        {extra.repair && <Button size="sm" variant="outline" onClick={() => void preview({ kind: "repair", ids: [item.id], loading: true })}><Wrench className="size-3.5" />Repair link</Button>}
        <Button size="icon" variant="ghost" className="size-7" aria-label={`Show ${item.name} in Finder`} title="Show in Finder" onClick={() => void revealPath(item.path)}><FolderOpen className="size-3.5" /></Button>
      </div>
    </li>
  );

  const cell = (g: SkillGroup, target: AiInstallTarget) => {
    const entry = g.entries.find((e) => e.tool === target);
    if (entry) {
      return (
        <div className="ai-cell">
          {entry.broken ? <Badge variant="destructive" title={entry.description}><TriangleAlert className="size-3" />broken</Badge>
            : <Badge variant="secondary" title={entry.isLink ? `Link to ${entry.realPath}` : entry.path}>{entry.isLink ? <Link2 className="size-3" /> : <Check className="size-3" />}{entry.isLink ? "linked" : "installed"}</Badge>}
          {entry.broken && entry.repairTo && <Button size="icon" variant="ghost" className="size-6" aria-label={`Repair ${g.name} in ${toolLabel(target)}`} title="Repair link" onClick={() => void preview({ kind: "repair", ids: [entry.id], loading: true })}><Wrench className="size-3.5" /></Button>}
          {entry.removable && <Button size="icon" variant="ghost" className="size-6" aria-label={`Remove ${g.name} from ${toolLabel(target)}`} title={`Remove from ${toolLabel(target)}`} onClick={() => void preview({ kind: "remove", ids: [entry.id], loading: true })}><Trash2 className="size-3.5" /></Button>}
        </div>
      );
    }
    return (
      <div className="ai-cell">
        <Button size="sm" variant="outline" disabled={!g.source} title={g.source ? `Install ${g.name} for ${toolLabel(target)}` : "No working copy to install from"}
          onClick={() => installFor(target, [g])}><Download className="size-3.5" />Install</Button>
      </div>
    );
  };

  return (
    <div className="page-content ai-page">
      <header className="page-heading">
        <div className="page-icon"><Boxes /></div>
        <h1>AI toolkit</h1>
        <p>Every local AI model, skill, agent and command on this Mac, what each is for, who uses it, and what you can safely clean up. Removed items go to the Trash, and you always see a preview first.</p>
        <div className="ai-summary">
          {inventory && <>
            <span><strong>{inventory.models.length}</strong> models · {bytesLabel(totalModelBytes)}</span>
            <span><strong>{groups.length}</strong> skills · <strong>{inventory.skills.length - inventory.skills.filter((s) => s.kind === "skill").length}</strong> agents and commands</span>
            <span><strong>{inventory.duplicates.length}</strong> duplicate group{inventory.duplicates.length === 1 ? "" : "s"}{dupSavings > 0 && ` · ${bytesLabel(dupSavings)} to reclaim`}</span>
            {brokenCount > 0 && <span className="ai-warn"><strong>{brokenCount}</strong> broken link{brokenCount === 1 ? "" : "s"}</span>}
          </>}
          <Button size="sm" variant="outline" className="ml-auto" disabled={scanning} onClick={() => void scan()}>
            {scanning ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{scanning ? "Scanning…" : "Scan again"}
          </Button>
        </div>
      </header>

      {error && <p role="alert" className="ai-error">{error}</p>}
      {!inventory && scanning && <p className="field-help">Scanning your home folder. This takes a few seconds.</p>}

      {inventory && (
        <Tabs defaultValue="models">
          <TabsList>
            <TabsTrigger value="models">Models ({inventory.models.length})</TabsTrigger>
            <TabsTrigger value="skills">Skills ({groups.length})</TabsTrigger>
            <TabsTrigger value="duplicates">Duplicates ({inventory.duplicates.length})</TabsTrigger>
            <TabsTrigger value="data">Tool data</TabsTrigger>
            <TabsTrigger value="help">How to use</TabsTrigger>
          </TabsList>

          <TabsContent value="models">
            {inventory.models.length === 0 ? <Empty title="No local models found" description="Looked in Ollama, Hugging Face, LM Studio and large model files in Downloads, Documents and Developer." icon={<Boxes className="size-6" />} /> : (
              <>
                {usageNotes.map((n) => <p key={n} className="field-help">{n}</p>)}
                <ul className="ai-list">
                  {[...inventory.models].sort((a, b) => b.bytes - a.bytes).map((m) => itemRow(m, {
                    badges: <><Badge variant="secondary">{sourceLabel[m.source] ?? m.source}</Badge>{m.detail && <span className="ai-detail">{m.detail}</span>}</>,
                    footer: usedBy(m),
                  }))}
                </ul>
              </>
            )}
          </TabsContent>

          <TabsContent value="skills">
            <div className="ai-filter"><Search className="size-3.5" /><Input aria-label="Filter skills" placeholder="Filter by name or description" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
            <div className="ai-chips" role="group" aria-label="Skill category">
              {["all", ...AI_SKILL_CATEGORIES].filter((c) => c === "all" || counts.has(c)).map((c) => (
                <button key={c} type="button" className="ai-chip" aria-pressed={category === c} onClick={() => setCategory(c)}>
                  {c === "all" ? "All" : c}<span>{c === "all" ? groups.length : counts.get(c)}</span>
                </button>
              ))}
            </div>

            {visibleGroups.length > 0 && (
              <div className="ai-bulk">
                <span>Install {category === "all" ? "everything shown" : `all ${category} skills`} that a tool is missing:</span>
                {AI_INSTALL_TARGETS.map((t) => {
                  const list = missingFor(t);
                  return <Button key={t} size="sm" variant="outline" disabled={!list.length} onClick={() => installFor(t, list)}><Download className="size-3.5" />{toolLabel(t)} ({list.length})</Button>;
                })}
              </div>
            )}

            {visibleGroups.length === 0 ? <p className="field-help">No skills match.</p> : (
              <ul className="ai-list ai-matrix">
                <li className="ai-skill-row ai-matrix-head" aria-hidden>
                  <span>Skill</span>{AI_INSTALL_TARGETS.map((t) => <span key={t}>{toolLabel(t)}</span>)}<span>Elsewhere</span>
                </li>
                {visibleGroups.map((g) => {
                  const elsewhere = g.entries.filter((e) => !(AI_INSTALL_TARGETS as readonly string[]).includes(e.tool));
                  return (
                    <li key={g.key} className="ai-skill-row">
                      <div className="ai-row-main">
                        <div className="ai-row-title"><strong>{g.name}</strong>{category === "all" && <Badge variant="outline">{g.category}</Badge>}</div>
                        <p className="ai-row-desc">{g.description}</p>
                        <p className="ai-row-use"><span>How to use:</span> {g.howToUse}</p>
                      </div>
                      {AI_INSTALL_TARGETS.map((t) => <div key={t} className="ai-matrix-cell" data-label={toolLabel(t)}>{cell(g, t)}</div>)}
                      <div className="ai-matrix-cell" data-label="Elsewhere">
                        {elsewhere.length === 0 ? <span className="ai-detail">—</span> : elsewhere.map((e) => (
                          <Badge key={e.id} variant={e.broken ? "destructive" : "outline"} title={`${e.path}${e.isLink ? ` → ${e.realPath ?? "broken"}` : ""}`}>
                            {toolLabel(e.tool)}{e.broken && " (broken)"}
                            {e.removable && <button type="button" className="ai-badge-x" aria-label={`Remove ${g.name} from ${toolLabel(e.tool)}`} onClick={() => void preview({ kind: "remove", ids: [e.id], loading: true })}><Trash2 className="size-3" /></button>}
                          </Badge>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {others.length > 0 && category === "all" && (
              <>
                <h2 className="ai-subhead">Agents and commands</h2>
                <ul className="ai-list">
                  {others.map((s) => itemRow(s, {
                    removable: s.removable, description: s.description,
                    badges: <><Badge variant="outline">{toolLabel(s.tool)}</Badge><Badge variant="secondary">{s.kind}</Badge><Badge variant="outline">{s.category}</Badge></>,
                  }))}
                </ul>
              </>
            )}
          </TabsContent>

          <TabsContent value="duplicates">
            {inventory.duplicates.length === 0 ? <Empty title="No duplicates" description="Skills that are links to one shared folder are counted once, so they do not show up here." icon={<Boxes className="size-6" />} /> : (
              <ul className="ai-list">
                {inventory.duplicates.map((g) => (
                  <li key={g.id} className="ai-row ai-dup">
                    <div className="ai-row-main">
                      <div className="ai-row-title"><strong>{g.name}</strong><Badge variant={g.verdict === "identical" ? "secondary" : "outline"}>{g.verdict}</Badge><Badge variant="outline">{g.subject}</Badge></div>
                      <p className="ai-row-desc">{g.note}</p>
                      <ul className="ai-dup-items">
                        {g.itemIds.map((id) => {
                          const it = byId.get(id);
                          if (!it) return null;
                          const kept = keptIn(g) === id;
                          return (
                            <li key={id} data-kept={kept || undefined}>
                              <label className="ai-keep" title="Keep this copy and remove the others">
                                <input type="radio" name={`keep-${g.id}`} checked={kept} onChange={() => setKeep((prev) => ({ ...prev, [g.id]: id }))} />
                                <span>{kept ? "Keep" : "Keep this"}</span>
                              </label>
                              <span className="mono" title={it.path}>{it.path}</span>
                              <span className="ai-size">{bytesLabel(it.bytes)}</span>
                              <Button size="icon" variant="ghost" className="size-6" disabled={!removableIn(id)} aria-label={`Remove ${it.path}`} title={removableIn(id) ? "Move just this copy to the Trash" : "Cannot be removed here"}
                                onClick={() => void preview({ kind: "remove", ids: [id], loading: true })}><Trash2 className="size-3.5" /></Button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                    <div className="ai-row-side">
                      <span className="ai-size">{g.reclaimBytes > 0 ? `${bytesLabel(g.reclaimBytes)} to reclaim` : "no space to reclaim"}</span>
                      <Button size="sm" variant="outline" disabled={!othersIn(g).length} onClick={() => void preview({ kind: "remove", ids: othersIn(g), loading: true })}>
                        <Trash2 className="size-3.5" />Keep one, remove {othersIn(g).length} other{othersIn(g).length === 1 ? "" : "s"}…
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="data">
            <p className="field-help">Chat history, caches and logs that AI tools keep. This is read-only here, because deleting it can sign you out or lose conversations. Use it to see where the space goes.</p>
            <ul className="ai-list">
              {inventory.toolData.map((t) => (
                <li key={t.path} className="ai-row">
                  <div className="ai-row-main">
                    <div className="ai-row-title"><strong>{toolLabel(t.tool)}</strong></div>
                    <p className="ai-row-desc">{t.parts.slice(0, 4).map((p) => `${p.name} ${bytesLabel(p.bytes)}`).join(" · ")}</p>
                    <p className="ai-row-path mono" title={t.path}>{t.path}</p>
                  </div>
                  <div className="ai-row-side">
                    <span className="ai-size">{bytesLabel(t.bytes)}</span>
                    <Button size="icon" variant="ghost" className="size-7" aria-label={`Show ${t.path} in Finder`} onClick={() => void revealPath(t.path)}><FolderOpen className="size-3.5" /></Button>
                  </div>
                </li>
              ))}
            </ul>
            {inventory.notes.map((n) => <p key={n} className="field-help">{n}</p>)}
          </TabsContent>

          <TabsContent value="help">
            <div className="ai-help">
              <h2>How to use this page</h2>
              <ol>
                <li><strong>Look first.</strong> Each model and skill says what it is, where it lives and how to use it. Models also list the apps that use them.</li>
                <li><strong>Browse skills by category</strong> (frontend, backend, mobile, CI/CD and more). The grid shows which of Claude, Codex and Antigravity has each skill.</li>
                <li><strong>Install</strong> a skill into a tool with its Install button, or install every missing skill of a category at once. By default the tool gets a link to the one real folder, so there is still a single copy to maintain.</li>
                <li><strong>Remove</strong> with the trash button on a skill, or tick models and duplicates and use the bar at the bottom. Everything shows a preview first and moves to the Trash.</li>
              </ol>
              <h2>Good to know</h2>
              <ul>
                <li>"Used by" is evidence, not proof: an app is listed when its files, data, logs or a project's source name the model, or when it has the model open right now. Hover a badge to see the line that matched.</li>
                <li>A skill that other tools link to is counted once. Removing a link never touches the original.</li>
                <li>Two Ollama tags can share the same weights, so removing one frees less than its size.</li>
                <li>"Repair link" re-points a broken skill link at the folder it most likely moved to.</li>
                <li>Built-in system skills are listed but cannot be removed or installed elsewhere.</li>
                <li>Agents connected through MCP can preview changes, but only you can confirm them.</li>
              </ul>
              <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(inventory.home).then(() => toast.success("Copied"))}><Copy className="size-3.5" />Copy home path</Button>
            </div>
          </TabsContent>
        </Tabs>
      )}

      {selected.size > 0 && (
        <div className="ai-action-bar" role="region" aria-label="Selection">
          <span><strong>{selected.size}</strong> selected · frees {bytesLabel(selectedBytes)}</span>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          <Button size="sm" variant="destructive" onClick={() => void preview({ kind: "remove", ids: [...selected], loading: true })}><Trash2 className="size-3.5" />Move to Trash…</Button>
        </div>
      )}

      <Dialog open={!!pending} onOpenChange={(open) => { if (!open && !applying) setPending(null); }}>
        <DialogContent className="ai-dialog">
          <DialogHeader>
            <DialogTitle>{pending?.kind === "repair" ? "Repair these links?" : pending?.kind === "install" ? `Install for ${pending.targets.map(toolLabel).join(", ")}?` : "Move these to the Trash?"}</DialogTitle>
            <DialogDescription>
              {pending?.kind === "repair" ? "Each broken link will point at the folder shown."
                : pending?.kind === "install" ? "Nothing is overwritten. Skills a tool already has are skipped."
                : "Nothing is deleted. You can restore everything from the Trash."}
            </DialogDescription>
          </DialogHeader>
          {pending?.kind === "install" && (
            <div className="ai-mode" role="group" aria-label="Install as">
              {(["link", "copy"] as const).map((m) => (
                <button key={m} type="button" className="ai-chip" aria-pressed={pending.mode === m} disabled={applying}
                  onClick={() => void preview({ ...pending, mode: m, result: undefined, error: undefined })}>
                  {m === "link" ? "Link to the original (recommended)" : "Independent copy"}
                </button>
              ))}
            </div>
          )}
          {pending?.loading && <p className="field-help"><LoaderCircle className="size-3.5 animate-spin inline" /> Checking…</p>}
          {pending?.error && <p role="alert" className="ai-error">{pending.error}</p>}
          {pending?.result && (
            <div className="ai-preview">
              <ul>
                {pending.result.items.map((i) => (
                  <li key={i.id}>
                    <div><strong>{i.name}</strong>{i.bytes > 0 && <span className="ai-size"> {bytesLabel(i.bytes)}</span>}</div>
                    <p className="mono" title={i.path}>{i.path}</p>
                    {i.warnings.map((w) => <p key={w} className="ai-warn">{w}</p>)}
                  </li>
                ))}
                {pending.result.failed.map((f) => {
                  const [id, target] = f.id.split(">");
                  return <li key={f.id}><p className="ai-error">{byId.get(id)?.name ?? id}{target ? ` → ${toolLabel(target)}` : ""}: {f.message}</p></li>;
                })}
              </ul>
              {pending.kind === "remove" && <p className="field-help">Space freed: <strong>{bytesLabel(pending.result.freedBytes)}</strong></p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={applying} onClick={() => setPending(null)}>Cancel</Button>
            <Button variant={pending?.kind === "remove" ? "destructive" : "default"} disabled={applying || pending?.loading || !pending?.result?.items.length} onClick={() => void apply()}>
              {applying && <LoaderCircle className="size-3.5 animate-spin" />}{pending?.kind === "repair" ? "Repair" : pending?.kind === "install" ? `Install ${pending.result?.items.length ?? ""}`.trim() : "Move to Trash"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
