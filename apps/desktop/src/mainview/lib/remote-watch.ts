import { useEffect, useRef, useState } from "react";
import { api, notify } from "@/lib/api";
import type { LatestPipeline, PipelineState, Project } from "../../shared/contracts";

export type RemoteStatus = { state: PipelineState; branch: string; url?: string; id: number };
const INTERVAL_MS = 30_000;
const BACKOFF_MS = 5 * 60_000;

/**
 * Polls each project's latest remote pipelines while the app is open.
 * Returns the newest pipeline per project and notifies when one finishes.
 * The first poll of a project is a baseline and never notifies.
 */
export function useRemotePipelineWatch(projects: Project[], onFinished: (project: Project, pipeline: LatestPipeline) => void) {
  const [status, setStatus] = useState<Record<string, RemoteStatus>>({});
  const known = useRef(new Map<string, Map<number, PipelineState>>());
  const skipUntil = useRef(new Map<string, number>());
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const key = projects.map((p) => p.id).join(",");
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    async function pollProject(project: Project) {
      if ((skipUntil.current.get(project.id) || 0) > Date.now()) return;
      try {
        const result = await api("get_latest_pipelines", { projectId: project.id });
        if (!alive) return;
        const previous = known.current.get(project.id);
        const next = new Map(result.pipelines.map((p) => [p.id, p.state] as const));
        if (previous) for (const pipeline of result.pipelines) {
          if (pipeline.state !== "success" && pipeline.state !== "failed") continue;
          const before = previous.get(pipeline.id);
          if (before !== pipeline.state && (before === "running" || before === undefined)) finished.current(project, pipeline);
        }
        known.current.set(project.id, next);
        const latest = result.pipelines[0];
        setStatus((s) => {
          if (!latest) { const { [project.id]: _, ...rest } = s; return rest; }
          return { ...s, [project.id]: { state: latest.state, branch: latest.branch, url: latest.url, id: latest.id } };
        });
      } catch {
        // Missing remote, token, or network: stop asking for a while.
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
  return status;
}

export function announce(project: Project, pipeline: LatestPipeline) {
  const ok = pipeline.state === "success";
  const title = `${project.name}: pipeline ${ok ? "succeeded" : "failed"}`;
  const body = `${pipeline.branch || "pipeline"} #${pipeline.id}`;
  void notify(title, body);
  return { title, body, ok };
}
