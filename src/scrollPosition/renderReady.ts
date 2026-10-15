import { Component } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";

/** Wait for native geometry and its queued writes, without taking control from the user. */
export async function renderReady(leaf: WorkspaceLeaf, signal: AbortSignal, ready: Promise<unknown>): Promise<boolean> {
  if (signal.aborted) return false;
  const view = leaf.view, file = leaf.getViewState().state?.file;
  const events = new Component();
  events.load();
  let cancelled = false;
  try {
    await new Promise<void>(resolve => {
      const cancel = () => { cancelled = true; resolve(); };
      const input = (event: Event) => { if (event.isTrusted) cancel(); };
      for (const name of ["wheel", "touchstart", "pointerdown", "keydown", "input"] as const) {
        events.registerDomEvent(view.containerEl, name, input, { capture: true, passive: true });
      }
      signal.addEventListener("abort", cancel, { once: true });
      events.register(() => signal.removeEventListener("abort", cancel));
      const timeout = window.setTimeout(cancel, 12000);
      events.register(() => window.clearTimeout(timeout));
      void ready.then(() => {
        if (cancelled) return;
        const timer = window.setTimeout(resolve, 0);
        events.register(() => window.clearTimeout(timer));
      }, cancel);
    });
    return !cancelled && !signal.aborted && leaf.view === view && leaf.getViewState().state?.file === file;
  } finally { events.unload(); }
}
