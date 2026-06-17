"use client";

import { useEffect, useRef, useState } from "react";

// inline code-token styling used inside help popovers
export const CODE_CLS = "rounded bg-black/30 px-1 font-mono text-[10px] text-foreground";

/**
 * Small "?" help affordance next to a value readout or panel title: click to open
 * a popover explaining where the adjacent numbers come from / how to read the view.
 * Closes on outside-click or Escape. Self-contained (no portal) — the popover is
 * absolutely positioned and floats above siblings (z-30).
 */
export function InfoPopover({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="what is this? where do these values come from?"
        aria-label="help"
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px] leading-none transition-colors ${
          open ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
        }`}
      >
        ?
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-30 w-72 rounded-md border border-border bg-panel p-3 text-left shadow-lg">
          <div className="mb-1.5 text-xs font-medium text-foreground">{title}</div>
          <div className="space-y-1.5 text-[11px] leading-relaxed text-muted">{children}</div>
        </div>
      )}
    </span>
  );
}
