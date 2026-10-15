import { renderReady } from "./renderReady";
import type { WorkspaceLeaf } from "obsidian";
import type { ScrollPosition } from "./state";

export interface ScrollAdapter {
  capture(): ScrollPosition | null;
  restore(position: ScrollPosition, signal: AbortSignal): void | Promise<void>;
}

/** Obsidian's PDF wrapper is private; keep its small compatibility surface here. */
interface PdfView {
  viewer?: { child?: { pdfViewer?: {
    isInitialViewSet?: boolean;
    applySubpath?(subpath: string): void;
    pdfViewer?: {
      currentScaleValue?: string | number;
      update?(): void;
      pagesPromise?: Promise<unknown>;
      pagesCount?: number;
      container?: HTMLElement;
      getPageView?(index: number): {
        div: HTMLElement;
        viewport: { convertToViewportPoint(x: number, y: number): [number, number] };
      };
      _location?: { pageNumber: number; left: number; top: number };
    };
  } } };
}

export class PdfScrollAdapter implements ScrollAdapter {
  constructor(private leaf: WorkspaceLeaf) {}
  private viewer() { return (this.leaf.view as unknown as PdfView).viewer?.child?.pdfViewer; }
  capture(): ScrollPosition | null {
    const viewer = this.viewer(), pdf = viewer?.pdfViewer;
    if (!this.leaf.view.containerEl.clientHeight || !viewer?.isInitialViewSet) return null;
    pdf?.update?.(); // Flush the last scroll before a same-tick workspace switch.
    const location = pdf?._location;
    // The native location is the first visible page in PDF coordinates, independent
    // of pane width, page borders, rotation, and which page is most visible.
    if (!location || !Number.isInteger(location.pageNumber) || location.pageNumber < 1 ||
        !Number.isFinite(location.left) || !Number.isFinite(location.top)) return null;
    return {
      top: 0, left: 0, page: location.pageNumber,
      pdfPoint: { x: location.left, y: location.top }, pdfScale: pdf.currentScaleValue,
    };
  }
  async restore(position: ScrollPosition, signal: AbortSignal): Promise<void> {
    const viewer = this.viewer();
    if (signal.aborted || !position.page || !viewer?.applySubpath) return;
    const scale = position.pdfScale ?? "auto";
    // PDF.js URL zoom values use percentages; named zoom modes remain symbolic.
    const zoom = Number.isFinite(Number(scale)) ? Number(scale) * 100 : scale;
    const point = position.pdfPoint;
    const destination = `page=${position.page}&zoom=${zoom}${point ? `,${point.x},${point.y}` : ""}`;
    // PDF.js can replay initial history after page sizes resolve. Let its queued
    // work finish before applying this workspace's destination.
    if (await renderReady(this.leaf, signal, Promise.resolve(viewer.pdfViewer?.pagesPromise))) {
      const pages = viewer.pdfViewer?.pagesCount;
      if (pages !== undefined && position.page > pages) return;
      const pdf = viewer.pdfViewer;
      if (!this.leaf.view.containerEl.clientHeight) return;
      viewer.applySubpath(destination);
      const page = pdf?.getPageView?.(position.page - 1), container = pdf?.container;
      if (point && page && container) {
        // Obsidian's navigation omits page borders, but PDF.js's saved location
        // includes them. Invert that location directly; never add a fixed offset.
        const [x, y] = page.viewport.convertToViewportPoint(point.x, point.y);
        container.scrollLeft = page.div.offsetLeft + page.div.clientLeft + x;
        container.scrollTop = page.div.offsetTop + page.div.clientTop + y;
      }
      // A tab can hide before the scroll event's animation frame. Publish the
      // final location now so native resize/zoom cannot replay the previous page.
      pdf?.update?.();
    }
  }
}
