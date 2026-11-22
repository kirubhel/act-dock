import { useRef, type KeyboardEvent, type PointerEvent } from "react";

/**
 * A vertical drag handle between two panes. Drag with the mouse, or focus it and use the arrow keys
 * (Shift for bigger steps). Double-click or Home resets to the default layout.
 */
export function ResizeHandle({ label, measure, min, max, onChange, onReset, className = "" }: {
  label: string;
  /** Current width in px of the pane this handle resizes. */
  measure: () => number;
  min: number;
  max: () => number;
  onChange: (px: number) => void;
  onReset: () => void;
  className?: string;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (n: number) => Math.round(Math.min(max(), Math.max(min, n)));
  function down(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width: measure() };
    document.body.classList.add("is-resizing");
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (start.current) onChange(clamp(start.current.width + event.clientX - start.current.x));
  }
  function up(event: PointerEvent<HTMLDivElement>) {
    start.current = null;
    document.body.classList.remove("is-resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") onChange(clamp(measure() - step));
    else if (event.key === "ArrowRight") onChange(clamp(measure() + step));
    else if (event.key === "Home") onReset();
    else return;
    event.preventDefault();
  }
  return <div role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0} title="Drag to resize, double-click to reset"
    aria-valuemin={min} aria-valuemax={Math.round(max())} aria-valuenow={Math.round(measure())}
    className={`resize-handle ${className}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
    onDoubleClick={onReset} onKeyDown={key} />;
}
