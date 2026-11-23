import { createHash } from "node:crypto";
import {
  AppError,
  type JiraConfig,
  type JiraUser,
  type JiraIssue,
  type JiraProject,
  type Member,
  type MemberList,
  type Project,
} from "../shared/contracts";
import { decryptToken, encryptToken, type Credential } from "./branch-pipelines";
import { Store } from "./store";

// Members are plain name/email pairs kept per project or per folder group (category).
// The Jira connection is one per installation; its API token is stored encrypted.
type Person = { name: string; email: string; accountId?: string; jiraName?: string; login?: string };
type Scope = { projectId?: string; category?: string };
type JiraStored = { site: string; email: string; updatedAt: string } & Credential;

const CONFIG_KEY = "jira-config";
export const kv = (store: Store, key: string) =>
  (store.db.query("SELECT value FROM installation WHERE key=?").get(key) as { value: string } | null)?.value;
export const putKv = (store: Store, key: string, value: string) =>
  store.db
    .query("INSERT INTO installation (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, value);

function memberKey({ projectId, category }: Scope) {
  return projectId
    ? `members:project:${projectId}`
    : `members:category:${createHash("sha256").update(category!.trim()).digest("hex")}`;
}
function readPeople(store: Store, scope: Scope): Person[] {
  try {
    const parsed = JSON.parse(kv(store, memberKey(scope)) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((p) => p && typeof p.name === "string" && typeof p.email === "string")
      : [];
  } catch {
    return [];
  }
}

export function listMembers(store: Store, scope: Scope): MemberList {
  const own = (s: Scope, tag: Member["scope"]): Member[] =>
    readPeople(store, s).map((p) => ({ ...p, scope: tag }));
  if (!scope.projectId) return { members: own(scope, "category"), category: scope.category };
  const project = store.project(scope.projectId);
  const members = own({ projectId: project.id }, "project");
  if (project.category) {
    const seen = new Set(members.map((m) => m.email));
    members.push(...own({ category: project.category }, "category").filter((m) => !seen.has(m.email)));
  }
  return { members, ...(project.category ? { category: project.category } : {}) };
}

/** A GitHub/GitLab username: no leading @, no spaces. Returns undefined for empty input. */
export function normalizeLogin(input: string): string | undefined {
  const login = input.trim().replace(/^@/, "");
  if (!login) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(login))
    throw new AppError("MEMBER_LOGIN_INVALID", "Use the GitHub or GitLab username only, without spaces or an email address.");
  return login;
}

/** `login` undefined keeps the stored one; an empty string clears it. */
export function addMember(store: Store, scope: Scope, name: string, email: string, login?: string): MemberList {
  if (scope.projectId) store.project(scope.projectId);
  const people = readPeople(store, scope);
  const previous = people.find((p) => p.email === email);
  const { login: previousLogin, ...rest } = previous ?? {};
  const nextLogin = login === undefined ? previousLogin : normalizeLogin(login);
  const next = [...people.filter((p) => p.email !== email), { ...rest, name, email, ...(nextLogin ? { login: nextLogin } : {}) }]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  putKv(store, memberKey(scope), JSON.stringify(next));
  return listMembers(store, scope);
}

export function removeMember(store: Store, scope: Scope, email: string): MemberList {
  if (scope.projectId) store.project(scope.projectId);
  putKv(store, memberKey(scope), JSON.stringify(readPeople(store, scope).filter((p) => p.email !== email)));
  return listMembers(store, scope);
}

function stored(store: Store): JiraStored | null {
  const raw = kv(store, CONFIG_KEY);
  try {
    return raw ? (JSON.parse(raw) as JiraStored) : null;
  } catch {
    return null;
  }
}

export function getJiraConfig(store: Store): JiraConfig {
  const c = stored(store);
  return c ? { site: c.site, email: c.email, tokenConfigured: !!c.encrypted } : { tokenConfigured: false };
}

// Jira Cloud only: an HTTPS host name, nothing else, so the API token can never be sent over
// plain HTTP or to a path/query smuggled into the setting.
const SITE_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
export function normalizeJiraSite(input: string) {
  const site = input.trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
  if (!SITE_RE.test(site))
    throw new AppError("INVALID_JIRA_SITE", "Enter your Jira Cloud address such as your-team.atlassian.net (no path, no http://).");
  return site;
}

export function putJiraConfig(store: Store, input: { site: string; email: string; token?: string }): JiraConfig {
  const site = normalizeJiraSite(input.site);
  const old = stored(store);
  let credential: Credential | undefined;
  if (input.token) credential = { id: crypto.randomUUID(), updatedAt: new Date().toISOString(), ...encryptToken(store, input.token) };
  else if (old?.encrypted) credential = old;
  if (!credential) throw new AppError("JIRA_TOKEN_REQUIRED", "Paste a Jira API token to connect.");
  const item: JiraStored = { ...credential, site, email: input.email, updatedAt: new Date().toISOString() };
  putKv(store, CONFIG_KEY, JSON.stringify(item));
  return getJiraConfig(store);
}

export function deleteJiraConfig(store: Store) {
  store.db.query("DELETE FROM installation WHERE key=?").run(CONFIG_KEY);
  return null;
}

async function jira<T>(store: Store, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const c = stored(store);
  const token = c ? decryptToken(store, c) : null;
  if (!c || !token) throw new AppError("JIRA_NOT_CONFIGURED", "Connect Jira first: add your site, email and API token.");
  let response: Response;
  try {
    response = await fetch(`https://${c.site}${path}`, {
      method: init.method || "GET",
      // Never follow redirects: they could carry the Authorization header to another host.
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.email}:${token}`).toString("base64")}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new AppError("JIRA_UNREACHABLE", `Could not reach ${c.site}. Check the address and your connection.`);
  }
  if (response.status >= 300 && response.status < 400)
    throw new AppError("JIRA_REDIRECT", `${c.site} redirected the request. Check the Jira site address.`);
  if (response.status === 401)
    throw new AppError("JIRA_UNAUTHORIZED", "Jira rejected the email or API token. Create a new token and save it again.");
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { errorMessages?: string[]; errors?: Record<string, string> };
    const detail = [...(body.errorMessages || []), ...Object.values(body.errors || {})].join(" ");
    throw new AppError("JIRA_REQUEST_FAILED", `Jira returned ${response.status}${detail ? `: ${detail}` : "."}`);
  }
  return (response.status === 204 ? null : await response.json()) as T;
}

export async function listJiraProjects(store: Store): Promise<JiraProject[]> {
  const page = await jira<{ values?: { key: string; name: string }[] }>(
    store,
    "/rest/api/3/project/search?maxResults=100&orderBy=name",
  );
  return (page.values || []).map(({ key, name }) => ({ key, name }));
}

type JiraAccount = { accountId: string; displayName?: string; emailAddress?: string; active?: boolean };
async function findAccount(store: Store, email: string): Promise<JiraAccount> {
  const users = (await jira<JiraAccount[]>(store, `/rest/api/3/user/search?query=${encodeURIComponent(email)}`))
    .filter((u) => u.active !== false);
  const exact = users.find((u) => u.emailAddress?.toLowerCase() === email);
  // Users who hide their address in Jira privacy settings come back without one. Trust the match
  // only when it is the single result, so a task is never assigned to a look-alike account.
  const hidden = users.length === 1 && !users[0].emailAddress ? users[0] : undefined;
  const user = exact || hidden;
  if (!user)
    throw new AppError("JIRA_USER_NOT_FOUND", `Jira can't find ${email} by email (they may hide it in Jira privacy settings). Search for them by name to link their account.`);
  return user;
}

/** Names are searchable even when emails are hidden. Limited to people who can be assigned in that project. */
export async function searchJiraUsers(store: Store, jiraProject: string, query: string): Promise<JiraUser[]> {
  const users = await jira<JiraAccount[]>(
    store,
    `/rest/api/3/user/assignable/search?project=${encodeURIComponent(jiraProject.toUpperCase())}&query=${encodeURIComponent(query)}&maxResults=20`,
  );
  return users
    .filter((u) => u.active !== false)
    .map((u) => ({ accountId: u.accountId, displayName: u.displayName || u.accountId, ...(u.emailAddress ? { emailAddress: u.emailAddress } : {}) }));
}

/** Remember which Jira account belongs to a member, wherever that member is stored (project and/or its group). */
export function linkMemberJira(store: Store, project: Project, email: string, accountId: string, displayName?: string): MemberList {
  const scopes: Scope[] = [{ projectId: project.id }, ...(project.category ? [{ category: project.category }] : [])];
  let linked = false;
  for (const scope of scopes) {
    const people = readPeople(store, scope);
    if (!people.some((p) => p.email === email)) continue;
    linked = true;
    putKv(store, memberKey(scope), JSON.stringify(people.map((p) => (p.email === email ? { ...p, accountId, jiraName: displayName } : p))));
  }
  if (!linked) throw new AppError("NOT_A_MEMBER", `${email} is not a member of ${project.name}.`);
  return listMembers(store, { projectId: project.id });
}

const adf = (text: string) => ({
  type: "doc",
  version: 1,
  content: text
    .split(/\n{2,}/)
    .filter((part) => part.trim())
    .map((part) => ({ type: "paragraph", content: [{ type: "text", text: part }] })),
});

export async function createJiraIssue(
  store: Store,
  project: Project,
  input: { jiraProject: string; summary: string; description?: string; issueType: string; assigneeEmail?: string },
): Promise<JiraIssue> {
  let assignee: JiraAccount | undefined;
  if (input.assigneeEmail) {
    const member = listMembers(store, { projectId: project.id }).members.find((m) => m.email === input.assigneeEmail);
    if (!member)
      throw new AppError("NOT_A_MEMBER", `${input.assigneeEmail} is not a member of ${project.name}. Add them to the project or its group first.`);
    // Resolve the person before creating anything so a failed lookup never leaves an unassigned task behind.
    assignee = member.accountId
      ? { accountId: member.accountId, displayName: member.jiraName || member.name }
      : await findAccount(store, input.assigneeEmail);
  }
  const description = [input.description?.trim(), `Created from Act Dock project: ${project.name}`].filter(Boolean).join("\n\n");
  const created = await jira<{ key: string }>(store, "/rest/api/3/issue", {
    method: "POST",
    body: {
      fields: {
        project: { key: input.jiraProject.toUpperCase() },
        summary: input.summary,
        issuetype: { name: input.issueType },
        description: adf(description),
        ...(assignee ? { assignee: { accountId: assignee.accountId } } : {}),
      },
    },
  });
  return {
    key: created.key,
    url: `https://${stored(store)!.site}/browse/${created.key}`,
    ...(assignee ? { assignee: assignee.displayName || input.assigneeEmail } : {}),
  };
}
