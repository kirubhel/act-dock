import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { RemoteSnapshot } from "../../shared/contracts";

const empty: RemoteSnapshot = { version: 0, projects: {} };
const listeners = new Set<(snapshot: RemoteSnapshot) => void>();
let current = empty, running = false;

/** One long-poll for the whole webview. The runner does the Git provider polling; this only reads its cached snapshot. */
async function loop() {
  if (running) return;
  running = true;
  let since = 0;
  try {
    while (listeners.size) {
      try {
        const next = await api("get_remote_snapshot", { since, waitMs: 10000 });
        since = next.version;
        if (next.version !== current.version) {
          current = next;
          for (const listener of listeners) listener(next);
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  } finally {
    running = false;
    if (listeners.size) void loop();
  }
}

export function useRemoteSnapshot(): RemoteSnapshot {
  const [snapshot, setSnapshot] = useState(current);
  useEffect(() => {
    listeners.add(setSnapshot);
    setSnapshot(current);
    void loop();
    return () => { listeners.delete(setSnapshot); };
  }, []);
  return snapshot;
}
