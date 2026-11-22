import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/runner/store";
import {
  addMember, createJiraIssue, getJiraConfig, linkMemberJira, listMembers, normalizeJiraSite, normalizeLogin, putJiraConfig, removeMember, searchJiraUsers,
} from "../src/runner/jira";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function withStore(run: (store: Store, project: ReturnType<Store["putProject"]>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "act-dock-jira-"));
  const store = new Store(directory);
  try {
    const project = store.putProject({ id: "p1", name: "Repo", path: directory, category: "Group", defaults: {} });
    await run(store, project);
  } finally {
    store.close?.();
    await rm(directory, { recursive: true, force: true });
  }
}

test("a project sees its own members plus its group's, without duplicates", async () => {
  await withStore(async (store) => {
    addMember(store, { category: "Group" }, "Ann", "ann@example.com");
    addMember(store, { category: "Group" }, "Bob", "bob@example.com");
    addMember(store, { projectId: "p1" }, "Bobby", "bob@example.com");
    const { members, category } = listMembers(store, { projectId: "p1" });
    expect(category).toBe("Group");
    expect(members).toEqual([
      { name: "Bobby", email: "bob@example.com", scope: "project" },
      { name: "Ann", email: "ann@example.com", scope: "category" },
    ]);
    // Group members are only the group's own list.
    expect(listMembers(store, { category: "Group" }).members.map((m) => m.email)).toEqual(["ann@example.com", "bob@example.com"]);
    expect(removeMember(store, { category: "Group" }, "ann@example.com").members.map((m) => m.email)).toEqual(["bob@example.com"]);
  });
});

test("Jira site must be a bare https host", () => {
  expect(normalizeJiraSite(" https://Team.atlassian.net/ ")).toBe("team.atlassian.net");
  for (const bad of ["http://team.atlassian.net", "team.atlassian.net/path", "localhost", "a b.com", "team.atlassian.net?x=1"])
    expect(() => normalizeJiraSite(bad)).toThrow("Jira Cloud");
});

test("the Jira token is never returned and is kept when only the email changes", async () => {
  await withStore(async (store) => {
    expect(() => putJiraConfig(store, { site: "team.atlassian.net", email: "me@example.com" })).toThrow("API token");
    putJiraConfig(store, { site: "team.atlassian.net", email: "me@example.com", token: "canary-token" });
    expect(putJiraConfig(store, { site: "team.atlassian.net", email: "new@example.com" })).toEqual({
      site: "team.atlassian.net", email: "new@example.com", tokenConfigured: true,
    });
    expect(JSON.stringify(getJiraConfig(store))).not.toContain("canary-token");
    const raw = (store.db.query("SELECT value FROM installation WHERE key='jira-config'").get() as { value: string }).value;
    expect(raw).not.toContain("canary-token");
  });
});

