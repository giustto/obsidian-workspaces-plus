import type { WorkspaceLeaf } from "obsidian";
import { browserRuntime } from "./browserRuntime";
import type { ScrollPosition } from "./state";

export interface ScrollAdapter {
  capture(): Promise<ScrollPosition | null>;
  restore(position: ScrollPosition, signal: AbortSignal): Promise<void>;
  dispose(): void;
}

/** Never wait indefinitely for an unresponsive guest process. */
export async function bounded<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: number;
  try { return await Promise.race([promise, new Promise<T>(resolve => { timer = window.setTimeout(() => resolve(fallback), ms); })]); }
  catch { return fallback; }
  finally { window.clearTimeout(timer); }
}

interface GuestView extends HTMLElement {
  executeJavaScript(code: string): Promise<unknown>;
  getURL(): string;
  isLoading(): boolean;
}

export class SurfingScrollAdapter implements ScrollAdapter {
  private guest: GuestView;
  private disposed = false;
  private token = Math.random().toString(36).slice(2);
  constructor(private leaf: WorkspaceLeaf, private resource: string) {}
  private getGuest(): GuestView | null {
    const element = this.leaf.view?.containerEl?.querySelector<GuestView>("webview");
    return typeof element?.executeJavaScript === "function" ? element : null;
  }
  private async execute(action: "capture" | "restore" | "cancel", saved?: ScrollPosition, expires?: number): Promise<unknown> {
    const guest = this.getGuest();
    if (!guest || this.disposed) return null;
    this.guest = guest;
    return guest.executeJavaScript(`(${browserRuntime.toString()})(${JSON.stringify(action)},${JSON.stringify(this.token)},${JSON.stringify(saved)},${JSON.stringify(this.resource)},${expires ?? 0})`);
  }
  async capture(): Promise<ScrollPosition | null> {
    const result = await bounded(this.execute("capture"), 600, null) as { position?: ScrollPosition; resource?: string };
    return result?.resource === this.resource ? result.position ?? null : null;
  }
  async restore(position: ScrollPosition, signal: AbortSignal): Promise<void> {
    this.token = Math.random().toString(36).slice(2);
    // Install host guards before readiness: clicking Surfing's address bar must also cancel.
    const root = this.leaf.view.containerEl;
    let stopped = false;
    let running = false;
    let complete: () => void;
    const done = new Promise<void>(resolve => { complete = resolve; });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      void bounded(this.execute("cancel"), 500, null);
      complete();
    };
    const user = (event: Event) => { if (event.isTrusted) stop(); };
    const ready = () => {
      if (stopped || running || signal.aborted) return;
      const guest = this.getGuest();
      if (!guest) return;
      try { if (guest.isLoading()) return; } catch { return; }
      running = true;
      void bounded(this.execute("restore", position, Date.now() + 30000), 31000, null).then(() => complete());
    };
    const guest = this.getGuest();
    const navigation = () => { if (running) stop(); };
    const events = ["dom-ready", "did-finish-load", "did-stop-loading"];
    const inputEvents = ["wheel", "touchstart", "pointerdown", "keydown"];
    events.forEach(name => guest?.addEventListener(name, ready));
    guest?.addEventListener("did-start-navigation", navigation);
    guest?.addEventListener("did-navigate-in-page", navigation);
    inputEvents.forEach(name => root.addEventListener(name, user, { capture: true, passive: true }));
    signal.addEventListener("abort", stop, { once: true });
    const retry = window.setInterval(ready, 300); // Bounded readiness fallback for rebuilt/missed webviews.
    const timeout = window.setTimeout(stop, 45000);
    try {
      if (signal.aborted) stop(); else ready();
      await done;
    } finally {
      window.clearInterval(retry); window.clearTimeout(timeout);
      events.forEach(name => guest?.removeEventListener(name, ready));
      guest?.removeEventListener("did-start-navigation", navigation);
      guest?.removeEventListener("did-navigate-in-page", navigation);
      inputEvents.forEach(name => root.removeEventListener(name, user, true));
      signal.removeEventListener("abort", stop);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    // executeJavaScript can throw synchronously after Obsidian detaches a webview.
    // Mark disposed first and enter a promise boundary before touching the guest.
    this.disposed = true;
    const guest = this.guest ?? this.getGuest();
    if (guest) void bounded(Promise.resolve().then(() =>
      guest.executeJavaScript(`(${browserRuntime.toString()})("cancel",${JSON.stringify(this.token)})`)
    ), 500, null);
  }
}

