/* Deterministic DOM/guest and PDF fixtures exercise production code, not copied algorithms.
 * Real Obsidian/Electron compatibility still requires the documented manual checks. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const vm = require("vm");
const cache = new Map();
function load(file, stubs = {}) {
  file = path.resolve(__dirname, "..", file);
  if (cache.has(file)) return cache.get(file);
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const req = id => id in stubs ? stubs[id] : id.startsWith(".") ? load(path.relative(path.join(__dirname, ".."), path.resolve(path.dirname(file), id + ".ts")), stubs) : require(id);
  new Function("require", "module", "exports", code)(req, module, module.exports);
  cache.set(file, module.exports);
  return module.exports;
}
const { fingerprint, matchTab, ScrollStateStorage } = load("src/smartScroll/state.ts");
const { browserRuntime } = load("src/smartScroll/browserRuntime.ts");
const { PdfScrollAdapter, SurfingScrollAdapter } = load("src/smartScroll/adapters.ts");
const { MarkdownScrollAdapter } = load("src/smartScroll/markdownAdapter.ts");
const { BrowserSessionCache } = load("src/smartScroll/browserCache.ts");
const { SmartScrollManager } = load("src/smartScroll/manager.ts");

class Events {
  handlers = new Map();
  addEventListener(name, fn) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name).add(fn); }
  removeEventListener(name, fn) { this.handlers.get(name)?.delete(fn); }
  emit(name, extra = {}) { for (const fn of [...(this.handlers.get(name) || [])]) fn({ target: this, isTrusted: true, ...extra }); }
  count() { return [...this.handlers.values()].reduce((n, set) => n + set.size, 0); }
}
function clock() {
  let now = 0, id = 0;
  const jobs = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) { jobs.set(++id, { fn, at: now + delay }); return id; },
    setInterval(fn, delay) { jobs.set(++id, { fn, at: now + delay, delay }); return id; },
    clearTimeout(id) { jobs.delete(id); }, clearInterval(id) { jobs.delete(id); },
    tick(ms) {
      const end = now + ms;
      for (let safety = 0; safety < 20000; safety++) {
        const job = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
        if (!job || job[1].at > end) break;
        now = job[1].at;
        if (job[1].delay) job[1].at += job[1].delay; else jobs.delete(job[0]);
        job[1].fn();
      }
      now = end;
    },
    jobs,
  };
}
function browserFixture({ nested = true, top = 5000 } = {}) {
  const time = clock(), win = new Events(); Object.assign(win, time);
  let observers = 0, scans = 0;
  class Observer { constructor(fn) { this.fn = fn; this.active = false; } observe() { if (!this.active) observers++; this.active = true; } disconnect() { if (this.active) observers--; this.active = false; } }
  class El extends Events {
    constructor(attrs = {}, y = 0) { super(); this.attrs = attrs; this.y = y; this.nodeType = 1; this.children = []; this.scrollTop = 0; this.scrollLeft = 0; this.scrollHeight = 30000; this.clientHeight = 800; this.isConnected = true; }
    append(el) { this.children.push(el); el.parentElement = this; }
    get firstElementChild() { return this.children[0]; }
    getAttribute(key) { return this.attrs[key] || null; }
    get id() { return this.attrs.id || ""; }
    closest(selector) { return this.attrs.header && selector.includes("header") ? this : null; }
    querySelectorAll(selector) {
      scans++;
      const attr = selector.slice(1, -1), found = [];
      const walk = el => { for (const child of el.children) { if (child.getAttribute(attr)) found.push(child); walk(child); } };
      walk(this); return found;
    }
    contains(el) { return el === this || this.children.some(child => child.contains(el)); }
    getBoundingClientRect() { return { top: this === container || this === root ? 0 : this.y - container.scrollTop, left: 0, width: 1000, height: this === container || this === root ? 800 : 120 }; }
    scrollTo({ top, left }) { this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)); this.scrollLeft = left; }
  }
  const root = new El(), container = nested ? new El({ id: "conversation" }) : root;
  if (nested) { root.scrollHeight = 800; root.append(container); }
  container.scrollTop = top;
  const anchor = new El({ "data-message-id": "message-85" }, top + 48); container.append(anchor);
  const document = new Events();
  Object.assign(document, { scrollingElement: root, documentElement: root,
    elementsFromPoint: () => [anchor, container, root],
    createTreeWalker(base) { scans++; const nodes = []; const walk = e => { for (const c of e.children) { nodes.push(c); walk(c); } }; walk(base); return { nextNode: () => nodes.shift() || null }; },
  });
  const url = "https://example.test/chat/123?secret=do-not-store#token";
  const context = vm.createContext({ window: win, document, location: { href: url }, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: el => ({ overflowY: "auto", position: el.attrs.position || "static" }), NodeFilter: { SHOW_ELEMENT: 1 },
    MutationObserver: Observer, ResizeObserver: Observer, Date: { now: time.now } });
  const run = (action, saved, token = "one") => {
    context.args = [action, token, saved, fingerprint(url), time.now() + 12000];
    return vm.runInContext(`(${browserRuntime.toString()})(...args)`, context);
  };
  return { El, run, eval: code => vm.runInContext(code, context), navigate: url => { context.location.href = url; }, root, container, anchor, win, document, time, url, get observers() { return observers; }, get scans() { return scans; } };
}
const tests = [];
const check = (name, fn) => tests.push([name, fn]);
check("workspace isolation, duplicate leaves, reconstructed IDs, and restart", async () => {
  let disk = "", writes = 0;
  const storage = new ScrollStateStorage(async () => disk, async data => { disk = data; writes++; });
  const tab = (type, id, top, page) => ({ id, slot: `main/${id}`, type, resource: type === "pdf" ? "X.pdf" : fingerprint("https://example.test"), position: { top, left: 0, page } });
  storage.set("A", [tab("pdf", "1", 10000, 100), tab("browser", "2", 5000), tab("browser", "3", 8500)]);
  storage.set("B", [tab("pdf", "1", 2000, 20), tab("browser", "2", 1000)]);
  await storage.flush(); await storage.flush(); assert.equal(writes, 1);
  const restart = new ScrollStateStorage(async () => disk, async () => {}); await restart.load();
  assert.equal(matchTab(restart.get("A"), tab("pdf", "1")).position.page, 100);
  assert.equal(matchTab(restart.get("B"), tab("pdf", "1")).position.page, 20);
  assert.equal(matchTab(restart.get("A"), tab("browser", "2")).position.top, 5000);
  assert.equal(matchTab(restart.get("B"), tab("browser", "2")).position.top, 1000);
  assert.equal(matchTab(restart.get("A"), tab("browser", "3")).position.top, 8500);
  const rebuilt = tab("browser", "new"); rebuilt.slot = "main/3";
  assert.equal(matchTab(restart.get("A"), rebuilt).position.top, 8500);
  rebuilt.slot = "unknown"; assert.equal(matchTab(restart.get("A"), rebuilt), undefined);
  restart.rename("A", "Renamed"); assert.equal(restart.get("Renamed").length, 3); assert.equal(restart.get("A").length, 0);
  assert.ok(!disk.includes("https://"));
});
check("missing/corrupt/future schema and malformed entries are harmless", async () => {
  for (const disk of ["broken", '{"version":2}', '{"version":1,"workspaces":{"A":[null,{"position":{}}]}}']) {
    const storage = new ScrollStateStorage(async () => disk, async () => {}); await storage.load(); assert.deepEqual(storage.get("A"), []);
  }
});
check("growing content below keeps anchor position in nested container", async () => {
  const f = browserFixture(), saved = f.run("capture").position;
  assert.equal(saved.top, 5000); assert.ok(saved.anchor.hash);
  assert.ok(!JSON.stringify(saved).includes("message-85"));
  f.container.scrollTop = 0; f.container.scrollHeight += 20000;
  const done = f.run("restore", saved); f.time.tick(5000); assert.equal(await done, true);
  assert.equal(f.container.scrollTop, 5000); assert.equal(f.root.scrollTop, 0); assert.equal(f.observers, 0);
  f.run("cancel"); assert.equal(f.document.count(), 0);
});
check("content inserted above restores anchor rather than old coordinates", async () => {
  const f = browserFixture(), saved = f.run("capture").position;
  f.anchor.y += 1200; f.container.scrollTop = 0;
  const done = f.run("restore", saved); f.time.tick(500); f.anchor.y += 300; f.time.tick(5000);
  assert.equal(await done, true); assert.equal(f.container.scrollTop, 6500); assert.equal(f.time.jobs.size, 0);
});
check("delayed and virtualized anchor appears after initial absolute seek", async () => {
  const f = browserFixture(), saved = f.run("capture").position;
  f.container.children = []; f.container.scrollTop = 0;
  const done = f.run("restore", saved); f.time.tick(4000);
  assert.equal(f.container.scrollTop, 5000); f.container.append(f.anchor); f.anchor.y += 900;
  f.time.tick(5000); assert.equal(await done, true); assert.equal(f.container.scrollTop, 5900); assert.equal(f.observers, 0);
});
check("missing/virtualized anchor has bounded fallback and preserves intended state", async () => {
  const f = browserFixture(), saved = f.run("capture").position;
  f.container.children = []; f.container.scrollTop = 0;
  const done = f.run("restore", saved); f.time.tick(13000);
  assert.equal(await done, false); assert.equal(f.container.scrollTop, 5000);
  assert.equal(f.observers, 0); assert.equal(f.time.jobs.size, 0); assert.ok(f.scans < 110);
  assert.equal(f.run("capture"), null); // Loading fallback must not overwrite saved anchor.
  f.win.emit("wheel"); assert.ok(f.run("capture")); f.run("cancel");
  assert.equal(f.win.count(), 0); assert.equal(f.document.count(), 0);
});
check("standard document coordinates and horizontal position restore without percentages", async () => {
  const f = browserFixture({ nested: false }), saved = { top: 7600, left: 35 };
  const done = f.run("restore", saved); f.time.tick(5000);
  assert.equal(await done, true); assert.equal(f.root.scrollTop, 7600); assert.equal(f.root.scrollLeft, 35);
});
check("manual scroll/click/key interruption stops corrections and disconnects observers", async () => {
  for (const event of ["wheel", "pointerdown", "keydown", "touchstart"]) {
    const f = browserFixture(), saved = f.run("capture").position;
    const done = f.run("restore", saved); f.time.tick(300); f.win.emit(event);
    f.container.scrollTop = 77; f.anchor.y += 1000; f.time.tick(14000);
    assert.equal(await done, false); assert.equal(f.container.scrollTop, 77); assert.equal(f.observers, 0); assert.equal(f.time.jobs.size, 0);
    f.run("cancel"); assert.equal(f.document.count(), 0);
  }
});
check("obsolete cancellation cannot cancel a newer operation; URL navigation stops restoration", async () => {
  const f = browserFixture(), saved = f.run("capture").position;
  const first = f.run("restore", saved, "old");
  const next = f.run("restore", saved, "new"); assert.equal(await first, false);
  f.run("cancel", undefined, "old"); f.time.tick(5000); assert.equal(await next, true);
  f.run("cancel", undefined, "new"); assert.equal(f.document.count(), 0);
  const navigating = f.run("restore", saved, "navigation");
  f.navigate("https://example.test/other"); f.time.tick(300); assert.equal(await navigating, false);
  f.run("cancel", undefined, "navigation"); assert.equal(f.observers, 0);
});
check("Surfing adapter waits for lifecycle readiness and cancels before loading", async () => {
  const f = browserFixture(); global.window = f.win;
  const root = new Events(), guest = new Events();
  let loading = true, executions = 0;
  Object.assign(guest, { isLoading: () => loading, executeJavaScript: async code => { executions++; return f.eval(code); } });
  root.querySelector = () => guest;
  const adapter = new SurfingScrollAdapter({ view: { containerEl: root } }, fingerprint(f.url));
  const saved = f.run("capture").position;
  f.container.scrollTop = 0;
  const controller = new AbortController();
  const canceled = adapter.restore(saved, controller.signal);
  f.time.tick(1000); assert.equal(executions, 0);
  controller.abort(); await canceled;
  loading = false; guest.emit("dom-ready"); f.time.tick(1000);
  assert.equal(f.container.scrollTop, 0); assert.equal(guest.count(), 0); assert.equal(root.count(), 0);
  loading = true;
  const restored = adapter.restore(saved, new AbortController().signal);
  loading = false; guest.emit("did-finish-load"); f.time.tick(5000);
  // Let the guest promise and bounded host promise resolve before advancing timeout guards.
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await restored; assert.equal(f.container.scrollTop, 5000); assert.equal(guest.count(), 0);
  adapter.dispose(); await Promise.resolve(); assert.equal(f.observers, 0); assert.equal(f.document.count(), 0);
});
check("dynamic capture chooses the nested reading pane over a slightly overflowing shell/header", async () => {
  const f = browserFixture(); f.root.scrollHeight = 820;
  const header = new f.El({ id: "toolbar", header: true, position: "sticky" }, 0);
  f.root.append(header);
  f.document.elementsFromPoint = (x, y) => y <= 80 ? [header, f.root] : [f.anchor, f.container, f.root];
  const saved = f.run("capture").position;
  assert.equal(saved.top, 5000); assert.equal(saved.anchor.attribute, "data-message-id");
  f.anchor.y += 700; f.container.scrollTop = 0;
  const done = f.run("restore", saved); f.time.tick(6000); assert.equal(await done, true);
  assert.equal(f.container.scrollTop, 5700); assert.equal(f.root.scrollTop, 0); f.run("cancel");
});
check("identifier lookup reaches late turns past 6000 unrelated elements and supports post identifiers", async () => {
  for (const attribute of ["data-turn-id", "data-testid", "post-id", "permalink"]) {
    const f = browserFixture(); f.anchor.attrs = { [attribute]: "stable-item-85" };
    const saved = f.run("capture").position;
    const original = f.container.children.slice(); f.container.children = [];
    for (let i = 0; i < 6500; i++) f.container.append(new f.El());
    for (const el of original) f.container.append(el);
    f.anchor.y += 1400; f.container.scrollTop = 0;
    const done = f.run("restore", saved); f.time.tick(6000);
    assert.equal(await done, true); assert.equal(f.container.scrollTop, 6400); f.run("cancel");
  }
});
check("PDF adapter captures page offset and restores page 100 independently of page 20", async () => {
  const time = clock(); global.window = time;
  let observers = 0;
  global.ResizeObserver = class { observe() { if (!this.active) observers++; this.active = true; } disconnect() { if (this.active) observers--; this.active = false; } };
  const root = new Events(), container = { clientHeight: 800, scrollTop: 0, scrollLeft: 0,
    getBoundingClientRect: () => ({ top: 50 }), scrollTo({ top, left }) { this.scrollTop = top; this.scrollLeft = left; } };
  const pdf = { currentPageNumber: 100, pagesCount: 200, getPageView: index => ({ div: { getBoundingClientRect: () => ({ top: 50 + index * 1000 - container.scrollTop }) } }) };
  const leaf = { view: { containerEl: root, viewer: { child: { pdfViewer: { pdfViewer: pdf, dom: { viewerContainerEl: container } } } } } };
  const adapter = new PdfScrollAdapter(leaf);
  container.scrollTop = 99250; const a = await adapter.capture(); assert.equal(a.page, 100); assert.equal(a.offset, 250);
  pdf.currentPageNumber = 20; container.scrollTop = 19180; const b = await adapter.capture(); assert.equal(b.offset, 180);
  for (const state of [a, b, a]) {
    const done = adapter.restore(state, new AbortController().signal); time.tick(1500); await done;
    assert.equal(pdf.currentPageNumber, state.page); assert.equal(container.scrollTop, (state.page - 1) * 1000 + state.offset);
    assert.equal(observers, 0); assert.equal(root.count(), 0);
  }
  const pending = adapter.restore(a, new AbortController().signal); root.emit("wheel"); container.scrollTop = 12; time.tick(15000); await pending;
  assert.equal(container.scrollTop, 12); adapter.dispose();
});

check("PDF document points survive different pane widths and independent zoom modes", async () => {
  const time = clock(); global.window = time;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  let width = 600, zoom = "page-width";
  const scale = () => zoom === "page-width" ? width / 600 : Number(zoom);
  const root = new Events();
  const container = { clientHeight: 650, clientTop: 2, clientLeft: 2,
    scrollTop: 0, scrollLeft: 0,
    get clientWidth() { return width; }, get scrollWidth() { return Math.max(width, 600 * scale() + 18); },
    get scrollHeight() { return (800 * scale() + 18) * 200; },
    getBoundingClientRect: () => ({ top: 50, left: 30 }),
    scrollTo({ top, left }) { this.scrollTop = top; this.scrollLeft = left; },
  };
  const origin = index => index * (800 * scale() + 18);
  const pdf = { currentPageNumber: 100, pagesCount: 200,
    get currentScaleValue() { return zoom; }, set currentScaleValue(value) { zoom = value; },
    getPageView: index => ({
      div: { clientTop: 9, clientLeft: 9, dataset: { loaded: "true" },
        getBoundingClientRect: () => ({ top: 52 + origin(index) - container.scrollTop,
          bottom: 52 + origin(index + 1) - container.scrollTop,
          left: 32 - container.scrollLeft, width: 600 * scale() + 18, height: 800 * scale() + 18 }),
      },
      viewport: { convertToPdfPoint: (x,y) => [x / scale(), 800 - y / scale()],
        convertToViewportPoint: (x,y) => [x * scale(), (800 - y) * scale()] },
    }),
  };
  const leaf = { view: { containerEl: root, viewer: { child: { pdfViewer: { pdfViewer: pdf, dom: { viewerContainerEl: container } } } } } };
  const adapter = new PdfScrollAdapter(leaf);
  container.scrollTop = origin(99) + 9 + 250;
  const a = await adapter.capture(); assert.deepEqual(a.pdfPoint, { x: 0, y: 550 }); assert.equal(a.pdfScale, "page-width");
  width = 1200; zoom = 2.5; pdf.currentPageNumber = 20;
  container.scrollTop = origin(19) + 9 + 180 * scale(); container.scrollLeft = 9 + 60 * scale();
  const b = await adapter.capture(); assert.deepEqual(b.pdfPoint, { x: 60, y: 620 }); assert.equal(b.pdfScale, 2.5);
  // Returning to A with a resized pane still preserves PDF point y=550. This is
  // a PDF coordinate transformation, never a percentage of the document height.
  width = 900;
  let done = adapter.restore(a, new AbortController().signal); time.tick(1500); await done;
  assert.equal(zoom, "page-width"); assert.equal(pdf.currentPageNumber, 100);
  assert.equal(container.scrollTop, origin(99) + 9 + 250 * 1.5);
  assert.equal(adapter.protected, false);
  done = adapter.restore(b, new AbortController().signal); time.tick(1500); await done;
  assert.equal(zoom, 2.5); assert.equal(pdf.currentPageNumber, 20);
  assert.equal(container.scrollTop, origin(19) + 9 + 180 * 2.5); assert.equal(container.scrollLeft, 9 + 60 * 2.5);
  // Most-visible page is 21, but the top reading line still crosses page 20.
  pdf.currentPageNumber = 21;
  assert.equal((await adapter.capture()).page, 20);
  // Near the last page a tall viewport clamps the reachable scroll target and settles.
  done = adapter.restore({ ...b, page: 200, pdfPoint: { x: 0, y: 0 } }, new AbortController().signal);
  time.tick(1500); await done; assert.equal(adapter.protected, false);
  assert.equal(container.scrollTop, container.scrollHeight - container.clientHeight);
  // PDF.js can keep reporting the next page as most visible at this reading
  // position. Do not repeatedly navigate back to the saved page on every retry.
  let jumps = 0, mostVisible = 21;
  Object.defineProperty(pdf, "currentPageNumber", { get: () => mostVisible, set: value => { jumps++; mostVisible = value; } });
  const scrollTo = container.scrollTo;
  container.scrollTo = function (coordinates) { scrollTo.call(this, coordinates); mostVisible = 21; };
  done = adapter.restore(b, new AbortController().signal); time.tick(1500); await done;
  assert.equal(jumps, 1); assert.equal(adapter.protected, false);
});
check("detached Surfing webview cannot abort PDF capture in the next workspace", async () => {
  global.window = { ...clock() }; global.document = new Events();
  let disk = "", leaves = [], attempts = 0;
  const guest = { executeJavaScript() { attempts++; throw new Error("WebView must be attached and dom-ready"); } };
  const browser = { id: "browser", getViewState: () => ({ type: "surfing-view", state: { url: "https://example.test" } }),
    view: { containerEl: { clientHeight: 800, querySelector: () => guest } } };
  const container = { clientHeight: 800, scrollTop: 7400, scrollLeft: 0, getBoundingClientRect: () => ({ top: 50 }) };
  const pdf = { currentPageNumber: 8, pagesCount: 200, getPageView: index => ({ div: {
    getBoundingClientRect: () => ({ top: 50 + index * 1000 - container.scrollTop }),
  } }) };
  const leaf = { id: "pdf", getViewState: () => ({ type: "pdf", state: { file: "X.pdf" } }),
    view: { containerEl: new Events(), viewer: { child: { pdfViewer: { pdfViewer: pdf, dom: { viewerContainerEl: container } } } } } };
  const plugin = { settings: { smartScrollRestoration: true }, manifest: { dir: "plugins/workspaces-plus" },
    app: { isMobile: false, vault: { adapter: { read: async () => disk, write: async (p, text) => { disk = text; } } }, workspace: {
      on: () => ({}), off() {}, iterateAllLeaves: fn => leaves.forEach(fn),
      getLayout: () => ({ main: { type: "tabs", children: leaves.map(l => ({ type: "leaf", id: l.id })) } }),
    } }, registerEvent() {}, registerInterval() {}, register() {}, registerDomEvent() {},
  };
  const manager = new SmartScrollManager(plugin); await manager.load();
  leaves = [browser]; await manager.activate("First"); await manager.beginSwitch();
  leaves = [leaf]; await manager.activate("Second");
  await manager.checkpoint(); assert.equal(manager.storage.get("Second")[0].position.page, 8);
  assert.equal(manager.tabs.has(browser), false); assert.equal(attempts, 2); // failed capture + failed disposal, both contained
  container.scrollTop = 21250; pdf.currentPageNumber = 22; await manager.beginSwitch();
  assert.equal(manager.storage.get("Second")[0].position.page, 22);
  await manager.activate("First"); await manager.beginSwitch();
  assert.equal(manager.storage.get("Second")[0].position.offset, 250);
  manager.stop();
});
check("Markdown source, Live Preview, and reading modes restore line anchors after edits and resize", async () => {
  const previousNow = Date.now;
  try {
    for (const mode of ["source", "live-preview", "preview"]) {
      const time = clock(); global.window = time; Date.now = time.now;
      global.ResizeObserver = class { observe() {} disconnect() {} };
      const root = new Events(); let height = 20, loading = false, text = Array.from({ length: 120 }, (_,i) => `Private test line ${i}`).join("\n");
      const container = { clientHeight: 400, scrollLeft: 30, scrollTop: 52.25 * height,
        get scrollHeight() { return text.split("\n").length * height; } };
      root.querySelector = selector => { assert.equal(selector, mode === "preview" ? ".markdown-preview-view" : ".cm-scroller"); return container; };
      const view = { containerEl: root, getMode: () => mode === "preview" ? "preview" : "source", currentMode: {
        getScroll: () => loading ? null : container.scrollTop / height, get: () => text,
        applyScroll: line => { time.setTimeout(() => { container.scrollTop = line * height; }, 40); },
      } };
      const adapter = new MarkdownScrollAdapter({ view });
      const saved = await adapter.capture(); assert.equal(saved.markdown.scroll, 52.25);
      assert.ok(!JSON.stringify(saved).includes("Private test"));
      text = "Inserted 1\nInserted 2\nInserted 3\n" + text + "\nMore appended content";
      height = 35; container.scrollTop = 0; loading = true;
      const done = adapter.restore(saved, new AbortController().signal); time.tick(1000); assert.equal(container.scrollTop, 0);
      loading = false; time.tick(4000); await done;
      assert.equal(container.scrollTop, 55.25 * height); assert.equal(container.scrollLeft, 30);
      assert.equal(root.count(), 0); assert.equal(time.jobs.size, 0); adapter.dispose();
      let disk = "";
      const storage = new ScrollStateStorage(async () => disk, async value => { disk = value; });
      storage.set("A", [{ id: "markdown", slot: "main/0", type: "markdown", resource: "Note.md", position: saved }]); await storage.flush();
      const restarted = new ScrollStateStorage(async () => disk, async () => {}); await restarted.load();
      assert.equal(restarted.get("A")[0].position.markdown.scroll, 52.25);
    }
  } finally { Date.now = previousNow; }
});
check("Markdown user interaction and abort stop pending restoration in every mode", async () => {
  const previousNow = Date.now;
  try {
    const time = clock(); global.window = time; Date.now = time.now;
    global.ResizeObserver = class { observe() {} disconnect() {} };
    const root = new Events(), container = { clientHeight: 100, scrollTop: 500, scrollLeft: 0, scrollHeight: 10000 };
    root.querySelector = () => container;
    let loading = false;
    const view = { containerEl: root, getMode: () => "preview", currentMode: {
      getScroll: () => loading ? null : container.scrollTop / 20,
      get: () => Array.from({ length: 300 }, (_,i) => `line ${i}`).join("\n"),
      applyScroll: line => { container.scrollTop = line * 20; },
    } };
    const adapter = new MarkdownScrollAdapter({ view }), saved = await adapter.capture();
    loading = true;
    const controller = new AbortController(), done = adapter.restore(saved, controller.signal);
    time.tick(500); root.emit("wheel"); container.scrollTop = 900; loading = false; time.tick(15000); await done;
    assert.equal(container.scrollTop, 900); assert.equal(root.count(), 0); assert.equal(time.jobs.size, 0);
    const abort = new AbortController(), pending = adapter.restore(saved, abort.signal); abort.abort(); await pending;
    assert.equal(root.count(), 0); assert.equal(time.jobs.size, 0); adapter.dispose();
  } finally { Date.now = previousNow; }
});
check("Surfing view cache retains guests, isolates duplicate URLs, keeps inactive tabs without expiry, and restores native views on disable", async () => {
  const previousNow = Date.now;
  const time = clock(); Date.now = time.now;
  try {
    const win = new Events(); Object.assign(win, time, { requestAnimationFrame: fn => time.setTimeout(fn, 1), cancelAnimationFrame: time.clearTimeout }); global.window = win;
    class Element extends Events {
      constructor() { super(); this.children = []; this.parentElement = null; this.classes = new Set(); this.dataset = {}; this.css = {}; }
      get isConnected() { return this === body || this === head || !!this.parentElement?.isConnected; }
      createDiv(options = {}) { const child = new Element(); for (const c of (options.cls || "").split(" ")) child.classes.add(c); this.appendChild(child); return child; }
      createEl() { return this.createDiv(); }
      appendChild(el) { if (el.parentElement) el.remove(); this.children.push(el); el.parentElement = this; }
      remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
      getBoundingClientRect() { return { top: 80, left: 300, width: 700, height: 600 }; }
      addClass(name) { this.classes.add(name); } toggleClass(name, value) { if (value) this.classes.add(name); else this.classes.delete(name); }
      setCssProps(props) { Object.assign(this.css, props); }
    }
    const body = new Element(), head = new Element(); global.document = { body, head };
    const observed = new Set();
    global.ResizeObserver = class { observe(el) { observed.add(el); } unobserve(el) { observed.delete(el); } disconnect() { observed.clear(); } };
    let created = 0;
    class SurfingView {
      constructor(leaf) { this.leaf = leaf; this.containerEl = new Element(); this.opens = 0; this.closes = 0; this.navigations = 0; this.url = ""; this.position = 0; created++; }
      async open(parent) { this.opens++; parent.appendChild(this.containerEl); }
      async close() { this.closes++; this.containerEl.remove(); }
      getState() { return { url: this.url }; }
      async setState(state) { this.url = state.url; this.navigations++; }
    }
    const create = leaf => new SurfingView(leaf);
    const registry = { getViewCreatorByType: type => type === "surfing-view" ? create : undefined };
    const events = new Events();
    const workspace = { on(name, fn) { events.addEventListener(name, fn); return {}; }, off(name, fn) { events.removeEventListener(name, fn); }, setActiveLeaf() {} };
    const plugin = { app: { isMobile: false, viewRegistry: registry, workspace },
      registerEvent() {}, registerInterval() {}, registerDomEvent(el, name, fn) { el.addEventListener(name, fn); } };
    const cache = new BrowserSessionCache(plugin); cache.selectWorkspace("A"); cache.start();
    const leaf = id => {
      const l = { id, containerEl: body.createDiv(), view: null,
        getViewState() { return { type: "surfing-view", state: this.view.getState() }; },
        async setViewState(state) {
          await this.view.close();
          if (state.type === "empty") this.view = { close: async () => {}, getState: () => ({}) };
          else { this.view = registry.getViewCreatorByType(state.type)(this); await this.view.open(this.containerEl); await this.view.setState(state.state, {}); }
        },
      }; return l;
    };
    const open = async l => { l.view = registry.getViewCreatorByType("surfing-view")(l); await l.view.open(l.containerEl); await l.view.setState({ url: "https://example.test/same" }, {}); time.tick(2); };
    let a = leaf("same-id"); await open(a); const originalA = a.view, hostA = originalA.containerEl.parentElement; originalA.position = 5000;
    let b;
    await cache.transition("B", async () => { await a.view.close(); a.containerEl.remove(); b = leaf("same-id"); await open(b); }, () => true);
    const originalB = b.view; originalB.position = 1000;
    assert.notEqual(originalA, originalB); assert.equal(originalA.closes, 0); assert.equal(originalA.containerEl.parentElement, hostA);
    await cache.transition("A", async () => { await b.view.close(); b.containerEl.remove(); a = leaf("same-id"); await open(a); }, () => true);
    assert.equal(a.view, originalA); assert.equal(a.view.position, 5000); assert.equal(a.view.opens, 1); assert.equal(a.view.navigations, 1);
    assert.equal(a.view.leaf, a); assert.equal(cache.consumeResumed(a), true); assert.equal(cache.consumeResumed(a), false);
    // A changed saved URL navigates normally and requires anchored restoration.
    await a.view.setState({ url: "https://example.test/changed" }, {}); assert.equal(a.view.navigations, 2);
    let active = a;
    for (const name of ["C", "D", "E"]) {
      await cache.transition(name, async () => { await active.view.close(); active.containerEl.remove(); active = leaf("same-id"); await open(active); }, () => true);
    }
    for (let i=0;i<10;i++) await Promise.resolve();
    assert.equal([...cache.entries.values()].filter(e => !e.active).length, 4);
    assert.equal(originalB.closes, 0); assert.equal(originalA.closes, 0);
    time.tick(24 * 60 * 60 * 1000); for (let i=0;i<10;i++) await Promise.resolve();
    assert.equal([...cache.entries.values()].filter(e => !e.active).length, 4);
    cache.remove("B"); for (let i=0;i<10;i++) await Promise.resolve();
    assert.equal(originalB.closes, 1);
    cache.rename("A", "renamed-A");
    assert.ok([...cache.entries.values()].some(e => e.workspace === "renamed-A"));
    const retained = active.view;
    let staleRan = false; await cache.transition("obsolete", async () => { staleRan = true; }, () => false); assert.equal(staleRan, false);
    cache.stop(); for (let i=0;i<30;i++) await Promise.resolve();
    assert.notEqual(active.view, retained); assert.equal(retained.closes, 1);
    assert.equal(registry.getViewCreatorByType("surfing-view"), create);
    assert.equal(cache.entries.size, 0); assert.equal(observed.size, 0); assert.equal(time.jobs.size, 0);
    assert.equal(win.count(), 0); assert.equal(events.count(), 0); assert.equal(head.children.length, 0); assert.ok(created >= 6);
  } finally { Date.now = previousNow; }
});
check("manager rapid switching, capture isolation, restart, disable, and cleanup", async () => {
  global.window = { ...clock() }; global.document = new Events();
  let disk = "", currentLeaves = [], calls = 0;
  const settings = { smartScrollRestoration: true };
  const workspace = { activeWorkspace: "A" };
  const plugin = { settings, manifest: { dir: "plugins/workspaces-plus" }, workspacePlugin: workspace,
    app: { isMobile: false, vault: { adapter: { read: async () => disk, write: async (p, data) => { disk = data; } } }, workspace: {
      on: () => ({}), off() {},
      getLayout: () => ({ main: { type: "tabs", children: currentLeaves.map(leaf => ({ type: "leaf", id: leaf.id })) } }),
      iterateAllLeaves: fn => currentLeaves.forEach(fn),
    } }, registerEvent() {}, registerInterval() {}, register() {}, registerDomEvent(el, event, cb) { el.addEventListener(event, cb); },
  };
  const leaf = { id: "leaf", view: { containerEl: new Events() }, getViewState: () => ({ type: "pdf", state: { file: "X.pdf" } }) };
  const manager = new SmartScrollManager(plugin); await manager.load(); manager.start();
  currentLeaves = [leaf]; await manager.activate("A");
  const tab = manager.tabs.get(leaf); let resolveCapture;
  let hiddenRestores = 0;
  tab.adapter = { capture: async () => null, restore: async () => { hiddenRestores++; }, dispose() {} };
  manager.storage.set("A", [{ ...tab.identity, position: { page: 7, top: 6000, left: 0 } }]);
  leaf.view.containerEl.clientHeight = 0;
  await manager.activate("A"); assert.equal(hiddenRestores, 0);
  leaf.view.containerEl.clientHeight = 800; manager.onActiveLeaf(leaf);
  await Promise.resolve(); await Promise.resolve(); assert.equal(hiddenRestores, 1);
  tab.adapter = { capture: () => { calls++; return new Promise(r => { resolveCapture = r; }); }, restore: async () => {}, dispose() {} };
  const outgoing = manager.beginSwitch();
  await manager.beginSwitch(); // B never became a real layout: do not capture A as B.
  resolveCapture({ page: 100, top: 99000, left: 0 }); await outgoing;
  assert.equal(manager.storage.get("A")[0].position.page, 100); assert.equal(calls, 1);
  let aborted = false, restores = 0;
  tab.adapter.restore = async (pos, signal) => { restores++; await new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); })); };
  manager.storage.set("B", [{ ...tab.identity, position: { page: 20, top: 19000, left: 0 } }]);
  const restoringB = manager.activate("B");
  await manager.beginSwitch(); await restoringB; assert.equal(aborted, true); assert.equal(restores, 1);
  assert.equal(calls, 1); // Half-restored B did not overwrite page 20.
  await manager.activate("C");
  settings.smartScrollRestoration = false; await manager.configure();
  await manager.beginSwitch(); await manager.activate("A");
  assert.equal(calls, 1); assert.equal(restores, 1); assert.equal(global.document.count(), 0); assert.equal(global.window.jobs.size, 0);
  const restarted = new ScrollStateStorage(async () => disk, async () => {}); await restarted.load(); assert.equal(restarted.get("A")[0].position.page, 100);
});
const watchdog = setTimeout(() => { throw new Error("Smart scroll tests stalled on an unresolved restoration"); }, 15000);
(async () => {
  for (const [name, fn] of tests) { await fn(); console.log(`  ok  ${name}`); }
  console.log(`\n${tests.length} smart scroll checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
