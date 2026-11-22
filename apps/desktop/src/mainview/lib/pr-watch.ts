import { useEffect, useRef, useState } from "react";
import { notify } from "@/lib/api";
import { useRemoteSnapshot } from "@/lib/remote-snapshot";
import type { Project, PullRequestSummary } from "../../shared/contracts";

export type PullRequestEvent = "opened" | "updated";

/**
 * Reads each project's open pull requests from the runner's snapshot (the runner does the polling).
 * Calls onIncoming for someone else's non-draft PR that is new, or that got new commits since you last saw it.
 * The first snapshot that includes a project is a baseline and never notifies. Returns how many PRs wait for review per project.
 */
export function usePullRequestWatch(projects: Project[], onIncoming: (project: Project, pr: PullRequestSummary, event: PullRequestEvent) => void) {
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  const known = useRef(new Map<string, Map<number, string>>());
  const incoming = useRef(onIncoming);
  incoming.current = onIncoming;
  const snapshot = useRemoteSnapshot();
  const key = projects.map((p) => p.id).join(",");
  useEffect(() => {
    const counts: Record<string, number> = {};
    for (const project of projects) {
      const list = snapshot.projects[project.id]?.pullRequests?.pullRequests;
      if (!list) continue;
      const previous = known.current.get(project.id);
      if (previous) for (const pr of list) {
        if (pr.own || pr.draft) continue;
        const before = previous.get(pr.number);
        if (before === undefined) incoming.current(project, pr, "opened");
        else if (before !== pr.headSha) incoming.current(project, pr, "updated");
      }
      known.current.set(project.id, new Map(list.map((pr) => [pr.number, pr.headSha] as const)));
      counts[project.id] = list.filter((pr) => !pr.own && !pr.draft).length;
    }
    setWaiting((w) => {
      const same = Object.keys(counts).length === Object.keys(w).length && Object.entries(counts).every(([id, n]) => w[id] === n);
      return same ? w : counts;
    });
  }, [snapshot, key]);
  return waiting;
}

export function announcePullRequest(project: Project, pr: PullRequestSummary, event: PullRequestEvent) {
  const title = `${project.name}: ${event === "opened" ? "review requested" : "new commits to review"}`;
  const body = `#${pr.number} ${pr.title} · ${pr.author}`;
  void notify(title, body);
  return { title, body };
}
