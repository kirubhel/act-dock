import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export const SIDEBAR_DEFAULT = 232, SIDEBAR_MIN = 200, SIDEBAR_MAX = 440;
const KEY = { sidebar: "act-dock.sidebar-width", workflow: "act-dock.workflow-width" } as const;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function read(key: string): number | null {
  try { const n = Number(localStorage.getItem(key)); return Number.isFinite(n) && n > 0 ? n : null; } catch { return null; }
}
function write(key: string, value: number | null) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, String(Math.round(value))); } catch { /* private window: the width just won't persist */ }
}

type Layout = { sidebar: number; setSidebar: (px: number | null) => void; workflow: number | null; setWorkflow: (px: number | null) => void };
const LayoutContext = createContext<Layout | null>(null);

/** Pane widths the user dragged, remembered between launches. `null` means "use the default layout". */
export function LayoutProvider({ children }: { children: ReactNode }) {
  const [sidebar, setSidebarState] = useState(() => clamp(read(KEY.sidebar) ?? SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX));
  const [workflow, setWorkflowState] = useState<number | null>(() => read(KEY.workflow));
  const setSidebar = useCallback((px: number | null) => {
    const next = px === null ? SIDEBAR_DEFAULT : clamp(px, SIDEBAR_MIN, SIDEBAR_MAX);
    setSidebarState(next); write(KEY.sidebar, px === null ? null : next);
  }, []);
  const setWorkflow = useCallback((px: number | null) => { setWorkflowState(px); write(KEY.workflow, px); }, []);
  return <LayoutContext.Provider value={{ sidebar, setSidebar, workflow, setWorkflow }}>{children}</LayoutContext.Provider>;
}

export function useLayout(): Layout {
  const value = useContext(LayoutContext);
  if (!value) throw new Error("useLayout must be used within a LayoutProvider.");
  return value;
}