/** All native PDF/PDF.js private dependencies are isolated here. Verified against installed app.js. */
interface PdfView {
  viewer?: { child?: { pdfViewer?: {
    dom?: { viewerContainerEl?: HTMLElement };
    pdfViewer?: {
      currentPageNumber: number;
      pagesCount: number;
      currentScaleValue?: string | number;
      getPageView(index: number): {
        div?: HTMLElement;
        viewport?: {
          convertToPdfPoint(x: number, y: number): number[];
          convertToViewportPoint(x: number, y: number): number[];
        };
      };
    };
  } } };
}
export class PdfScrollAdapter implements ScrollAdapter {
  private protected = false;
  private release: () => void = () => {};
  constructor(private leaf: WorkspaceLeaf) {}
  private viewer() { return (this.leaf.view as unknown as PdfView).viewer?.child?.pdfViewer; }
  async capture(): Promise<ScrollPosition | null> {
    const viewer = this.viewer(), pdf = viewer?.pdfViewer, container = viewer?.dom?.viewerContainerEl;
    if (this.protected || !container?.clientHeight || !pdf?.pagesCount) return null;
    // PDF.js's current page can be the most visible page rather than the page at
    // the top reading line. Prefer the preceding page when that line still intersects it.
    const frame = container.getBoundingClientRect();
    const viewportTop = frame.top + (container.clientTop || 0);
    let pageNumber = pdf.currentPageNumber;
    let view = pdf.getPageView(pageNumber - 1);
    for (let i = 0; i < 3 && pageNumber > 1 && view?.div?.getBoundingClientRect().top > viewportTop; i++) {
      const previous = pdf.getPageView(pageNumber - 2);
      if (!previous?.div || previous.div.getBoundingClientRect().bottom <= viewportTop) break;
      view = previous;
      pageNumber--;
    }
    const page = view?.div;
    if (!page) return null;
    const rect = page.getBoundingClientRect();
    const position: ScrollPosition = {
      page: pageNumber, offset: frame.top - rect.top,
      top: container.scrollTop, left: container.scrollLeft,
    };
    if (view.viewport?.convertToPdfPoint) {
      const point = view.viewport.convertToPdfPoint(
        Math.max(0, frame.left + (container.clientLeft || 0) - rect.left - (page.clientLeft || 0)),
        viewportTop - rect.top - (page.clientTop || 0)
      );
      if (point.every(Number.isFinite)) position.pdfPoint = { x: point[0], y: point[1] };
    }
    if (pdf.currentScaleValue !== undefined) position.pdfScale = pdf.currentScaleValue;
    return position;
  }
  async restore(position: ScrollPosition, signal: AbortSignal): Promise<void> {
    this.protected = true;
    const root = this.leaf.view.containerEl;
    let finish: () => void;
    let timer: number, timeout: number;
    let resize: ResizeObserver;
    let stable = 0, last = NaN;
    let navigated = false;
    let stopped = false;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const stop = () => {
      if (stopped) return;
      stopped = true;
      window.clearInterval(timer); window.clearTimeout(timeout); resize?.disconnect();
      finish();
    };
    const user = (event: Event) => {
      if (event.isTrusted) { this.protected = false; stop(); this.release(); }
    };
    const events = ["wheel", "touchstart", "pointerdown", "keydown"];
    events.forEach(name => root.addEventListener(name, user, { capture: true, passive: true }));
    this.release = () => events.forEach(name => root.removeEventListener(name, user, true));
    const apply = () => {
      if (stopped) return;
      if (signal.aborted) return stop();
      const viewer = this.viewer(), pdf = viewer?.pdfViewer, container = viewer?.dom?.viewerContainerEl;
      if (!container?.clientHeight || !pdf?.pagesCount || position.page > pdf.pagesCount) return;
      if (!resize) { resize = new ResizeObserver(step); resize.observe(container); }
      if (position.pdfScale !== undefined && pdf.currentScaleValue !== undefined &&
          String(pdf.currentScaleValue) !== String(position.pdfScale)) pdf.currentScaleValue = position.pdfScale;
      const view = pdf.getPageView(position.page - 1);
      const page = view?.div;
      if (!page) return;
      if (!navigated) {
        if (pdf.currentPageNumber !== position.page) pdf.currentPageNumber = position.page;
        navigated = true;
      }
      const rect = page.getBoundingClientRect(), frame = container.getBoundingClientRect();
      let top = container.scrollTop + rect.top - frame.top + (position.offset ?? 0);
      let left = position.left;
      if (position.pdfPoint && view.viewport?.convertToViewportPoint) {
        const point = view.viewport.convertToViewportPoint(position.pdfPoint.x, position.pdfPoint.y);
        top = container.scrollTop + rect.top + (page.clientTop || 0) + point[1] - frame.top - (container.clientTop || 0);
        left = container.scrollLeft + rect.left + (page.clientLeft || 0) + point[0] - frame.left - (container.clientLeft || 0);
      }
      // A viewport can be taller/wider than the remaining page. Clamp real pixel
      // coordinates to the reachable range so a valid restore can finish there.
      if (Number.isFinite(container.scrollHeight)) top = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
      if (Number.isFinite(container.scrollWidth)) left = Math.max(0, Math.min(left, container.scrollWidth - container.clientWidth));
      container.scrollTo({ top, left, behavior: "instant" });
      if (Math.abs(container.scrollTop - top) < 2 && Math.abs(last - top) < 1) stable++;
      else stable = 0;
      last = top;
      if (page.dataset && !page.dataset.loaded) stable = 0;
      if (stable >= 4) { this.protected = false; stop(); }
    };
    const step = () => { try { apply(); } catch { stop(); } };
    signal.addEventListener("abort", stop, { once: true });
    timer = window.setInterval(step, 200);
    timeout = window.setTimeout(stop, 12000);
    try { if (signal.aborted) stop(); else step(); await done; }
    finally {
      window.clearInterval(timer); window.clearTimeout(timeout); resize?.disconnect();
      signal.removeEventListener("abort", stop);
      if (!this.protected || signal.aborted) this.release();
    }
  }
  dispose(): void { this.release(); }
}
