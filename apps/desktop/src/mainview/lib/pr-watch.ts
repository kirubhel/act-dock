import { useEffect, useRef, useState } from "react";
import { api, notify } from "@/lib/api";
import type { Project, PullRequestSummary } from "../../shared/contracts";

const INTERVAL_MS = 60_000;
const BACKOFF_MS = 5 * 60_000;
export type PullRequestEvent = "opened" | "updated";

/**
 * Polls each project's open pull requests while the app is open.
 * Calls onIncoming for someone else's non-draft PR that is new, or that got new commits since you last saw it.
 * The first poll of a project is a baseline and never notifies. Returns how many PRs wait for review per project.
 */
export function usePullRequestWatch(projects: Project[], onIncoming: (project: Project, pr: PullRequestSummary, event: PullRequestEvent) => void) {
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  const known = useRef(new Map<string, Map<number, string>>());
  const skipUntil = useRef(new Map<string, number>());
  const incoming = useRef(onIncoming);
  incoming.current = onIncoming;
  const key = projects.map((p) => p.id).join(",");
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    async function pollProject(project: Project) {
      if ((skipUntil.current.get(project.id) || 0) > Date.now()) return;
      try {
        const { pullRequests } = await api("list_pull_requests", { projectId: project.id });
        if (!alive) return;
        const previous = known.current.get(project.id);
        if (previous) for (const pr of pullRequests) {
          if (pr.own || pr.draft) continue;
          const before = previous.get(pr.number);
          if (before === undefined) incoming.current(project, pr, "opened");
          else if (before !== pr.headSha) incoming.current(project, pr, "updated");
        }
        known.current.set(project.id, new Map(pullRequests.map((pr) => [pr.number, pr.headSha] as const)));
        const count = pullRequests.filter((pr) => !pr.own && !pr.draft).length;
        setWaiting((w) => (w[project.id] === count ? w : { ...w, [project.id]: count }));
      } catch {
        // No remote, token or network: stop asking for a while.
        skipUntil.current.set(project.id, Date.now() + BACKOFF_MS);
      }
    }
    async function loop() {
      for (const project of projects) { if (!alive) return; await pollProject(project); }
      if (alive) timer = setTimeout(loop, INTERVAL_MS);
    }
    void loop();
    return () => { alive = false; clearTimeout(timer); };
  }, [key]);
  return waiting;
}

export function announcePullRequest(project: Project, pr: PullRequestSummary, event: PullRequestEvent) {
  const title = `${project.name}: ${event === "opened" ? "review requested" : "new commits to review"}`;
  const body = `#${pr.number} ${pr.title} · ${pr.author}`;
  void notify(title, body);
  return { title, body };
}