test("an issue is assigned to the member's Jira account found by email", async () => {
  await withStore(async (store, project) => {
    putJiraConfig(store, { site: "team.atlassian.net", email: "me@example.com", token: "tok" });
    addMember(store, { category: "Group" }, "Ann", "ann@example.com");
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/user/search"))
        return Response.json([
          { accountId: "other", displayName: "Other", emailAddress: "other@example.com", active: true },
          { accountId: "acc-ann", displayName: "Ann A", emailAddress: "ann@example.com", active: true },
        ]);
      return Response.json({ key: "ENG-7" }, { status: 201 });
    }) as typeof fetch;

    const issue = await createJiraIssue(store, project, {
      jiraProject: "eng", summary: "Fix flaky test", description: "Details", issueType: "Task", assigneeEmail: "ann@example.com",
    });
    expect(issue).toEqual({ key: "ENG-7", url: "https://team.atlassian.net/browse/ENG-7", assignee: "Ann A" });
    const create = calls.find((c) => c.url.endsWith("/rest/api/3/issue"))!;
    const body = JSON.parse(String(create.init?.body));
    expect(body.fields.assignee).toEqual({ accountId: "acc-ann" });
    expect(body.fields.project).toEqual({ key: "ENG" });
    expect((create.init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("me@example.com:tok").toString("base64")}`);
    expect(create.init?.redirect).toBe("manual");
  });
});

test("nothing is created when the assignee is not a member or has no Jira account", async () => {
  await withStore(async (store, project) => {
    putJiraConfig(store, { site: "team.atlassian.net", email: "me@example.com", token: "tok" });
    addMember(store, { projectId: "p1" }, "Cy", "cy@example.com");
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return Response.json([{ accountId: "x", emailAddress: "someone-else@example.com", active: true }, { accountId: "y", emailAddress: "z@example.com", active: true }]);
    }) as typeof fetch;
    const base = { jiraProject: "ENG", summary: "S", issueType: "Task" };
    await expect(createJiraIssue(store, project, { ...base, assigneeEmail: "stranger@example.com" })).rejects.toThrow("not a member");
    expect(calls).toHaveLength(0);
    await expect(createJiraIssue(store, project, { ...base, assigneeEmail: "cy@example.com" })).rejects.toThrow("Search for them by name");
    expect(calls.every((url) => !url.endsWith("/rest/api/3/issue"))).toBe(true);
  });
});

test("a member with a hidden email is linked by name once and then assigned without an email match", async () => {
  await withStore(async (store, project) => {
    putJiraConfig(store, { site: "team.atlassian.net", email: "me@example.com", token: "tok" });
    addMember(store, { category: "Group" }, "Hikma", "hikma@example.com");
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes("/user/search")) return Response.json([]);
      if (String(url).includes("/user/assignable/search"))
        return Response.json([
          { accountId: "acc-h", displayName: "Hikma T", active: true },
          { accountId: "gone", displayName: "Hikma Old", active: false },
        ]);
      return Response.json({ key: "ENG-9" }, { status: 201 });
    }) as typeof fetch;
    const base = { jiraProject: "ENG", summary: "S", issueType: "Task", assigneeEmail: "hikma@example.com" };

    await expect(createJiraIssue(store, project, base)).rejects.toThrow("Search for them by name");
    expect(await searchJiraUsers(store, "eng", "Hikma")).toEqual([{ accountId: "acc-h", displayName: "Hikma T" }]);
    expect(urls.some((u) => u.includes("/user/assignable/search?project=ENG&query=Hikma"))).toBe(true);
    await expect(createJiraIssue(store, project, base)).rejects.toThrow(); // nothing remembered yet

    // The link is stored on the group member, so every project in the group benefits.
    linkMemberJira(store, project, "hikma@example.com", "acc-h", "Hikma T");
    expect(listMembers(store, { category: "Group" }).members[0]).toMatchObject({ accountId: "acc-h", jiraName: "Hikma T" });
    urls.length = 0;
    const issue = await createJiraIssue(store, project, base);
    expect(issue).toMatchObject({ key: "ENG-9", assignee: "Hikma T" });
    expect(urls.some((u) => u.includes("/user/search"))).toBe(false);
    expect(() => linkMemberJira(store, project, "stranger@example.com", "x")).toThrow("not a member");
  });
});

test("a member's Git username is optional, normalized, kept on re-add, and clearable", async () => {
  await withStore(async (store) => {
    addMember(store, { category: "Group" }, "Ann", "ann@example.com");
    expect(listMembers(store, { category: "Group" }).members[0]).not.toHaveProperty("login");
    addMember(store, { category: "Group" }, "Ann", "ann@example.com", " @AnnDev ");
    expect(listMembers(store, { category: "Group" }).members[0].login).toBe("AnnDev");
    addMember(store, { category: "Group" }, "Ann B", "ann@example.com"); // renaming keeps the login
    expect(listMembers(store, { category: "Group" }).members[0]).toMatchObject({ name: "Ann B", login: "AnnDev" });
    addMember(store, { category: "Group" }, "Ann B", "ann@example.com", ""); // empty clears it
    expect(listMembers(store, { category: "Group" }).members[0]).not.toHaveProperty("login");
  });
});

test("Git usernames reject emails and spaces", () => {
  expect(normalizeLogin("")).toBeUndefined();
  expect(normalizeLogin("@ann-dev")).toBe("ann-dev");
  expect(() => normalizeLogin("ann@example.com")).toThrow("username only");
  expect(() => normalizeLogin("ann dev")).toThrow("username only");
});
