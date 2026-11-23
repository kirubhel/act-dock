import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ClipboardCopy, FileText, LoaderCircle, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { Empty, fail } from "./common";
import type { ActivityReport, GeneratedReport } from "../../shared/contracts";

/** A calendar day in the viewer's time zone, as the runner expects it. */
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return day(d); };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function ReportView() {
  const [since, setSince] = useState(() => daysAgo(7));
  const [until, setUntil] = useState(() => day(new Date()));
  const [activity, setActivity] = useState<ActivityReport | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [error, setError] = useState("");
  const [people, setPeople] = useState<Set<string>>(new Set());
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<{ template: string; isDefault: boolean } | null>(null);
  const [template, setTemplate] = useState("");
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GeneratedReport | null>(null);
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);

  const collect = useCallback(async () => {
    setCollecting(true); setError("");
    try {
      const next = await api("collect_activity", { since, until, fetch: true });
      setActivity(next);
      // Everyone who committed starts selected; people with no commits stay off.
      setPeople(new Set(next.authors.filter((a) => a.commits > 0).map((a) => a.key)));
      setSkipped(new Set());
      setResult(null);
    } catch (e) { setError(fail(e)); }
    finally { setCollecting(false); }
  }, [since, until]);

  useEffect(() => {
    void api("get_report_template", {}).then((t) => { setSaved(t); setTemplate(t.template); }).catch((e) => setError(fail(e)));
    void collect();
    // The first check uses the default week; later checks are the person's call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stale = !!activity && (activity.since !== since || activity.until !== until);
  const rangeValid = !!since && !!until && since <= until;

  /** What the report will be written from: the chosen people's commits in the chosen repositories. */
  const view = useMemo(() => {
    if (!activity) return null;
    const repos = activity.repos
      .map((repo) => ({ ...repo, mine: repo.commits.filter((c) => people.has(c.author)) }))
      .filter((repo) => repo.mine.length > 0 || repo.note);
    const used = repos.filter((r) => !skipped.has(r.projectId) && r.mine.length > 0);
    const files = new Map<string, number>();
    let additions = 0, deletions = 0, commits = 0;
    for (const repo of used) {
      commits += repo.mine.length;
      for (const c of repo.mine) for (const f of c.files) {
        files.set(`${repo.projectId}:${f.path}`, 1);
        additions += f.additions; deletions += f.deletions;
      }
    }
    return { repos, used, commits, files: files.size, additions, deletions };
  }, [activity, people, skipped]);

  const names = useMemo(() => new Map((activity?.authors ?? []).map((a) => [a.key, a.name])), [activity]);
  const toggle = (set: Set<string>, key: string, on: boolean) => { const next = new Set(set); if (on) next.add(key); else next.delete(key); return next; };

  async function generate() {
    if (!activity || !view) return;
    setGenerating(true); setError("");
    try {
      const next = await api("generate_report", {
        since: activity.since, until: activity.until,
        projectIds: view.used.map((r) => r.projectId),
        authors: [...people],
        template,
      });
      setResult(next); setText(next.markdown);
    } catch (e) { setError(fail(e)); }
    finally { setGenerating(false); }
  }

  async function saveTemplate(next: string) {
    try {
      const t = await api("put_report_template", { template: next });
      setSaved(t); setTemplate(t.template);
      toast.success(t.isDefault ? "Back to the default template" : "Template saved");
    } catch (e) { setError(fail(e)); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { toast.error("Could not copy. Select the text and copy it instead."); }
  }

  return (
    <div className="page-content ai-page">
      <header className="page-heading">
        <div className="page-icon"><FileText /></div>
        <h1>Generate report</h1>
        <p>Reads the commits and changed files in every project for a period, lets you choose whose work goes in, and writes the status report from your template.</p>
      </header>

      <section className="rp-section" aria-label="Period">
        <div className="rp-range">
          <div className="field"><Label htmlFor="rp-since">From</Label><Input id="rp-since" type="date" value={since} max={until} onChange={(e) => setSince(e.target.value)} /></div>
          <div className="field"><Label htmlFor="rp-until">To</Label><Input id="rp-until" type="date" value={until} min={since} max={day(new Date())} onChange={(e) => setUntil(e.target.value)} /></div>
          <Button variant="outline" disabled={collecting || !rangeValid} onClick={() => void collect()}>
            {collecting ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {collecting ? "Checking repositories…" : activity ? "Check again" : "Check activity"}
          </Button>
        </div>
        <p className="field-help">Starts as today and the 7 days before it. Checking also fetches each project's remotes first, so work that is not pulled yet is included.</p>
      </section>

      {error && <p role="alert" className="ai-error">{error}</p>}
      {stale && !collecting && <p className="field-help" role="status">The dates changed. Check the activity again before generating.</p>}

      {activity && view && (
        <>
          <section className="rp-section" aria-label="Members">
            <div className="rp-head">
              <h2>Members <span>{people.size} of {activity.authors.length} selected</span></h2>
              <div className="rp-actions">
                <Button size="sm" variant="ghost" onClick={() => setPeople(new Set(activity.authors.map((a) => a.key)))}>Select all</Button>
                <Button size="sm" variant="ghost" onClick={() => setPeople(new Set(activity.authors.filter((a) => a.commits > 0).map((a) => a.key)))}>Only with commits</Button>
                <Button size="sm" variant="ghost" onClick={() => setPeople(new Set())}>None</Button>
              </div>
            </div>
            {activity.authors.length === 0 ? (
              <Empty title="No commits in this period" description="No project has commits between these dates, and no members are set up in Team." icon={<FileText className="size-6" />} />
            ) : (
              <ul className="ai-list">
                {activity.authors.map((a) => (
                  <li key={a.key} className="ai-row">
                    <Checkbox id={`rp-person-${a.key}`} aria-label={`Include ${a.name}`} checked={people.has(a.key)} onCheckedChange={(on) => setPeople(toggle(people, a.key, on === true))} />
                    <div className="ai-row-main">
                      <div className="ai-row-title"><label htmlFor={`rp-person-${a.key}`}><strong>{a.name}</strong></label>
                        <span className="ai-detail">{a.email}</span>
                        {!a.member && <Badge variant="outline">not in Team</Badge>}</div>
                      {a.repos.length > 0 && <p className="ai-row-desc">{a.repos.join(", ")}</p>}
                    </div>
                    <div className="ai-row-side"><span className="ai-size">{plural(a.commits, "commit")}</span></div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rp-section" aria-label="Repositories">
            <div className="rp-head">
              <h2>Repositories <span>{plural(view.used.length, "repository").replace("repositorys", "repositories")} · {plural(view.commits, "commit")} · {plural(view.files, "file")} changed · +{view.additions} −{view.deletions}</span></h2>
            </div>
            {view.repos.length === 0 ? <p className="field-help">None of the selected people have commits in this period.</p> : (
              <ul className="ai-list">
                {view.repos.map((repo) => (
                  <li key={repo.projectId} className="ai-row rp-repo">
                    <Checkbox aria-label={`Include ${repo.name}`} disabled={repo.mine.length === 0} checked={repo.mine.length > 0 && !skipped.has(repo.projectId)}
                      onCheckedChange={(on) => setSkipped(toggle(skipped, repo.projectId, on !== true))} />
                    <div className="ai-row-main">
                      <div className="ai-row-title"><strong>{repo.name}</strong>{repo.category && <Badge variant="secondary">{repo.category}</Badge>}
                        <span className="ai-detail">{plural(repo.mine.length, "commit")}</span></div>
                      {repo.note && <p className="ai-warn">{repo.note}</p>}
                      {repo.truncated && <p className="ai-warn">Very busy repository: only the newest {repo.commits.length} commits are listed.</p>}
                      {repo.mine.length > 0 && (
                        <details className="rp-commits">
                          <summary>Show commits and files</summary>
                          <ul>
                            {repo.mine.map((c) => (
                              <li key={c.hash}>
                                <div><span className="mono">{c.hash.slice(0, 7)}</span> {c.subject}</div>
                                <div className="ai-detail">{names.get(c.author) ?? c.author} · {c.date.slice(0, 10)} · {plural(c.filesTotal, "file")}</div>
                                {c.files.length > 0 && (
                                  <ul className="rp-files">
                                    {c.files.map((f) => <li key={f.path} className="mono"><span>{f.path}</span><span>+{f.additions} −{f.deletions}</span></li>)}
                                    {c.filesTotal > c.files.length && <li className="ai-detail">and {c.filesTotal - c.files.length} more</li>}
                                  </ul>
                                )}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section className="rp-section" aria-label="Template">
        <div className="rp-head">
          <h2>Template <span>{saved?.isDefault ? "default" : "your own"}</span></h2>
          <div className="rp-actions">
            <Button size="sm" variant="ghost" disabled={!saved || saved.isDefault && template === saved.template} onClick={() => void saveTemplate("")}><RotateCcw className="size-3.5" />Use default</Button>
            <Button size="sm" variant="outline" disabled={!saved || template === saved.template} onClick={() => void saveTemplate(template)}>Save template</Button>
          </div>
        </div>
        <Textarea aria-label="Report template" className="rp-template mono" spellCheck={false} value={template} onChange={(e) => setTemplate(e.target.value)} />
        <p className="field-help">Write it in markdown with [placeholders] where the report should fill things in. Edits are used for the next report even before you save them.</p>
      </section>

      <section className="rp-section" aria-label="Report">
        <div className="rp-actions">
          <Button disabled={generating || collecting || stale || !view || view.used.length === 0 || !template.trim()} onClick={() => void generate()}>
            {generating ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
            {generating ? "Writing the report…" : "Generate report"}
          </Button>
          {view && view.used.length === 0 && activity && <span className="field-help">Select at least one person who has commits.</span>}
        </div>
        {result && (
          <div className="rp-result">
            {result.note && <p className="ai-warn" role="status">{result.note}</p>}
            <div className="rp-head">
              <h2>Report <span>{result.source === "claude" ? "written by Claude from your template" : "plain activity list"}</span></h2>
              <Button size="sm" variant="outline" onClick={() => void copy()}>{copied ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />}{copied ? "Copied" : "Copy markdown"}</Button>
            </div>
            <Textarea aria-label="Generated report" className="rp-output mono" value={text} onChange={(e) => setText(e.target.value)} />
            <p className="field-help">Edit it here before you copy. Claude only sees commit messages and file names, so check milestones and next steps.</p>
          </div>
        )}
      </section>
    </div>
  );
}
