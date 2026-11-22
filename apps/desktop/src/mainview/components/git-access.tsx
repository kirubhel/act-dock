import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight, GitBranch, Pencil, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, openExternal } from "@/lib/api";
import { fail } from "./common";
import type { BranchPipelines, CategoryGitAccess, GitProvider, Project, RemoteJobErrors, RemotePipelineDetail } from "../../shared/contracts";

type Scope = { category: string; projectId?: never } | { projectId: string; category?: never };
function safePipelineUrl(url: string | undefined, provider: GitProvider, host?: string) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.host === (host || (provider === "github" ? "github.com" : "gitlab.com"));
  } catch { return false; }
}

function GitHostSettings() {
  const [hosts, setHosts] = useState<string[]>([]);
  const [value, setValue] = useState("");
  const [apiHost, setApiHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void api("list_git_hosts", {}).then(setHosts).catch((e) => setError(fail(e))); }, []);
  async function run(call: () => Promise<string[]>) {
    setBusy(true); setError("");
    try { setHosts(await call()); setValue(""); setApiHost(""); } catch (e) { setError(fail(e)); }
    finally { setBusy(false); }
  }
  return <div className="border border-border rounded-lg p-4 space-y-3">
    <Label htmlFor="git-host-input">Self-hosted GitLab hosts</Label>
    <p className="field-help">Tokens are only sent over HTTPS to github.com, gitlab.com and the hosts listed here, and only when a project's origin remote uses that host (for example git.example.com for git@git.example.com:group/repo.git).</p>
    {hosts.map((host) => <div key={host} className="flex items-center justify-between gap-2 text-sm">
      <span className="mono truncate">{host.includes("=") ? host.replace("=", " → ") : host}</span>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api("remove_git_host", { host }))}>Remove</Button>
    </div>)}
    <p className="field-help">If your origin uses a different host than the GitLab web address (for example git@git.example.com but https://gitlab.example.com), fill in both.</p>
    <Input aria-label="GitLab web/API host (optional)" value={apiHost} spellCheck={false} autoComplete="off"
      placeholder="Web/API host, if different (gitlab.example.com)" onChange={(event) => setApiHost(event.target.value)} />
    <div className="flex gap-2">
      <Input id="git-host-input" value={value} spellCheck={false} autoComplete="off" placeholder="Origin host (git.example.com)"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && value.trim()) void run(() => api("add_git_host", { host: apiHost.trim() ? `${value.trim()}=${apiHost.trim()}` : value })); }} />
      <Button size="sm" disabled={busy || !value.trim()} onClick={() => void run(() => api("add_git_host", { host: apiHost.trim() ? `${value.trim()}=${apiHost.trim()}` : value }))}>Add host</Button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

export function GitAccessSettings({ scope }: { scope: Scope }) {
  const [access, setAccess] = useState<CategoryGitAccess[]>([]);
  const [values, setValues] = useState<Record<GitProvider, string>>({ github: "", gitlab: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setAccess(scope.projectId
      ? await api("list_project_git_access", { projectId: scope.projectId })
      : await api("list_category_git_access", { category: scope.category! }));
  }
  useEffect(() => { void load().catch((e) => setError(fail(e))); }, [scope.projectId, scope.category]);
  async function save(provider: GitProvider) {
    setBusy(true); setError("");
    try {
      if (scope.projectId) await api("put_project_git_access", { projectId: scope.projectId, provider, token: values[provider] });
      else await api("put_category_git_access", { category: scope.category!, provider, token: values[provider] });
      setValues((previous) => ({ ...previous, [provider]: "" }));
      await load();
    } catch (e) { setError(fail(e)); }
    finally { setBusy(false); }
  }
  async function remove(provider: GitProvider) {
    setBusy(true); setError("");
    try {
      if (scope.projectId) await api("delete_project_git_access", { projectId: scope.projectId, provider });
      else await api("delete_category_git_access", { category: scope.category!, provider });
      await load();
    } catch (e) { setError(fail(e)); }
    finally { setBusy(false); }
  }
  return <div className="tab-stack">
    <p className="field-help">Tokens are stored in your system vault. They are used only to read remote branches and pipeline results. A project token takes priority over its category token.</p>
    <GitHostSettings />
    {(["github", "gitlab"] as const).map((provider) => {
      const configured = access.find((a) => a.provider === provider)?.configured;
      return <div key={provider} className="border border-border rounded-lg p-4 space-y-3">
        <Label htmlFor={`git-token-${provider}-${scope.projectId || scope.category}`}>
          {provider === "github" ? "GitHub" : "GitLab"} access token {configured ? "· saved" : ""}
        </Label>
        <Input id={`git-token-${provider}-${scope.projectId || scope.category}`} type="password"
          autoComplete="off" spellCheck={false} value={values[provider]}
          onChange={(event) => setValues((previous) => ({ ...previous, [provider]: event.target.value }))}
          placeholder={configured ? "Enter a replacement token" : "Paste a read-only access token"} />
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || !values[provider]} onClick={() => void save(provider)}>
            {configured ? "Replace token" : "Save token"}
          </Button>
          {configured && <Button size="sm" variant="outline" disabled={busy} onClick={() => void remove(provider)}>Remove token</Button>}
        </div>
      </div>;
    })}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

export type RemoteSelection = { projectId: string; provider: GitProvider; host?: string; repository: string; branch: BranchPipelines["branches"][number] };

type BranchFilter = "all" | "with-pipeline" | "no-pipeline";
const COLLAPSED_KEY = "act-dock.branch-pipelines-collapsed";
const readCollapsed = () => { try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; } };

