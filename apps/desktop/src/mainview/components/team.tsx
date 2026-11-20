import { useEffect, useState } from "react";
import { Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, openExternal } from "@/lib/api";
import { fail } from "./common";
import { AppError, type JiraConfig, type JiraProject, type JiraUser, type Member, type MemberList, type Project } from "../../shared/contracts";

type Scope = { category: string; projectId?: never } | { projectId: string; category?: never };

function JiraConnection({ onChange }: { onChange?: (config: JiraConfig) => void }) {
  const [config, setConfig] = useState<JiraConfig | null>(null);
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const apply = (next: JiraConfig) => {
    setConfig(next);
    setSite(next.site || "");
    setEmail(next.email || "");
    onChange?.(next);
  };
  useEffect(() => { void api("get_jira_config", {}).then(apply).catch((e) => setError(fail(e))); }, []);
  async function save() {
    setBusy(true); setError("");
    try {
      apply(await api("put_jira_config", { site, email, ...(token ? { token } : {}) }));
      setToken("");
      toast.success("Jira connected");
    } catch (e) { setError(fail(e)); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError("");
    try { await api("delete_jira_config", {}); apply({ tokenConfigured: false }); }
    catch (e) { setError(fail(e)); }
    finally { setBusy(false); }
  }
  return <div className="border border-border rounded-lg p-4 space-y-3">
    <Label htmlFor="jira-site">Jira connection {config?.tokenConfigured ? "· connected" : ""}</Label>
    <p className="field-help">
      One connection for every project. Use your Jira Cloud address, your Atlassian account email and an API token
      (id.atlassian.com → Security → API tokens). The token is stored encrypted on this machine and only sent to your Jira site.
    </p>
    <Input id="jira-site" value={site} spellCheck={false} autoComplete="off" placeholder="your-team.atlassian.net"
      onChange={(event) => setSite(event.target.value)} />
    <Input aria-label="Jira account email" type="email" value={email} spellCheck={false} autoComplete="off"
      placeholder="you@company.com" onChange={(event) => setEmail(event.target.value)} />
    <Input aria-label="Jira API token" type="password" value={token} spellCheck={false} autoComplete="off"
      placeholder={config?.tokenConfigured ? "Enter a replacement token (optional)" : "Paste an API token"}
      onChange={(event) => setToken(event.target.value)} />
    <div className="flex gap-2">
      <Button size="sm" disabled={busy || !site.trim() || !email.trim() || (!token && !config?.tokenConfigured)} onClick={() => void save()}>
        {config?.tokenConfigured ? "Update connection" : "Connect Jira"}
      </Button>
      {config?.tokenConfigured && <Button size="sm" variant="outline" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>}
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

export function TeamSettings({ scope }: { scope: Scope }) {
  const [list, setList] = useState<MemberList>({ members: [] });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const target = scope.projectId ? { projectId: scope.projectId } : { category: scope.category! };
  useEffect(() => {
    void api("list_members", target).then(setList).catch((e) => setError(fail(e)));
  }, [scope.projectId, scope.category]);
  async function run(call: () => Promise<MemberList>, reset = false) {
    setBusy(true); setError("");
    try { setList(await call()); if (reset) { setName(""); setEmail(""); } }
    catch (e) { setError(fail(e)); }
    finally { setBusy(false); }
  }
  const canAdd = name.trim() && email.trim() && !busy;
  const add = () => void run(() => api("add_member", { ...target, name, email }), true);
  return <div className="tab-stack">
    <p className="field-help">
      {scope.projectId
        ? `People on this project. ${list.category ? `Members of ${list.category} are included automatically.` : ""}`
        : "People on every project in this group. A project can add its own members on top."}
      {" "}Their email is used to find their Jira account when you assign a task.
    </p>
    <div className="border border-border rounded-lg p-4 space-y-3">
      <Label htmlFor="member-name">Members</Label>
      {list.members.length === 0 && <p className="field-help">No members yet.</p>}
      {list.members.map((member: Member) => <div key={`${member.scope}:${member.email}`} className="flex items-center justify-between gap-2 text-sm">
        <span className="truncate">
          {member.name} <span className="mono text-muted-foreground">{member.email}</span>
          {scope.projectId && member.scope === "category" && <span className="field-help"> · from {list.category}</span>}
        </span>
        {(!scope.projectId || member.scope === "project") && (
          <Button size="sm" variant="outline" disabled={busy} aria-label={`Remove ${member.name}`}
            onClick={() => void run(() => api("remove_member", { ...target, email: member.email }))}>
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>)}
      <div className="flex gap-2">
        <Input id="member-name" value={name} placeholder="Name" autoComplete="off" onChange={(event) => setName(event.target.value)} />
        <Input aria-label="Member email" type="email" value={email} placeholder="name@company.com" autoComplete="off" spellCheck={false}
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && canAdd) add(); }} />
        <Button size="sm" disabled={!canAdd} onClick={add}><UserPlus className="size-3.5" />Add</Button>
      </div>
    </div>
    <JiraConnection />
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

const UNASSIGNED = "__unassigned__";
const lastJiraProject = (projectId: string) => `act-dock:jira-project:${projectId}`;

export function CreateJiraTaskDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [config, setConfig] = useState<JiraConfig | null>(null);
  const [jiraProjects, setJiraProjects] = useState<JiraProject[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [jiraProject, setJiraProject] = useState(() => { try { return localStorage.getItem(lastJiraProject(project.id)) || ""; } catch { return ""; } });
  const [issueType, setIssueType] = useState("Task");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState(UNASSIGNED);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Shown when Jira can't match the member by email (hidden in privacy settings): find them by name once.
  const [linking, setLinking] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<JiraUser[] | null>(null);
  useEffect(() => {
    void api("list_members", { projectId: project.id }).then((l) => setMembers(l.members)).catch((e) => setError(fail(e)));
    void api("get_jira_config", {}).then(setConfig).catch((e) => setError(fail(e)));
  }, [project.id]);
  useEffect(() => {
    if (config?.tokenConfigured) void api("list_jira_projects", {}).then(setJiraProjects).catch((e) => setError(fail(e)));
  }, [config?.tokenConfigured]);
  async function create() {
    setBusy(true); setError("");
    try {
      const issue = await api("create_jira_issue", {
        projectId: project.id, jiraProject, summary, issueType: issueType || "Task",
        ...(description.trim() ? { description } : {}),
        ...(assignee !== UNASSIGNED ? { assigneeEmail: assignee } : {}),
      });
      try { localStorage.setItem(lastJiraProject(project.id), jiraProject); } catch {}
      toast.success(`Created ${issue.key}${issue.assignee ? ` for ${issue.assignee}` : ""}`, {
        action: { label: "Open", onClick: () => void openExternal(issue.url) },
      });
      onClose();
    } catch (e) {
      setError(fail(e));
      if (e instanceof AppError && e.code === "JIRA_USER_NOT_FOUND") {
        const name = members.find((m) => m.email === assignee)?.name || "";
        setLinking(true); setQuery(name); void search(name);
      }
    }
    finally { setBusy(false); }
  }
  async function search(text = query) {
    if (!text.trim() || !jiraProject.trim()) return;
    setError(""); setCandidates(null);
    try { setCandidates(await api("search_jira_users", { jiraProject, query: text })); }
    catch (e) { setError(fail(e)); }
  }
  async function link(user: JiraUser) {
    setBusy(true); setError("");
    try {
      const updated = await api("link_member_jira", { projectId: project.id, email: assignee, accountId: user.accountId, displayName: user.displayName });
      setMembers(updated.members);
      setLinking(false); setCandidates(null);
      toast.success(`Linked to ${user.displayName}. Create the task again.`);
    } catch (e) { setError(fail(e)); }
    finally { setBusy(false); }
  }
  const connected = !!config?.tokenConfigured;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Create Jira task</DialogTitle>
        <DialogDescription>For {project.name}. The task is assigned to the member you pick, found in Jira by their email.</DialogDescription>
      </DialogHeader>
      {config && !connected ? (
        <JiraConnection onChange={setConfig} />
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="jira-project">Jira project</Label>
            {jiraProjects.length > 0 ? (
              <Select value={jiraProject} onValueChange={setJiraProject}>
                <SelectTrigger id="jira-project" className="w-full"><SelectValue placeholder="Choose a Jira project" /></SelectTrigger>
                <SelectContent>
                  {jiraProjects.map((p) => <SelectItem key={p.key} value={p.key}>{p.name} ({p.key})</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <Input id="jira-project" value={jiraProject} placeholder="Project key, e.g. ENG" autoComplete="off"
                onChange={(event) => setJiraProject(event.target.value)} />
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="jira-summary">Summary</Label>
            <Input id="jira-summary" value={summary} maxLength={255} autoComplete="off" onChange={(event) => setSummary(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="jira-description">Description (optional)</Label>
            <Textarea id="jira-description" value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="jira-assignee">Assign to</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger id="jira-assignee" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                  {members.map((m) => <SelectItem key={m.email} value={m.email}>{m.name} ({m.email})</SelectItem>)}
                </SelectContent>
              </Select>
              {members.length === 0 && <p className="field-help">No members yet. Add them in project settings → Team.</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="jira-type">Issue type</Label>
              <Input id="jira-type" value={issueType} autoComplete="off" onChange={(event) => setIssueType(event.target.value)} />
            </div>
          </div>
        </div>
      )}
      {linking && <div className="border border-border rounded-lg p-3 space-y-2">
        <Label htmlFor="jira-user-search">Find their Jira account</Label>
        <div className="flex gap-2">
          <Input id="jira-user-search" value={query} autoComplete="off" placeholder="Name in Jira"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void search(); }} />
          <Button size="sm" variant="outline" onClick={() => void search()}>Search</Button>
        </div>
        {candidates?.length === 0 && <p className="field-help">No one assignable in {jiraProject.toUpperCase()} matches that. Try another spelling or part of the name.</p>}
        {candidates?.map((user) => <div key={user.accountId} className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate">{user.displayName} {user.emailAddress && <span className="mono text-muted-foreground">{user.emailAddress}</span>}</span>
          <Button size="sm" disabled={busy} onClick={() => void link(user)}>This is them</Button>
        </div>)}
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={busy || !connected || !jiraProject.trim() || !summary.trim()} onClick={() => void create()}>
          {busy ? "Creating…" : "Create task"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
