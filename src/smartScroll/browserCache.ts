import { around } from "monkey-around";
import type { View, ViewCreator, WorkspaceLeaf } from "obsidian";
import type WorkspacesPlus from "../main";

// Obsidian's private factory lookup and View.open/close are confined to this module.
interface Registry { getViewCreatorByType(type: string): ViewCreator | undefined }
interface RetainedView extends View { open(parent: HTMLElement): Promise<void>; close(): Promise<void> }
interface Entry {
  key: string;
  workspace: string;
  view: RetainedView;
  host: HTMLElement;
  slot?: HTMLElement;
  opened: boolean;
  active: boolean;
  disposed: boolean;
  restoreMethods: () => void;
  close: () => Promise<void>;
  focus: () => void;
}

/**
 * An in-memory cache of real Surfing views. The webview is attached exactly
 * once to a permanent host; moving a webview between DOM parents destroys its guest.
 * A lightweight slot in the native leaf supplies the host's position and visibility.
 */
export class BrowserSessionCache {
  private entries = new Map<string, Entry>();
  private resumed = new WeakSet<WorkspaceLeaf>();
  private workspace = "";
  private switching = false;
  private enabled = false;
  private undoRegistry: () => void;
  private observer: ResizeObserver;
  private frame = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(private plugin: WorkspacesPlus) {}
  selectWorkspace(name: string): void { this.workspace = name; }
  consumeResumed(leaf: WorkspaceLeaf): boolean {
    const resumed = this.resumed.has(leaf);
    this.resumed.delete(leaf);
    return resumed;
  }
  start(): void {
    if (this.enabled || this.plugin.app.isMobile) return;
    const registry = this.plugin.app.viewRegistry as unknown as Registry;
    if (typeof registry?.getViewCreatorByType !== "function") return;
    this.enabled = true;
    this.observer = new ResizeObserver(this.schedule);
    this.plugin.registerDomEvent(window, "resize", this.schedule);
    this.plugin.registerEvent(this.plugin.app.workspace.on("layout-change", this.schedule));
    this.plugin.registerEvent(this.plugin.app.workspace.on("active-leaf-change", this.schedule));
    this.undoRegistry = around(registry, {
      getViewCreatorByType: original => type => {
        const create = original.call(registry, type) as ViewCreator | undefined;
        if (!create || type !== "surfing-view" || !this.enabled || !this.workspace) return create;
        return leaf => this.obtain(leaf, create);
      },
    });
  }
  async transition(name: string, apply: () => Promise<void>, isCurrent: () => boolean): Promise<void> {
    // Only one native layout reconstruction may own the factory context at a time.
    const run = async () => {
      if (!isCurrent()) return;
      if (!this.enabled) return apply();
      this.workspace = name;
      this.switching = true;
      try { await apply(); }
      finally { this.switching = false; this.schedule(); }
    };
    this.queue = this.queue.catch(() => {}).then(run);
    return this.queue;
  }
  rename(oldName: string, name: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.workspace !== oldName) continue;
      this.entries.delete(entry.key);
      entry.workspace = name;
      entry.key = JSON.stringify([name, (entry.view.leaf as unknown as { id: string }).id]);
      this.entries.set(entry.key, entry);
    }
    if (this.workspace === oldName) this.workspace = name;
  }
  remove(name: string): void {
    for (const entry of this.entries.values()) {
      if (entry.workspace !== name) continue;
      if (entry.active) entry.workspace = ""; // Let its native close release it during the switch.
      else void this.destroy(entry);
    }
  }
  private obtain(leaf: WorkspaceLeaf, create: ViewCreator): View {
    const id = (leaf as unknown as { id: string }).id;
    if (!id) return create(leaf);
    const key = JSON.stringify([this.workspace, id]);
    const cached = this.entries.get(key);
    if (cached && !cached.active && !cached.disposed) {
      cached.view.leaf = leaf;
      cached.active = true;
      this.resumed.add(leaf);
      return cached.view;
    }
    if (cached?.active) return create(leaf); // Duplicate/colliding layout ID: use native behavior.
    const view = create(leaf) as RetainedView;
    if (typeof view.open !== "function" || typeof view.close !== "function") return view;
    const originalClose = view.close.bind(view) as () => Promise<void>;
    const host = document.body.createDiv({ cls: "workspace-leaf workspaces-plus-browser-host is-cache-hidden" });
    const entry: Entry = { key, workspace: this.workspace, view, host, opened: false,
      active: true, disposed: false, restoreMethods: () => {},
      close: originalClose, focus: () => { if (entry.active) this.plugin.app.workspace.setActiveLeaf(view.leaf, { focus: false }); } };
    host.addEventListener("pointerdown", entry.focus, true);
    host.addEventListener("focusin", entry.focus, true);
    entry.restoreMethods = around(view, {
      open: original => async parent => {
        entry.slot?.remove();
        entry.slot = parent.createDiv({ cls: "workspace-leaf-content workspaces-plus-browser-slot" });
        entry.slot.dataset.type = "surfing-view";
        this.observer.observe(entry.slot);
        entry.active = true;
        this.position(entry);
        if (!entry.opened) {
          await original.call(view, host);
          entry.opened = true;
        }
        this.schedule();
      },
      close: original => async () => {
        entry.close = () => original.call(view) as Promise<void>;
        if (this.enabled && this.switching && !entry.disposed && entry.workspace) {
          entry.active = false;
          if (entry.slot) this.observer.unobserve(entry.slot);
          entry.slot?.remove(); entry.slot = undefined;
          host.addClass("is-cache-hidden"); host.inert = true;
          return;
        }
        await this.destroy(entry);
      },
      setState: original => async (state, result) => {
        const url = state && typeof state === "object" ? (state as { url?: unknown }).url : undefined;
        if (entry.opened && typeof url === "string" && view.getState().url === url) return;
        this.resumed.delete(view.leaf);
        await original.call(view, state, result);
      },
    });

    this.entries.set(key, entry);
    return view;
  }
  private schedule = () => {
    if (!this.enabled || this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      for (const entry of this.entries.values()) if (entry.active) this.position(entry);
    });
  };
  private position(entry: Entry): void {
    const rect = entry.slot?.getBoundingClientRect();
    const shown = entry.active && entry.slot?.isConnected && rect && rect.width > 0 && rect.height > 0;
    entry.host.toggleClass("is-cache-hidden", !shown);
    entry.host.inert = !shown;
    if (!shown) return;
    entry.host.setCssProps({ "--wpp-left": `${rect.left}px`, "--wpp-top": `${rect.top}px`,
      "--wpp-width": `${rect.width}px`, "--wpp-height": `${rect.height}px` });
  }
  private async destroy(entry: Entry, alreadyClosed = false): Promise<void> {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.restoreMethods();
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.slot) this.observer?.unobserve(entry.slot);
    entry.slot?.remove();
    entry.host.removeEventListener("pointerdown", entry.focus, true);
    entry.host.removeEventListener("focusin", entry.focus, true);
    try { if (!alreadyClosed) await entry.close(); } catch { /* A guest may already have been destroyed by Surfing. */ }
    finally { entry.host.remove(); }
  }
  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.undoRegistry?.();
    this.observer.disconnect();
    window.cancelAnimationFrame(this.frame); this.frame = 0;
    window.removeEventListener("resize", this.schedule);
    this.plugin.app.workspace.off("layout-change", this.schedule);
    this.plugin.app.workspace.off("active-leaf-change", this.schedule);
    const rebuilds = [...this.entries.values()].map(async entry => {
      if (!entry.active || entry.view.leaf.view !== entry.view) return this.destroy(entry);
      // Recreate active native views when disabled/unloaded, restoring normal DOM ownership.
      const leaf = entry.view.leaf, state = leaf.getViewState();
      entry.restoreMethods();
      let closed = false;
      try { await leaf.setViewState({ type: "empty" }); closed = true; await leaf.setViewState(state); }
      catch { /* Closing Obsidian or Surfing can make rebuilding unnecessary. */ }
      finally { await this.destroy(entry, closed); }
    });
    void Promise.all(rebuilds);
    this.entries.clear();
  }
}