export function BranchPipelinePanel({ project, onConfigure, selected, onSelect }: {
  project: Project; onConfigure: () => void; selected: string | null; onSelect: (selection: RemoteSelection | null) => void;
}) {
  const [data, setData] = useState<BranchPipelines | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<BranchFilter>("all");
  const [search, setSearch] = useState("");
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null);
  const [renamingBranch, setRenamingBranch] = useState<string | null>(null);
  const [newBranchName, setNewBranchName] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const request = useRef(0);
  function toggle(next: boolean) {
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch { /* the choice just won't persist */ }
  }

  async function load() {
    const current = ++request.current;
    onSelect(null);
    setLoading(true); setError("");
    try {
      const result = await api("list_branch_pipelines", { projectId: project.id });
      if (current === request.current) setData(result);
    } catch (e) {
      if (current === request.current) { setData(null); setError(fail(e)); }
    } finally { if (current === request.current) setLoading(false); }
  }

  useEffect(() => {
    setData(null); setError(""); setLoading(false); onSelect(null);
    return () => { request.current++; };
  }, [project.id]);

  const branches = data?.branches || [];
  const withPipelineCount = useMemo(() => branches.filter((b) => b.id).length, [branches]);
  const noPipelineCount = useMemo(() => branches.length - withPipelineCount, [branches, withPipelineCount]);
  const failedCount = useMemo(
    () => branches.filter((b) => ["failed", "failure", "timed_out", "startup_failure"].includes(b.conclusion || b.status)).length,
    [branches],
  );

  const filteredBranches = useMemo(() => {
    return branches.filter((b) => {
      if (filter === "with-pipeline" && !b.id) return false;
      if (filter === "no-pipeline" && b.id) return false;
      if (search.trim() && !b.branch.toLowerCase().includes(search.trim().toLowerCase())) return false;
      return true;
    });
  }, [branches, filter, search]);

  async function handleDeleteBranch() {
    if (!deletingBranch) return;
    setActionBusy(true);
    try {
      await api("delete_branch", { projectId: project.id, branch: deletingBranch });
      toast.success(`Deleted branch "${deletingBranch}"`);
      if (selected === deletingBranch) onSelect(null);
      setDeletingBranch(null);
      await load();
    } catch (e) {
      toast.error(fail(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleRenameBranch() {
    if (!renamingBranch || !newBranchName.trim() || renamingBranch === newBranchName.trim()) return;
    setActionBusy(true);
    try {
      await api("rename_branch", { projectId: project.id, oldBranch: renamingBranch, newBranch: newBranchName.trim() });
      toast.success(`Renamed "${renamingBranch}" to "${newBranchName.trim()}"`);
      if (selected === renamingBranch) onSelect(null);
      setRenamingBranch(null);
      setNewBranchName("");
      await load();
    } catch (e) {
      toast.error(fail(e));
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <section className="branch-pipelines border border-border rounded-lg p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium text-sm min-w-0">
          <button type="button" className="flex items-center gap-1.5 text-left rounded focus-visible:outline-2 focus-visible:outline-ring"
            aria-expanded={!collapsed} aria-controls="branch-pipelines-body" onClick={() => toggle(!collapsed)}>
            {collapsed ? <ChevronRight className="size-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="size-4 shrink-0 text-muted-foreground" />}
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            <span>Remote branch pipelines</span>
            {collapsed && data && (
              <span className="text-xs font-normal text-muted-foreground">
                · {branches.length} branches{failedCount ? ` · ${failedCount} failed` : ""}
              </span>
            )}
          </button>
        </h2>
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => { toggle(false); void load(); }}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /> Check branches
        </Button>
      </div>

      <div id="branch-pipelines-body" hidden={collapsed} className="space-y-2.5">
      {error && (
        <div className="space-y-1">
          <p className="form-error" role="alert">{error}</p>
          <Button size="sm" variant="outline" onClick={onConfigure}>Git access settings</Button>
        </div>
      )}

      {data && (
        <>
          <p className="text-xs text-muted-foreground">
            {data.provider === "github" ? "GitHub" : "GitLab"}
            {data.host && data.host !== "gitlab.com" && data.host !== "github.com" ? ` (${data.host})` : ""} · {data.repository} · {branches.length} branches total
          </p>

          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Button
              size="sm"
              variant={filter === "all" ? "secondary" : "ghost"}
              className="h-6 px-2 text-[11px]"
              onClick={() => setFilter("all")}
            >
              All ({branches.length})
            </Button>
            <Button
              size="sm"
              variant={filter === "with-pipeline" ? "secondary" : "ghost"}
              className="h-6 px-2 text-[11px]"
              onClick={() => setFilter("with-pipeline")}
            >
              With pipeline ({withPipelineCount})
            </Button>
            <Button
              size="sm"
              variant={filter === "no-pipeline" ? "secondary" : "ghost"}
              className="h-6 px-2 text-[11px]"
              onClick={() => setFilter("no-pipeline")}
            >
              No pipeline ({noPipelineCount})
            </Button>
          </div>

          <div className="relative">
            <Search className="size-3.5 absolute left-2.5 top-2 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter branches by name..."
              className="h-7 pl-8 text-xs bg-background/50"
            />
          </div>

          <div className="max-h-64 overflow-auto space-y-1 pr-1">
            {filteredBranches.map((branch) => {
              const outcome = branch.conclusion || branch.status;
              const isFailed = ["failed", "failure", "timed_out", "startup_failure"].includes(outcome);
              const isSuccess = outcome === "success";
              const isRunning = ["created", "waiting_for_resource", "preparing", "pending", "running", "queued", "in_progress", "waiting"].includes(outcome);
              return (
                <div
                  key={branch.branch}
                  className={`group w-full flex items-center justify-between gap-2 text-xs border-b border-border/40 py-1.5 px-2 rounded text-left transition-colors hover:bg-muted/50 ${
                    selected === branch.branch ? "bg-muted/70" : ""
                  }`}
                >
                  <button
                    type="button"
                    title={branch.branch}
                    aria-pressed={selected === branch.branch}
                    onClick={() => onSelect({ projectId: project.id, provider: data.provider, host: data.host, repository: data.repository, branch })}
                    className="flex-1 flex items-center gap-1.5 min-w-0 text-left focus:outline-none"
                  >
                    <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="mono truncate font-medium">{branch.branch}</span>
                  </button>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {branch.id ? (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-medium ${
                          isSuccess
                            ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20"
                            : isFailed
                              ? "bg-rose-500/10 text-rose-500 border border-rose-500/20"
                              : isRunning
                                ? "bg-sky-500/10 text-sky-400 border border-sky-500/20"
                                : "text-muted-foreground bg-muted/60"
                        }`}
                      >
                        {outcome}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground/80 border border-border/60 bg-muted/30 px-1.5 py-0.5 rounded">
                        no pipeline
                      </span>
                    )}

                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                        title={`Rename "${branch.branch}"`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenamingBranch(branch.branch);
                          setNewBranchName(branch.branch);
                        }}
                      >
                        <Pencil className="size-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        title={`Delete "${branch.branch}"`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeletingBranch(branch.branch);
                        }}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {!filteredBranches.length && (
            <p className="field-help text-xs py-2 text-center">
              {search.trim()
                ? `No branches matching "${search.trim()}".`
                : filter === "with-pipeline"
                  ? "No branches have a recent pipeline."
                  : filter === "no-pipeline"
                    ? "All branches have a recent pipeline."
                    : "No branches returned by the Git provider."}
            </p>
          )}
        </>
      )}
      </div>

      {/* Delete Branch Confirmation Dialog */}
      <AlertDialog open={!!deletingBranch} onOpenChange={(open) => { if (!open && !actionBusy) setDeletingBranch(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete remote branch?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the remote branch <strong className="mono text-foreground">{deletingBranch}</strong> from {data?.provider === "github" ? "GitHub" : "GitLab"} ({data?.repository}). This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={actionBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => { e.preventDefault(); void handleDeleteBranch(); }}
            >
              {actionBusy ? "Deleting..." : "Delete branch"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename Branch Dialog */}
      <Dialog open={!!renamingBranch} onOpenChange={(open) => { if (!open && !actionBusy) { setRenamingBranch(null); setNewBranchName(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename remote branch</DialogTitle>
            <DialogDescription>
              Rename <strong className="mono text-foreground">{renamingBranch}</strong> on {data?.provider === "github" ? "GitHub" : "GitLab"}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="new-branch-name">New branch name</Label>
            <Input
              id="new-branch-name"
              value={newBranchName}
              disabled={actionBusy}
              onChange={(e) => setNewBranchName(e.target.value)}
              placeholder="e.g. feature/updated-name"
              className="mono"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newBranchName.trim() && newBranchName.trim() !== renamingBranch && !actionBusy) {
                  e.preventDefault();
                  void handleRenameBranch();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={actionBusy} onClick={() => { setRenamingBranch(null); setNewBranchName(""); }}>
              Cancel
            </Button>
            <Button
              disabled={actionBusy || !newBranchName.trim() || newBranchName.trim() === renamingBranch}
              onClick={() => void handleRenameBranch()}
            >
              {actionBusy ? "Renaming..." : "Rename branch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function RemotePipelineView({ selection, onClose }: { selection: RemoteSelection; onClose: () => void }) {
  const { projectId, provider, host, repository, branch } = selection;
  const [detail, setDetail] = useState<RemotePipelineDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [jobErrors, setJobErrors] = useState<Record<number, RemoteJobErrors | string>>({});

  useEffect(() => {
    let alive = true;
    setDetail(null); setJobErrors({}); setError("");

    if (!branch.id) {
      setLoading(false);
      return;
    }

    setLoading(true);
    (async () => {
      try {
        const result = await api("get_branch_pipeline_detail", { projectId, pipelineId: branch.id! });
        if (!alive) return;
        setDetail(result);
        const failed = result.jobs.filter((job) => job.conclusion === "failure" || job.status === "failed").slice(0, 5);
        const entries = await Promise.all(failed.map(async (job) => {
          try { return [job.id, await api("get_branch_job_errors", { projectId, jobId: job.id })] as const; }
          catch (e) { return [job.id, fail(e)] as const; }
        }));
        if (alive) setJobErrors(Object.fromEntries(entries));
      } catch (e) { if (alive) setError(fail(e)); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [projectId, branch.id]);

  return (
    <section className="run-pane">
      <div className="flex items-center justify-between gap-2 p-4 border-b border-border">
        <div className="min-w-0">
          <h2 className="font-medium flex items-center gap-2 mono truncate">
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            {branch.branch}
          </h2>
          <p className="text-xs text-muted-foreground truncate">
            {repository} · {branch.id ? (branch.conclusion || branch.status) : "No recent pipeline"}
            {branch.updatedAt ? ` · ${new Date(branch.updatedAt).toLocaleString()}` : ""}
          </p>
        </div>
        <div className="flex gap-1 shrink-0">
          {safePipelineUrl(branch.url, provider, host) && (
            <Button size="sm" variant="ghost" onClick={() => void openExternal(branch.url!)}>
              <ArrowUpRight className="size-3.5" /> Open
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>

      <div className="p-4 space-y-3 overflow-auto" style={{ maxHeight: "calc(100vh - 160px)" }}>
        {!branch.id && (
          <div className="border border-border/70 rounded-md p-6 text-center space-y-2">
            <GitBranch className="size-8 mx-auto text-muted-foreground/60" />
            <h3 className="font-medium text-sm">No recent pipelines found</h3>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              There are no pipeline runs recorded in {provider === "github" ? "GitHub" : "GitLab"} for branch <code className="mono">{branch.branch}</code> in the latest 100 runs.
            </p>
          </div>
        )}

        {loading && <p className="field-help">Loading jobs and errors…</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {detail?.jobs.map((job) => {
          const excerpt = jobErrors[job.id];
          return (
            <div key={job.id} className="border border-border/70 rounded-md p-3 space-y-1 text-sm">
              <div className="flex justify-between gap-2"><strong>{job.name}</strong><span>{job.conclusion || job.status}</span></div>
              {job.stage && <p className="text-xs text-muted-foreground">Stage: {job.stage}</p>}
              {job.failureReason && <p className="form-error">{job.failureReason}</p>}
              {job.steps.map((step) => (
                <div key={step.number} className="flex justify-between gap-2 pl-2 text-xs text-muted-foreground">
                  <span>{step.number}. {step.name}</span><span>{step.conclusion || step.status}</span>
                </div>
              ))}
              {typeof excerpt === "string" && <p className="field-help">{excerpt}</p>}
              {excerpt && typeof excerpt === "object" && (
                <pre className="mono whitespace-pre-wrap break-words text-xs max-h-72 overflow-auto">
                  {excerpt.lines.join("\n") || "No error lines found in the available log."}
                  {excerpt.truncated ? "\nLog excerpt truncated." : ""}
                </pre>
              )}
            </div>
          );
        })}
        {detail && !detail.jobs.length && <p className="field-help">No jobs returned for this pipeline.</p>}
      </div>
    </section>
  );
}
