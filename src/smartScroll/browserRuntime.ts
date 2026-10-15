import type { Locator, ScrollPosition } from "./state";

/** Self-contained, bundled function injected into Surfing's guest document. No page text is read. */
export function browserRuntime(
  action: "capture" | "restore" | "cancel", token: string, saved?: ScrollPosition,
  expected?: string, expires = 0
): unknown {
  interface Session { token: string; cleanup: () => void; protected: boolean; interacted: boolean; tracking?: boolean; last?: Element }
  const host = window as unknown as { __workspacesPlusScroll?: Session };
  const hash = (value: string) => {
    let a = 2166136261, b = 5381;
    for (let i = 0; i < value.length; i++) {
      a = Math.imul(a ^ value.charCodeAt(i), 16777619);
      b = Math.imul(b, 33) ^ value.charCodeAt(i);
    }
    return (a >>> 0).toString(16) + ":" + (b >>> 0).toString(16);
  };
  const attributes = ["data-message-id", "data-message-uuid", "data-turn-id", "data-turn-key", "post-id", "comment-id",
    "data-item-id", "data-id", "data-fullname", "permalink", "id", "data-testid"];
  const root = document.scrollingElement as HTMLElement;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const scrollable = (el: HTMLElement) => el === root ||
    (el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY));
  const locate = (el: Element, base: Element): Locator => {
    for (const attribute of attributes) {
      const value = el.getAttribute(attribute);
      if (value && value.length <= 256) return { attribute, hash: hash(value) };
    }
    const path: number[] = [];
    let node = el;
    while (node !== base && node.parentElement && path.length < 32) {
      path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node) as number);
      node = node.parentElement;
    }
    return node === base ? { path } : {};
  };
  const find = (locator: Locator, base: Element): HTMLElement | null => {
    if (!locator) return null;
    if (locator.attribute && locator.hash) {
      if (!attributes.includes(locator.attribute)) return null;
      // Search identifiers, not the first N arbitrary descendants. A long message
      // can contain thousands of elements before the next identifiable turn.
      if (hash(base.getAttribute(locator.attribute) ?? "") === locator.hash) return base as HTMLElement;
      const matches = base.querySelectorAll<HTMLElement>(`[${locator.attribute}]`);
      for (let i = 0; i < Math.min(matches.length, 6000); i++) {
        if (hash(matches[i].getAttribute(locator.attribute)) === locator.hash) return matches[i];
      }
      return null;
    }
    if (!locator.path) return null;
    let node = base;
    for (const index of locator.path) { node = node.children[index]; if (!node) return null; }
    return node as HTMLElement;
  };
  const chooseContainer = (): HTMLElement => {
    const last = host.__workspacesPlusScroll?.last as HTMLElement;
    if (last?.isConnected && visible(last) && scrollable(last)) return last;
    const candidates = new Set<HTMLElement>([root]);
    for (const y of [80, 200, Math.max(80, innerHeight / 2)]) {
      for (const hit of document.elementsFromPoint(innerWidth / 2, y)) {
        for (let el = hit as HTMLElement; el; el = el.parentElement) {
          if (scrollable(el) && visible(el)) candidates.add(el);
        }
      }
    }
    let best = root, score = -1;
    candidates.forEach(el => {
      const r = el === root ? { width: innerWidth, height: innerHeight } : el.getBoundingClientRect();
      // Central large content wins over narrow sidebars; an actually scrolled pane gets preference.
      const range = Math.max(0, el.scrollHeight - el.clientHeight);
      const value = r.width * Math.min(r.height, innerHeight) * (el.scrollTop > 0 ? 2 : 1) *
        Math.min(4, range / Math.max(1, el.clientHeight));
      if (value > score) { score = value; best = el; }
    });
    return best;
  };
  if (action === "cancel") {
    const session = host.__workspacesPlusScroll;
    if (session?.token !== token) return null;
    session.interacted = true;
    session.cleanup();
    delete host.__workspacesPlusScroll;
    return null;
  }
  if (!root || (expected && hash(location.href) !== expected)) return null;
  const track = (session: Session) => {
    if (session.tracking) return;
    session.tracking = true;
    const scroll = (event: Event) => {
      const el = event.target === document ? root : event.target as HTMLElement;
      if (el?.nodeType === 1 && scrollable(el) && !el.closest("nav,aside")) session.last = el;
    };
    const cleanup = session.cleanup;
    document.addEventListener("scroll", scroll, { capture: true, passive: true });
    session.cleanup = () => { document.removeEventListener("scroll", scroll, true); cleanup(); };
  };
  if (action === "capture") {
    let session = host.__workspacesPlusScroll;
    if (!session) {
      session = { token, protected: false, interacted: false, cleanup: () => {} };
      host.__workspacesPlusScroll = session;
    }
    track(session);
    if (session?.protected && !session.interacted) return null;
    const container = chooseContainer();
    const r = container === root ? { top: 0, left: 0, width: innerWidth } : container.getBoundingClientRect();
    if (!visible(container)) return null;
    const position: ScrollPosition = { top: container.scrollTop, left: container.scrollLeft,
      container: locate(container, document.documentElement) };
    // Sample beyond sticky page headers and score stable content identifiers
    // across ancestors. A toolbar's ID must not beat the actual message/post.
    const hits: Element[] = [];
    for (const y of [48, 96, 160]) {
      for (const x of [r.left + r.width / 2, r.left + r.width / 3]) {
        hits.push(...document.elementsFromPoint(x, Math.max(0, r.top) + y));
      }
    }
    let structural: Element, best: Element, bestLocator: Locator, score = -Infinity;
    const seen = new Set<Element>();
    for (const hit of hits) {
      if (!container.contains(hit) || hit === container || hit.closest("input,textarea,[contenteditable=true],nav,aside,header")) continue;
      structural = structural ?? hit;
      for (let el = hit; el && el !== container; el = el.parentElement) {
        if (seen.has(el)) continue;
        seen.add(el);
        const style = getComputedStyle(el);
        if (style.position === "fixed" || style.position === "sticky") continue;
        const locator = locate(el, container), rect = el.getBoundingClientRect();
        if (!locator.attribute || rect.width < 80 || rect.height <= 0) continue;
        if ((locator.attribute === "id" || locator.attribute === "data-testid") &&
            (rect.height > Math.max(container.clientHeight * 3, 1600) || /^[:]/.test(el.id ?? ""))) continue;
        const priority = locator.attribute === "id" ? 20 : locator.attribute === "data-testid" ? 10 : 100;
        const value = priority - Math.abs(rect.top - r.top - 48) / 10000;
        if (value > score) { score = value; best = el; bestLocator = locator; }
      }
    }
    if (best) {
      position.anchor = bestLocator;
      position.offset = best.getBoundingClientRect().top - r.top;
      return { position, resource: hash(location.href) };
    }
    if (structural) {
      position.anchor = locate(structural, container);
      position.offset = structural.getBoundingClientRect().top - r.top;
    }
    return { position, resource: hash(location.href) };
  }
  if (!saved || Date.now() > expires) return null;
  if (host.__workspacesPlusScroll) {
    host.__workspacesPlusScroll.interacted = true;
    host.__workspacesPlusScroll.cleanup();
  }
  return new Promise<boolean>(resolve => {
    let timer: number, interval: number;
    let observer: MutationObserver, resize: ResizeObserver;
    let finished = false, stableSince = 0, lastTop = NaN, attempts = 0;
    const started = Date.now();
    const session: Session = { token, protected: true, interacted: false, cleanup: () => finish(false) };
    host.__workspacesPlusScroll = session;
    const events = ["wheel", "touchstart", "pointerdown", "keydown"];
    const user = (event: Event) => {
      if (!event.isTrusted) return;
      session.interacted = true;
      finish(false);
    };
    const finish = (success: boolean) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer); window.clearInterval(interval);
      observer?.disconnect(); resize?.disconnect();
      events.forEach(name => window.removeEventListener(name, user, true));
      // Retain a tiny interruption marker after failure, but no observer or timer.
      session.protected = !success && !session.interacted;
      if (session.protected) {
        const release = (event: Event) => {
          if (event.isTrusted) { session.interacted = true; session.cleanup(); }
        };
        events.forEach(name => window.addEventListener(name, release, { capture: true, passive: true }));
        session.cleanup = () => events.forEach(name => window.removeEventListener(name, release, true));
      } else session.cleanup = () => {};
      if (success) track(session);
      resolve(success);
    };
    events.forEach(name => window.addEventListener(name, user, { capture: true, passive: true }));
    const StandardScrollStrategy = () => saved.top;
    const DynamicContentScrollStrategy = (container: HTMLElement, anchor: HTMLElement) =>
      container.scrollTop + anchor.getBoundingClientRect().top -
        (container === root ? 0 : container.getBoundingClientRect().top) - (saved.offset ?? 0);
    let observed: HTMLElement, matched: HTMLElement;
    let lookupAfter = 0;
    const apply = () => {
      if (finished) return;
      if (Date.now() > expires || host.__workspacesPlusScroll !== session || hash(location.href) !== expected) return finish(false);
      const container = find(saved.container, document.documentElement) ?? chooseContainer();
      if (!container || !visible(container)) return;
      if (observed !== container) {
        observer?.disconnect(); resize?.disconnect(); observed = container;
        observer = new MutationObserver(schedule);
        observer.observe(container, { childList: true, subtree: true });
        resize = new ResizeObserver(schedule); resize.observe(container);
        if (container.firstElementChild) resize.observe(container.firstElementChild);
      }
      if (matched && (!matched.isConnected || !container.contains(matched))) matched = undefined;
      if (!matched && Date.now() >= lookupAfter) { matched = find(saved.anchor, container); lookupAfter = Date.now() + 900; }
      const anchor = matched;
      const dynamic = !!saved.anchor?.attribute;
      // One absolute seek can reveal virtualized content; never sweep the conversation.
      const fallback = Date.now() - started > 10000;
      const useAnchor = anchor && visible(anchor);
      if (saved.anchor && !useAnchor && attempts > 0 && !fallback) return;
      const top = useAnchor ? DynamicContentScrollStrategy(container, anchor) : StandardScrollStrategy();
      const changed = Math.abs(container.scrollTop - top) > 1 || Math.abs(container.scrollLeft - saved.left) > 1;
      if (changed) { container.scrollTo({ top, left: saved.left, behavior: "instant" }); stableSince = 0; }
      attempts++;
      const reached = Math.abs(container.scrollTop - top) <= 2;
      if (reached && Math.abs(lastTop - top) <= 1) stableSince = stableSince || Date.now();
      else stableSince = 0;
      lastTop = top;
      // DynamicContentScrollStrategy: anchor + layout corrections. StandardScrollStrategy:
      // coordinate/structural fallback with the same bounded readiness and stabilization loop.
      if (reached && stableSince && Date.now() - stableSince > (dynamic ? 1500 : 800) &&
          (!saved.anchor || useAnchor) && Date.now() - started > (dynamic ? 4000 : 2000)) finish(true);
    };
    const step = () => { try { apply(); } catch { finish(false); } };
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(step, 100); };
    interval = window.setInterval(step, 300);
    step();
  });
}
