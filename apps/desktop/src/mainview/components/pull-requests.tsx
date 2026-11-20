import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, GitPullRequest, LoaderCircle, RefreshCw, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, openExternal } from "@/lib/api";
import { fail } from "./common";
import type {
  ClaudeFinding, ClaudeReview, GitProvider, Project, PullRequestDecision, PullRequestDetail, PullRequestFile, PullRequestList,
} from "../../shared/contracts";

export type PullRequestSelection = { projectId: string; number: number };
const label = (provider: GitProvider) => (provider === "github" ? "pull request" : "merge request");
const DECISIONS: { value: PullRequestDecision; title: string; help: string }[] = [
  { value: "approve", title: "Approve", help: "Looks good to merge." },
  { value: "request_changes", title: "Send back", help: "Request changes; the author is told what to fix." },
  { value: "comment", title: "Comment", help: "Leave feedback without a decision." },
];

export function PullRequestPanel({ project, selected, onSelect, onConfigure }: {
  project: Project; selected: number | null; onSelect: (selection: PullRequestSelection | null) => void; onConfigure: () => void;
}) {
  const [data, setData] = useState<PullRequestList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  async function load() {
    const current = ++request.current;
    setLoading(true); setError("");
    try {
      const result = await api("list_pull_requests", { projectId: project.id });
      if (current === request.current) setData(result);
    } catch (e) {
      if (current === request.current) { setData(null); setError(fail(e)); }
    } finally { if (current === request.current) setLoading(false); }
  }
  useEffect(() => {
    setData(null); setError("");
    void load();
    return () => { request.current++; };
  }, [project.id]);
  const prs = data?.pullRequests || [];
  const noun = data ? label(data.provider) : "pull request";
  return (
    <section className="branch-pipelines border border-border rounded-lg p-3 space-y-2.5" aria-label="Pull requests">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium text-sm flex items-center gap-1.5">
          <GitPullRequest className="size-4 text-muted-foreground" /> Open {noun}s{data ? ` (${prs.length})` : ""}
        </h2>
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      {error && (
        <div className="space-y-1">
          <p className="form-error" role="alert">{error}</p>
          <Button size="sm" variant="outline" onClick={onConfigure}>Git access settings</Button>
        </div>
      )}
      {data && !prs.length && <p className="field-help">No open {noun}s.</p>}
      <div className="max-h-64 overflow-auto space-y-1 pr-1">
        {prs.map((pr) => (
          <button key={pr.number} type="button" aria-pressed={selected === pr.number} title={pr.title}
            onClick={() => onSelect({ projectId: project.id, number: pr.number })}
            className={`w-full text-left text-xs border-b border-border/40 py-1.5 px-2 rounded transition-colors hover:bg-muted/50 ${selected === pr.number ? "bg-muted/70" : ""}`}>
            <span className="flex items-center gap-1.5 min-w-0">
              <span className="mono text-muted-foreground shrink-0">#{pr.number}</span>
              <span className="truncate font-medium">{pr.title}</span>
              {pr.draft && <Badge variant="outline" className="ml-auto shrink-0 text-[10px] font-normal">Draft</Badge>}
              {pr.own && <Badge variant="outline" className="ml-auto shrink-0 text-[10px] font-normal">Yours</Badge>}
            </span>
            <span className="block truncate text-muted-foreground mono">{pr.author} · {pr.branch} → {pr.base}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function DiffFile({ file }: { file: PullRequestFile }) {
  const [open, setOpen] = useState(false);
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div className="border border-border/70 rounded-md text-xs">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted/50">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="mono truncate">{file.oldPath ? `${file.oldPath} → ` : ""}{file.path}</span>
        <span className="ml-auto shrink-0 mono text-muted-foreground">{file.status} · +{file.additions} −{file.deletions}</span>
      </button>
      {open && (file.patch
        ? <pre className="mono overflow-auto max-h-96 border-t border-border/70 py-1 leading-5">{file.patch.split("\n").map((line, i) => (
            <span key={i} className={`block px-2 whitespace-pre ${line.startsWith("+") ? "bg-muted/60" : line.startsWith("-") ? "bg-muted/30 text-muted-foreground" : line.startsWith("@@") ? "text-muted-foreground" : ""}`}>
              {line || " "}
            </span>))}</pre>
        : <p className="field-help p-2 border-t border-border/70">No textual diff available (binary or too large). Open it in your Git provider.</p>)}
    </div>
  );
}

const severityOrder: ClaudeFinding["severity"][] = ["high", "medium", "low", "nit"];

type Chat = { role: "user" | "claude"; text: string };

export function PullRequestReview({ selection, project, onClose }: { selection: PullRequestSelection; project: Project; onClose: () => void }) {
  const { projectId, number } = selection;
  const [pr, setPr] = useState<PullRequestDetail | null>(null);
  const [error, setError] = useState("");
  const [review, setReview] = useState<ClaudeReview | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [claudeError, setClaudeError] = useState("");
  const [chat, setChat] = useState<Chat[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [decision, setDecision] = useState<PullRequestDecision>("comment");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [done, setDone] = useState<PullRequestDecision | null>(null);
  const current = useRef(selection);
  current.current = selection;

  useEffect(() => {
    setPr(null); setError(""); setReview(null); setClaudeError(""); setChat([]); setQuestion(""); setBody(""); setDone(null);
    let alive = true;
    api("get_pull_request", { projectId, number }).then((r) => { if (alive) setPr(r); }, (e) => { if (alive) setError(fail(e)); });
    return () => { alive = false; };
  }, [projectId, number]);

  const files = pr?.files || [];
  const totals = useMemo(() => files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }), [files]);
  const noun = pr ? label(pr.provider) : "pull request";
  const stale = (s: PullRequestSelection) => s.projectId !== current.current.projectId || s.number !== current.current.number;

  async function askClaudeForReview() {
    const at = selection;
    setReviewing(true); setClaudeError("");
    try {
      const result = await api("review_pull_request_with_claude", { projectId, number });
      if (stale(at)) return;
      setReview(result);
      setChat([]);
      if (result.verdict) setDecision(result.verdict);
    } catch (e) { if (!stale(at)) setClaudeError(fail(e)); }
    finally { if (!stale(at)) setReviewing(false); }
  }
  async function ask() {
    const text = question.trim();
    if (!text || asking) return;
    const at = selection;
    const history: Chat[] = [
      ...(review ? [{ role: "claude" as const, text: `${review.summary}\n${review.findings.map((f) => `- [${f.severity}] ${f.file || ""} ${f.comment}`).join("\n")}`.slice(0, 12000) }] : []),
      ...chat,
    ].slice(-20);
    setChat((c) => [...c, { role: "user", text }]); setQuestion(""); setAsking(true); setClaudeError("");
    try {
      const { answer } = await api("ask_claude_about_pull_request", { projectId, number, question: text, history });
      if (!stale(at)) setChat((c) => [...c, { role: "claude", text: answer }]);
    } catch (e) { if (!stale(at)) setClaudeError(fail(e)); }
    finally { if (!stale(at)) setAsking(false); }
  }
  function openDialog() {
    setSendError("");
    if (review?.reviewBody && !body.trim()) setBody(review.reviewBody);
    setDialog(true);
  }
  async function send() {
    if (!pr) return;
    setSending(true); setSendError("");
    try {
      await api("submit_pull_request_review", { projectId, number, decision, body, headSha: pr.headSha || undefined });
      setDone(decision); setDialog(false); setBody("");
      toast.success(decision === "approve" ? `Approved #${number}` : decision === "request_changes" ? `Sent #${number} back with your review` : `Commented on #${number}`);
    } catch (e) { setSendError(fail(e)); }
    finally { setSending(false); }
  }
  const needsBody = decision !== "approve";

  return (
    <section className="run-pane">
      <div className="flex items-center justify-between gap-2 p-4 border-b border-border">
        <div className="min-w-0">
          <h2 className="font-medium flex items-center gap-2 truncate">
            <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">#{number} {pr?.title || ""}</span>
          </h2>
          <p className="text-xs text-muted-foreground truncate mono">
            {pr ? `${pr.author} · ${pr.branch} → ${pr.base} · ${files.length} files · +${totals.add} −${totals.del}` : project.name}
          </p>
        </div>
        <div className="flex gap-1 shrink-0">
          {pr?.url.startsWith("https://") && <Button size="sm" variant="ghost" onClick={() => void openExternal(pr.url)}><ArrowUpRight className="size-3.5" /> Open</Button>}
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>

      <div className="p-4 space-y-4 overflow-auto" style={{ maxHeight: "calc(100vh - 160px)" }}>
        {!pr && !error && <p className="field-help" role="status">Loading {noun}…</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {done && <p className="text-sm border border-border rounded-md p-3" role="status">
          {done === "approve" ? "You approved this" : done === "request_changes" ? "You sent this back with your review on this" : "Your comment was posted on this"} {noun}.
        </p>}
        {pr && <>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={openDialog}><Send className="size-3.5" /> Submit review…</Button>
            <Button size="sm" variant="outline" disabled={reviewing} onClick={() => void askClaudeForReview()}>
              {reviewing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              {review ? "Review again with Claude" : "Review with Claude"}
            </Button>
            {pr.own && <span className="field-help">This is your own {noun}; providers usually block self-approval.</span>}
          </div>

          {pr.body.trim() && <details className="border border-border/70 rounded-md p-3 text-sm">
            <summary className="cursor-pointer font-medium">Description</summary>
            <p className="whitespace-pre-wrap break-words mt-2 text-muted-foreground">{pr.body}</p>
          </details>}

          <section aria-label="Claude review" className="border border-border rounded-lg p-3 space-y-3">
            <h3 className="text-sm font-medium flex items-center gap-1.5"><Sparkles className="size-4 text-muted-foreground" /> Claude</h3>
            {!review && !reviewing && !chat.length && <p className="field-help">Claude reads this diff with your local Claude Code (no tools, nothing is posted). You make the call.</p>}
            {reviewing && <p className="field-help" role="status">Claude is reading the diff… this can take a minute.</p>}
            {review && <div className="space-y-2 text-sm">
              <p className="whitespace-pre-wrap">{review.summary}</p>
              {review.verdict && <p className="text-xs">Suggests: <Badge variant="outline" className="font-normal">{DECISIONS.find((d) => d.value === review.verdict)!.title}</Badge></p>}
              {[...review.findings].sort((a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity)).map((f, i) => (
                <div key={i} className="border border-border/70 rounded-md p-2 text-xs space-y-0.5">
                  <p className="flex gap-2"><Badge variant="outline" className="font-normal">{f.severity}</Badge>
                    {f.file && <span className="mono truncate">{f.file}{f.line ? `:${f.line}` : ""}</span>}</p>
                  <p className="whitespace-pre-wrap break-words">{f.comment}</p>
                </div>))}
            </div>}
            {chat.map((m, i) => (
              <p key={i} className={`text-sm whitespace-pre-wrap break-words ${m.role === "user" ? "text-muted-foreground" : ""}`}>
                <strong>{m.role === "user" ? "You: " : "Claude: "}</strong>{m.text}
              </p>))}
            {asking && <p className="field-help" role="status">Claude is thinking…</p>}
            {claudeError && <p className="form-error" role="alert">{claudeError}</p>}
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
              <input aria-label={`Ask Claude about this ${noun}`} value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={4000}
                placeholder="Ask about a file, a risk, or how to test it…" autoComplete="off"
                className="flex-1 min-w-0 h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" />
              <Button size="sm" type="submit" variant="outline" disabled={asking || !question.trim()}>Ask</Button>
            </form>
          </section>

          <div className="space-y-1.5">
            <h3 className="text-sm font-medium">Files changed ({files.length}{pr.truncated ? "+" : ""})</h3>
            {pr.truncated && <p className="field-help">Showing the first {files.length} files. Open the {noun} for the rest.</p>}
            {files.map((file) => <DiffFile key={file.path} file={file} />)}
          </div>
        </>}
      </div>

      <Dialog open={dialog} onOpenChange={(open) => { if (!sending) setDialog(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit review for #{number}</DialogTitle>
            <DialogDescription>This posts to {pr?.provider === "gitlab" ? "GitLab" : "GitHub"} as you, using your saved token.</DialogDescription>
          </DialogHeader>
          <div role="radiogroup" aria-label="Decision" className="grid gap-2">
            {DECISIONS.map((d) => (
              <button key={d.value} type="button" role="radio" aria-checked={decision === d.value} onClick={() => setDecision(d.value)}
                className={`text-left border rounded-md px-3 py-2 text-sm ${decision === d.value ? "border-foreground bg-muted/60" : "border-border hover:bg-muted/40"}`}>
                <strong>{d.title}</strong><span className="block text-xs text-muted-foreground">{d.help}</span>
              </button>))}
          </div>
          <Textarea aria-label="Review message" value={body} onChange={(e) => setBody(e.target.value)} rows={7} maxLength={60000}
            placeholder={needsBody ? "Required: tell the author what you found." : "Optional note"} />
          {review?.reviewBody && body !== review.reviewBody && (
            <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => setBody(review.reviewBody)}><Sparkles className="size-3.5" /> Use Claude's draft</Button>)}
          {sendError && <p className="form-error" role="alert">{sendError}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={sending} onClick={() => setDialog(false)}>Cancel</Button>
            <Button disabled={sending || (needsBody && !body.trim())} onClick={() => void send()}>
              {sending && <LoaderCircle className="size-3.5 animate-spin" />}
              {DECISIONS.find((d) => d.value === decision)!.title}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
