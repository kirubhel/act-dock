import { useEffect, useRef, useState } from "react";
import { notify } from "@/lib/api";
import { useRemoteSnapshot } from "@/lib/remote-snapshot";
import type { LatestPipeline, PipelineState, Project } from "../../shared/contracts";

export type RemoteStatus = { state: PipelineState; branch: string; url?: string; id: number };

/**
 * Reads each project's latest remote pipelines from the runner's snapshot (the runner does the polling).
 * Returns the newest pipeline per project and notifies when one finishes.
 * The first snapshot that includes a project is a baseline and never notifies.
 */
export function useRemotePipelineWatch(projects: Project[], onFinished: (project: Project, pipeline: LatestPipeline) => void) {
  const [status, setStatus] = useState<Record<string, RemoteStatus>>({});
  const known = useRef(new Map<string, Map<number, PipelineState>>());
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const snapshot = useRemoteSnapshot();
  const key = projects.map((p) => p.id).join(",");
  useEffect(() => {
    const next: Record<string, RemoteStatus> = {};
    for (const project of projects) {
      const pipelines = snapshot.projects[project.id]?.pipelines?.pipelines;
      if (!pipelines) continue;
      const previous = known.current.get(project.id);
      if (previous) for (const pipeline of pipelines) {
        if (pipeline.state !== "success" && pipeline.state !== "failed") continue;
        const before = previous.get(pipeline.id);
        if (before !== pipeline.state && (before === "running" || before === undefined)) finished.current(project, pipeline);
      }
      known.current.set(project.id, new Map(pipelines.map((p) => [p.id, p.state] as const)));
      const latest = pipelines[0];
      if (latest) next[project.id] = { state: latest.state, branch: latest.branch, url: latest.url, id: latest.id };
    }
    setStatus((s) => {
      const same = Object.keys(next).length === Object.keys(s).length
        && Object.entries(next).every(([id, v]) => s[id]?.id === v.id && s[id]?.state === v.state && s[id]?.branch === v.branch);
      return same ? s : next;
    });
  }, [snapshot, key]);
  return status;
}

export function announce(project: Project, pipeline: LatestPipeline) {
  const ok = pipeline.state === "success";
  const title = `${project.name}: pipeline ${ok ? "succeeded" : "failed"}`;
  const body = `${pipeline.branch || "pipeline"} #${pipeline.id}`;
  void notify(title, body);
  return { title, body, ok };
}
