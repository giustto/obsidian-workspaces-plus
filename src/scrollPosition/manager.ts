import type WorkspacesPlus from "../main";
import { Component } from "obsidian";
import type { WorkspaceLeaf, WorkspaceLayoutNode } from "obsidian";
import { MarkdownScrollAdapter } from "./markdownAdapter";
import { PdfScrollAdapter } from "./adapters";
import type { ScrollAdapter } from "./adapters";
import { matchTab, ScrollStateStorage } from "./state";
import type { TabState } from "./state";

interface Tab { leaf: WorkspaceLeaf; identity: Omit<TabState, "position">; adapter: ScrollAdapter }

export class ScrollPositionManager {
  private storage: ScrollStateStorage;
  private controller = new AbortController();
  private generation = 0;
  private current = "";
  private transitioning = true;
  private stopped = false;
  private events = new Component();
  private pending = new Set<WorkspaceLeaf>();
  private deferred = new Map<WorkspaceLeaf, () => Promise<void>>();
  private onActiveLeaf = (leaf: WorkspaceLeaf | null) => {
    const restore = leaf && this.deferred.get(leaf);
    if (restore && this.enabled && !this.transitioning) {
      this.deferred.delete(leaf);
      void restore();
    }
  };
  private debounce: number;
  private started = false;
  private scrollListener = () => {
    window.clearTimeout(this.debounce);
    if (this.enabled && !this.transitioning) this.debounce = window.setTimeout(() => { void this.checkpoint(); }, 800);
  };
  constructor(private plugin: WorkspacesPlus) {
    // Separate file avoids races with the many existing saveData(settings) call sites.
    const path = `${plugin.manifest.dir}/scroll-positions.json`;
    this.storage = new ScrollStateStorage(
      async () => {
        try { return await plugin.app.vault.adapter.read(path); }
        catch { return plugin.app.vault.adapter.read(`${plugin.manifest.dir}/smart-scroll.json`); }
      },
      data => plugin.app.vault.adapter.write(path, data)
    );
    plugin.register(() => this.stop());
  }
  async load(): Promise<void> { await this.storage.load(); }
  private get enabled() { return this.plugin.settings.scrollPositionRestoration && !this.stopped; }
  start(): void {
    if (!this.enabled || this.started) return;
    this.started = true;
    this.stopped = false;
    this.events.load();
    this.events.registerInterval(window.setInterval(() => { void this.checkpoint(); }, 10000));
    this.events.registerEvent(this.plugin.app.workspace.on("active-leaf-change", this.onActiveLeaf));
    this.events.registerDomEvent(document, "scroll", this.scrollListener, true);
  }
  async configure(): Promise<void> {
    this.stop();
    this.stopped = false;
    if (!this.enabled) return;
    this.controller = new AbortController();
    this.start();
    if (!this.transitioning) await this.activate(this.current || this.plugin.workspacePlugin.activeWorkspace);
  }
  private refreshTabs(): Tab[] {
    const slots = new Map<string, string>();
    const layout = this.plugin.app.workspace.getLayout() as unknown as Record<string, WorkspaceLayoutNode>;
    const visit = (node: WorkspaceLayoutNode, path: string) => {
      if (!node) return;
      if (node.type === "leaf" && node.id) slots.set(node.id, path);
      node.children?.forEach((child, i) => visit(child, `${path}/${i}`));
    };
    for (const key of ["main", "left", "right", "floating"]) visit(layout[key], key);
    const found: Tab[] = [];
    this.plugin.app.workspace.iterateAllLeaves(leaf => {
      const state = leaf.getViewState();
      let type: TabState["type"], resource: string;
      if ((state.type === "pdf" || state.type === "markdown") && typeof state.state?.file === "string") {
        type = state.type; resource = state.state.file;
      } else return;
      const id = (leaf as unknown as { id: string }).id;
      const slot = slots.get(id);
      if (!id || !slot) return; // Never collapse unidentifiable duplicate leaves.
      found.push({ leaf, identity: { id, slot, type, resource }, adapter:
        type === "pdf" ? new PdfScrollAdapter(leaf) : new MarkdownScrollAdapter(leaf) });
    });
    return found;
  }
  private async capture(name: string): Promise<void> {
    if (!this.enabled || !name) return;
    // Read every view synchronously before switching layouts. Only disk I/O yields,
    // so an older capture cannot overwrite a newer capture, rename, or deletion.
    const next = this.storage.get(name).slice();
    for (const tab of this.refreshTabs()) {
      if (this.pending.has(tab.leaf)) continue;
      try {
        const position = tab.adapter.capture();
        if (!position) continue;
        const previous = matchTab(next, tab.identity);
        if (previous) next.splice(next.indexOf(previous), 1);
        next.push({ ...tab.identity, position });
      } catch { /* A disappearing/unsupported view must not block other tabs. */ }
    }
    this.storage.set(name, next);
    await this.storage.flush();
  }
  private async checkpoint(): Promise<void> {
    if (!this.enabled || this.transitioning) return;
    try { await this.capture(this.current); }
    catch { /* A view can disappear during capture; never interrupt normal workspace use. */ }
  }
  /** Called synchronously before activeWorkspace changes. No capture of a half-applied target. */
  beginSwitch(): void {
    // Snapshot immediately; serialized writes can finish without delaying the switch.
    void this.checkpoint();
    this.transitioning = true;
    this.controller.abort();
    this.controller = new AbortController();
    ++this.generation;
    this.pending.clear();
    this.deferred.clear();
  }
  async activate(name: string): Promise<void> {
    this.current = name;
    this.transitioning = false;
    if (!this.enabled || !name) return;
    const generation = this.generation;
    const signal = this.controller.signal;
    await Promise.all(this.refreshTabs().map(async tab => {
      const saved = matchTab(this.storage.get(name), tab.identity);
      if (!saved) return;
      this.pending.add(tab.leaf);
      const restore = async () => {
        try {
          if (tab.leaf.isDeferred) await tab.leaf.loadIfDeferred();
          if (signal.aborted || generation !== this.generation || !this.enabled) return;
          // A leaf may have navigated to another file while deferred loading ran.
          const state = tab.leaf.getViewState();
          if (state.type !== tab.identity.type || state.state?.file !== tab.identity.resource) return;
          await tab.adapter.restore(saved.position, signal);
        } catch { /* Unsupported/changed private API: retain saved state and layout. */ }
        finally {
          if (generation === this.generation) {
            // The user may select another tab while its geometry is loading.
            // Keep the saved position pending until this view is visible again.
            if (!tab.leaf.view.containerEl.clientHeight) this.deferred.set(tab.leaf, restore);
            else this.pending.delete(tab.leaf);
          }
        }
      };
      if (tab.leaf.view.containerEl.clientHeight === 0) this.deferred.set(tab.leaf, restore);
      else await restore();
    }));
  }
  rename(oldName: string, name: string): void {
    this.storage.rename(oldName, name);
    if (this.current === oldName) this.current = name;
    void this.storage.flush();
  }
  remove(name: string): void { this.storage.remove(name); void this.storage.flush(); }
  shutdown(): void {
    // Obsidian does not await onunload. Final capture is best effort; checkpoints bound loss.
    const capture = this.enabled && !this.transitioning ? this.capture(this.current) : Promise.resolve();
    this.stop();
    void capture.catch(() => {});
  }
  stop(): void {
    ++this.generation;
    this.stopped = true;
    this.started = false;
    this.events.unload();
    this.controller.abort();
    window.clearTimeout(this.debounce);
    this.pending.clear(); this.deferred.clear();
  }
}
