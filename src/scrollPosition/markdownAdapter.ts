import type { MarkdownView, WorkspaceLeaf } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { renderReady } from "./renderReady";
import type { ScrollAdapter } from "./adapters";
import { fingerprint } from "./state";
import type { ScrollPosition } from "./state";

/** Public MarkdownSubView scroll values are source-line positions, including a fractional line. */
export class MarkdownScrollAdapter implements ScrollAdapter {
  constructor(private leaf: WorkspaceLeaf) {}
  private view(): MarkdownView { return this.leaf.view as MarkdownView; }
  private container(): HTMLElement | null {
    const view = this.view();
    return view.containerEl.querySelector<HTMLElement>(view.getMode() === "preview" ? ".markdown-preview-view" : ".cm-scroller");
  }
  capture(): ScrollPosition | null {
    const view = this.view(), container = this.container();
    const scroll = view.currentMode?.getScroll();
    if (!container?.clientHeight || !Number.isFinite(scroll) || scroll === null || scroll < 0) return null;
    const lines = view.currentMode.get().split("\n");
    let line = Math.min(Math.floor(scroll), lines.length - 1);
    // Blank lines are ambiguous. Use a nearby nonempty source line and retain the displacement.
    for (let i = 0; i < 3 && line > 0 && !lines[line].trim(); i++) line--;
    return {
      top: container.scrollTop, left: container.scrollLeft,
      markdown: { scroll, line, hash: fingerprint(lines[line]), context: fingerprint(lines.slice(Math.max(0, line - 1), line + 2).join("\n")) },
    };
  }
  async restore(saved: ScrollPosition, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const view = this.view(), anchor = saved.markdown;
    if (!anchor) return;
    const lines = view.currentMode.get().split("\n");
    const contextAt = (line: number) => fingerprint(lines.slice(Math.max(0, line - 1), line + 2).join("\n"));
    let best = anchor.line;
    // The common unchanged case hashes only three lines, even in very large notes.
    if (fingerprint(lines[best] ?? "") !== anchor.hash || contextAt(best) !== anchor.context) {
      best = -1;
      let exact = false;
      for (let i = 0; i < lines.length; i++) {
        if (fingerprint(lines[i]) !== anchor.hash) continue;
        const matches = contextAt(i) === anchor.context;
        if (best < 0 || (matches && !exact) || (matches === exact && Math.abs(i - anchor.line) < Math.abs(best - anchor.line))) {
          best = i; exact = matches;
        }
      }
    }
    const scroll = Math.max(0, Math.min(lines.length - 0.01,
      best < 0 ? anchor.scroll : best + anchor.scroll - anchor.line));
    const mode = view.currentMode;
    const apply = () => {
      view.setEphemeralState({ scroll });
      const container = this.container();
      if (container) container.scrollLeft = saved.left;
    };
    // Reading view already waits for rendered sections. Editing view must first
    // bring the target into view so CodeMirror can measure its wrapped lines.
    apply();
    const cm = (mode as unknown as { cm?: EditorView }).cm;
    if (view.getMode() !== "source" || !cm?.requestMeasure) return;
    const measured = new Promise<void>(resolve => cm.requestMeasure({ read: () => 0, write: () => resolve() }));
    if (await renderReady(this.leaf, signal, measured) && view.currentMode === mode) apply();
  }
}
