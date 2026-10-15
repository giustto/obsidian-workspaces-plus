/* Deterministic PDF, Markdown, storage, and manager fixtures exercise production code.
 * Real Obsidian compatibility still requires test-vault checks. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
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
const { fingerprint, matchTab, ScrollStateStorage } = load("src/scrollPosition/state.ts");
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
// The public Component contract lets each enable/disable cycle own its cleanup.
class Component {
  cleanups = [];
  load() {}
  register(fn) { this.cleanups.push(fn); }
  unload() { for (const fn of this.cleanups.splice(0).reverse()) fn(); }
  registerInterval(id) { this.cleanups.push(() => window.clearInterval(id)); }
  registerEvent(ref) { this.cleanups.push(() => ref.off()); }
  registerDomEvent(el, name, fn, options) {
    el.addEventListener(name, fn, options);
    this.cleanups.push(() => el.removeEventListener(name, fn, options));
  }
}
const { PdfScrollAdapter } = load("src/scrollPosition/adapters.ts", { obsidian: { Component } });
const { MarkdownScrollAdapter } = load("src/scrollPosition/markdownAdapter.ts", { obsidian: { Component } });
const { ScrollPositionManager } = load("src/scrollPosition/manager.ts", { obsidian: { Component } });
const tests = [];
const check = (name, fn) => tests.push([name, fn]);
check("workspace isolation, duplicate leaves, reconstructed IDs, and restart", async () => {
  let disk = "", writes = 0;
  const storage = new ScrollStateStorage(async () => disk, async data => { disk = data; writes++; });
  const tab = (type, id, top, page) => ({ id, slot: `main/${id}`, type, resource: type === "pdf" ? "X.pdf" : "Note.md", position: { top, left: 0, page } });
  storage.set("A", [tab("pdf", "1", 10000, 100), tab("markdown", "2", 5000), tab("markdown", "3", 8500)]);
  storage.set("B", [tab("pdf", "1", 2000, 20), tab("markdown", "2", 1000)]);
  await storage.flush(); await storage.flush(); assert.equal(writes, 1);
  const restart = new ScrollStateStorage(async () => disk, async () => {}); await restart.load();
  assert.equal(matchTab(restart.get("A"), tab("pdf", "1")).position.page, 100);
  assert.equal(matchTab(restart.get("B"), tab("pdf", "1")).position.page, 20);
  assert.equal(matchTab(restart.get("A"), tab("markdown", "2")).position.top, 5000);
  assert.equal(matchTab(restart.get("B"), tab("markdown", "2")).position.top, 1000);
  assert.equal(matchTab(restart.get("A"), tab("markdown", "3")).position.top, 8500);
  const rebuilt = tab("markdown", "new"); rebuilt.slot = "main/3";
  assert.equal(matchTab(restart.get("A"), rebuilt).position.top, 8500);
  rebuilt.slot = "unknown"; assert.equal(matchTab(restart.get("A"), rebuilt), undefined);
  restart.rename("A", "Renamed"); assert.equal(restart.get("Renamed").length, 3); assert.equal(restart.get("A").length, 0);
  assert.ok(!disk.includes("https://"));
});
check("earlier position files migrate to the new filename and current files take precedence", async () => {
  const path = "plugins/workspaces-plus/", tab = { id: "1", slot: "main/0", type: "pdf", resource: "X.pdf", position: { top: 500, left: 0, page: 2 } };
  const files = new Map([[path + "smart-scroll.json", JSON.stringify({ version: 1, workspaces: { A: [tab] } })]]);
  const plugin = { register() {}, manifest: { dir: path.slice(0, -1) }, app: { vault: { adapter: {
    read: async name => { if (!files.has(name)) throw new Error("Missing file"); return files.get(name); },
    write: async (name, data) => { files.set(name, data); },
  } } } };
  const manager = new ScrollPositionManager(plugin); await manager.load();
  assert.equal(manager.storage.get("A")[0].position.page, 2);
  manager.storage.set("B", [tab]); await manager.storage.flush();
  assert.ok(files.has(path + "scroll-positions.json"));
  files.set(path + "smart-scroll.json", JSON.stringify({ version: 1, workspaces: {} }));
  const restarted = new ScrollPositionManager(plugin); await restarted.load();
  assert.equal(restarted.storage.get("B")[0].position.page, 2);
});
check("missing/corrupt/future schema and malformed entries are harmless", async () => {
  for (const disk of ["broken", '{"version":2}', '{"version":1,"workspaces":{"A":[null,{"position":{}}]}}']) {
    const storage = new ScrollStateStorage(async () => disk, async () => {}); await storage.load(); assert.deepEqual(storage.get("A"), []);
  }
});
function pdfLeaf(id = "pdf") {
  const pdf = { currentScaleValue: "page-width", _location: { pageNumber: 100, left: 12, top: 550 } };
  const destinations = [];
  const viewer = { isInitialViewSet: true, pdfViewer: pdf, applySubpath: value => destinations.push(value) };
  const leaf = { id, getViewState: () => ({ type: "pdf", state: { file: "X.pdf" } }),
    view: { containerEl: Object.assign(new Events(), { clientHeight: 800 }), viewer: { child: { pdfViewer: viewer } } } };
  return { leaf, pdf, viewer, destinations };
}
function harness() {
  const time = clock(); global.window = time; global.document = new Events();
  let disk = "", leaves = [];
  const active = new Set(), cleanups = [];
  const plugin = { settings: { scrollPositionRestoration: true }, manifest: { dir: "plugins/workspaces-plus" },
    workspacePlugin: { activeWorkspace: "A" }, register: fn => cleanups.push(fn), app: {
      vault: { adapter: { read: async () => disk, write: async (path, data) => { disk = data; } } },
      workspace: {
        on(name, fn) { active.add(fn); return { off: () => active.delete(fn) }; },
        getLayout: () => ({ main: { type: "tabs", children: leaves.map(l => ({ type: "leaf", id: l.id })) } }),
        iterateAllLeaves: fn => leaves.forEach(fn),
      },
    } };
  const manager = new ScrollPositionManager(plugin);
  return { manager, plugin, time, active, cleanups, setLeaves: value => { leaves = value; }, disk: () => disk };
}
async function settle(promise) {
  // Resolve native geometry promises, then the single scheduled navigation task.
  for (let i = 0; i < 12; i++) { await Promise.resolve(); window.tick(0); }
  return promise;
}
check("PDF captures native document coordinates and delegates zoom and navigation once", async () => {
  global.window = clock();
  const { leaf, pdf, viewer, destinations } = pdfLeaf();
  const adapter = new PdfScrollAdapter(leaf), signal = new AbortController().signal;
  const a = adapter.capture();
  assert.equal(a.page, 100); assert.deepEqual(a.pdfPoint, { x: 12, y: 550 });
  // Native location is the first visible page, even when currentPageNumber differs.
  pdf.currentPageNumber = 101;
  let updates = 0; pdf.update = () => { updates++; };
  assert.equal(adapter.capture().page, 100); assert.equal(updates, 1);
  await settle(adapter.restore(a, signal));
  assert.deepEqual(destinations, ["page=100&zoom=page-width,12,550"]);
  for (const scale of [2.5, "1.25", "auto", "page-fit", "page-height"]) {
    await settle(adapter.restore({ ...a, pdfScale: scale }, signal));
    assert.equal(destinations.at(-1), `page=100&zoom=${Number.isFinite(Number(scale)) ? Number(scale) * 100 : scale},12,550`);
  }
  const controller = new AbortController(); controller.abort();
  const count = destinations.length; await adapter.restore(a, controller.signal); assert.equal(destinations.length, count);
  viewer.isInitialViewSet = false; assert.equal(adapter.capture(), null);
  delete leaf.view.viewer; assert.equal(adapter.capture(), null); await settle(adapter.restore(a, signal));
  // Existing version-1 positions without PDF points degrade to page-level navigation.
  leaf.view.viewer = { child: { pdfViewer: viewer } };
  await settle(adapter.restore({ page: 20, top: 19000, left: 0 }, signal));
  assert.equal(destinations.at(-1), "page=20&zoom=auto");
  pdf.pagesCount = 10;
  const previous = destinations.length; await settle(adapter.restore(a, signal));
  assert.equal(destinations.length, previous);
});
check("PDF round trips include page borders and publish the location before a tab hides", async () => {
  for (const scale of [1, 2]) for (const rotated of [false, true]) {
    global.window = clock();
    const { leaf, pdf, viewer } = pdfLeaf();
    const div = { offsetLeft: 40, offsetTop: 12000, clientLeft: 8, clientTop: 8 };
    const convert = (x, y) => rotated ? [y * scale, x * scale] : [x * scale, (800 - y) * scale];
    const container = pdf.container = { scrollLeft: 0, scrollTop: 0 };
    pdf.getPageView = () => ({ div, viewport: { convertToViewportPoint: convert } });
    pdf.update = () => {
      const x = (container.scrollLeft - div.offsetLeft - div.clientLeft) / scale;
      const y = (container.scrollTop - div.offsetTop - div.clientTop) / scale;
      pdf._location = { pageNumber: 6, left: rotated ? y : x, top: rotated ? x : 800 - y };
    };
    viewer.applySubpath = () => {
      // Native navigation omits borders and leaves _location for the next RAF.
      const [x, y] = convert(36, 604);
      container.scrollLeft = div.offsetLeft + x; container.scrollTop = div.offsetTop + y;
    };
    const adapter = new PdfScrollAdapter(leaf), signal = new AbortController().signal;
    let saved = { top: 0, left: 0, page: 6, pdfPoint: { x: 36, y: 604 }, pdfScale: scale };
    for (let i = 0; i < 3; i++) {
      await settle(adapter.restore(saved, signal));
      assert.deepEqual(pdf._location, { pageNumber: 6, left: 36, top: 604 });
      saved = adapter.capture();
      assert.deepEqual(saved.pdfPoint, { x: 36, y: 604 });
    }
  }
});
check("PDF waits for geometry and stops on user input, abort, timeout, or file navigation", async () => {
  for (const action of ["ready", "input", "abort", "timeout", "navigate", "reject"]) {
    global.window = clock();
    const { leaf, pdf, destinations } = pdfLeaf();
    let ready, reject;
    pdf.pagesPromise = new Promise((resolve, fail) => { ready = resolve; reject = fail; });
    const controller = new AbortController(), adapter = new PdfScrollAdapter(leaf);
    const pending = adapter.restore(adapter.capture(), controller.signal);
    await settle(); assert.equal(destinations.length, 0);
    if (action === "input") leaf.view.containerEl.emit("wheel");
    if (action === "abort") controller.abort();
    if (action === "timeout") window.tick(12000);
    if (action === "navigate") leaf.getViewState = () => ({ state: { file: "Other.pdf" } });
    if (action === "reject") reject(new Error("Closed document")); else ready();
    await settle(pending);
    assert.equal(destinations.length, action === "ready" ? 1 : 0);
    assert.equal(leaf.view.containerEl.count(), 0); assert.equal(window.jobs.size, 0);
    // A later native resolution must not revive a cancelled navigation.
    await settle(); assert.equal(destinations.length, action === "ready" ? 1 : 0);
  }
});
check("Markdown anchors survive edits in source, Live Preview, and reading mode", () => {
  for (const mode of ["source", "live-preview", "preview"]) {
    let text = Array.from({ length: 120 }, (_, i) => `Private test line ${i}`).join("\n");
    const calls = [], container = { clientHeight: 400, scrollTop: 1000, scrollLeft: 30 };
    const view = { containerEl: { querySelector: () => container }, getMode: () => mode === "preview" ? "preview" : "source",
      currentMode: { getScroll: () => 52.25, get: () => text,
        applyScroll() { throw new Error("Must use native render-aware setter"); } },
      setEphemeralState: state => calls.push(state),
    };
    const adapter = new MarkdownScrollAdapter({ view }), saved = adapter.capture();
    assert.ok(!JSON.stringify(saved).includes("Private test"));
    text = "Inserted 1\nInserted 2\nInserted 3\n" + text;
    adapter.restore(saved, new AbortController().signal);
    assert.deepEqual(calls, [{ scroll: 55.25 }]); assert.equal(container.scrollLeft, 30);
    const abort = new AbortController(); abort.abort(); adapter.restore(saved, abort.signal);
    assert.equal(calls.length, 1);
    view.currentMode.getScroll = () => null; assert.equal(adapter.capture(), null);
  }
});
check("Live Preview remeasures wrapped lines before final restoration", async () => {
  global.window = clock();
  const root = new Events(), requests = [];
  let measured = false;
  const container = { clientHeight: 400, scrollTop: 856, scrollLeft: 12 };
  root.querySelector = () => container;
  const text = Array.from({ length: 20 }, (_, i) => `wrapped paragraph ${i}`).join("\n");
  const mode = { get: () => text, getScroll: () => container.scrollTop / 856 * 7.4375,
    cm: { requestMeasure: request => requests.push(request) } };
  const view = { containerEl: root, currentMode: mode, getMode: () => "source",
    setEphemeralState: ({ scroll }) => { container.scrollTop = scroll / 7.4375 * (measured ? 856 : 769.5); } };
  const leaf = { view, getViewState: () => ({ state: { file: "Note.md" } }) };
  const adapter = new MarkdownScrollAdapter(leaf), saved = adapter.capture();
  const pending = adapter.restore(saved, new AbortController().signal);
  // Opening the target viewport first uses estimated wrapped-line heights.
  assert.equal(container.scrollTop, 769.5);
  measured = true;
  for (const request of requests.splice(0)) request.write(request.read());
  await settle(pending);
  assert.equal(container.scrollTop, 856);
  assert.equal(adapter.capture().markdown.scroll, 7.4375);
  assert.equal(root.count(), 0); assert.equal(window.jobs.size, 0);
});
check("Live Preview abandons a late measurement after input, cancellation, or navigation", async () => {
  for (const action of ["input", "abort", "timeout", "file", "view", "mode"]) {
    global.window = clock();
    const root = new Events(), requests = [], calls = [];
    const container = { clientHeight: 400, scrollTop: 856, scrollLeft: 12 };
    root.querySelector = () => container;
    const mode = { get: () => Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"),
      getScroll: () => 7.4375, cm: { requestMeasure: request => requests.push(request) } };
    const view = { containerEl: root, currentMode: mode, getMode: () => "source",
      setEphemeralState: state => calls.push(state) };
    const leaf = { view, getViewState: () => ({ state: { file: "Note.md" } }) };
    const adapter = new MarkdownScrollAdapter(leaf), controller = new AbortController();
    const pending = adapter.restore(adapter.capture(), controller.signal);
    if (action === "input") root.emit("wheel");
    if (action === "abort") controller.abort();
    if (action === "timeout") window.tick(12000);
    if (action === "file") leaf.getViewState = () => ({ state: { file: "Other.md" } });
    if (action === "view") leaf.view = { containerEl: new Events() };
    if (action === "mode") view.currentMode = { ...mode };
    container.scrollTop = 1234; // User's new position must win over a late callback.
    for (const request of requests.splice(0)) request.write(request.read());
    await settle(pending);
    assert.equal(calls.length, 1, action);
    assert.equal(container.scrollTop, 1234, action);
    assert.equal(root.count(), 0, action); assert.equal(window.jobs.size, 0, action);
  }
});
check("Markdown duplicates prefer matching context and deleted anchors clamp safely", () => {
  let text = "before\nheading\nafter\nother\nheading\ncontext", scroll = 4.5, target;
  const view = { containerEl: { querySelector: () => ({ clientHeight: 800, scrollTop: 100, scrollLeft: 0 }) },
    getMode: () => "preview", currentMode: { get: () => text, getScroll: () => scroll },
    setEphemeralState: state => { target = state.scroll; } };
  const adapter = new MarkdownScrollAdapter({ view }), saved = adapter.capture();
  text = "before\nheading\nafter\ninserted\nother\nheading\ncontext";
  adapter.restore(saved, new AbortController().signal); assert.equal(target, 5.5);
  text = "short"; adapter.restore(saved, new AbortController().signal); assert.equal(target, 0.99);
});
check("manager isolates workspaces, duplicate files, unsupported views, and failed captures", async () => {
  const h = harness(), a = pdfLeaf("one"), b = pdfLeaf("two");
  b.pdf._location = { pageNumber: 20, left: 0, top: 620 };
  const browser = { id: "browser", getViewState: () => ({ type: "surfing-view", state: { url: "https://example.test" } }),
    get view() { throw new Error("Unsupported views must never be accessed"); } };
  const broken = { id: "broken", getViewState: () => ({ type: "markdown", state: { file: "broken.md" } }),
    get view() { throw new Error("View disappeared"); } };
  await h.manager.load(); h.setLeaves([browser, broken, a.leaf, b.leaf]); await settle(h.manager.activate("A"));
  await h.manager.beginSwitch();
  assert.equal(h.manager.storage.get("A").length, 2);
  assert.deepEqual(h.manager.storage.get("A").map(s => s.position.page), [100, 20]);
  a.pdf._location.pageNumber = 7; b.pdf._location.pageNumber = 8;
  await settle(h.manager.activate("B")); await h.manager.beginSwitch();
  await settle(h.manager.activate("A"));
  assert.equal(a.destinations.at(-1), "page=100&zoom=page-width,12,550");
  assert.equal(b.destinations.at(-1), "page=20&zoom=page-width,0,620");
  assert.deepEqual(h.manager.storage.get("B").map(s => s.position.page), [7, 8]);
  // Restart keeps independent tab/workspace positions.
  const storage = new ScrollStateStorage(h.disk, async () => {}); await storage.load();
  assert.equal(storage.get("A")[0].position.page, 100); assert.equal(storage.get("B")[0].position.page, 7);
  h.manager.stop();
});
check("outgoing capture completes synchronously before layout changes or renames", async () => {
  const h = harness(), { leaf, pdf } = pdfLeaf(); h.setLeaves([leaf]);
  await settle(h.manager.activate("A"));
  const outgoing = h.manager.beginSwitch();
  pdf._location.pageNumber = 20;
  h.manager.rename("A", "Renamed");
  await h.manager.beginSwitch(); // No second capture of an unapplied layout.
  await outgoing;
  assert.equal(h.manager.storage.get("Renamed")[0].position.page, 100);
  assert.equal(h.manager.storage.get("A").length, 0);
  h.manager.remove("Renamed"); await h.manager.storage.flush();
  assert.equal(h.manager.storage.get("Renamed").length, 0);
});
check("slow disk writes do not delay switching or reorder newer snapshots", async () => {
  const h = harness(), { leaf, pdf } = pdfLeaf(); h.setLeaves([leaf]);
  let finish, writing = false, disk = "";
  h.plugin.app.vault.adapter.write = async (path, data) => {
    if (!writing) { writing = true; await new Promise(resolve => { finish = resolve; }); }
    disk = data;
  };
  await settle(h.manager.activate("A"));
  assert.equal(h.manager.beginSwitch(), undefined); // No disk promise reaches loadWorkspace.
  await settle(); assert.ok(finish);
  await settle(h.manager.activate("B")); pdf._location.pageNumber = 20;
  h.manager.beginSwitch();
  assert.equal(h.manager.storage.get("A")[0].position.page, 100);
  assert.equal(h.manager.storage.get("B")[0].position.page, 20);
  finish(); await h.manager.storage.flush();
  const restart = new ScrollStateStorage(async () => disk, async () => {}); await restart.load();
  assert.equal(restart.get("A")[0].position.page, 100); assert.equal(restart.get("B")[0].position.page, 20);
});
check("hidden/deferred tabs restore on activation and stale loads cannot affect another file", async () => {
  const h = harness(), { leaf, destinations } = pdfLeaf(); h.setLeaves([leaf]);
  await settle(h.manager.activate("A")); await h.manager.beginSwitch();
  leaf.view.containerEl.clientHeight = 0;
  await settle(h.manager.activate("A")); assert.equal(destinations.length, 0);
  leaf.view.containerEl.clientHeight = 800;
  h.manager.onActiveLeaf(leaf); await settle(); assert.equal(destinations.length, 1);
  let finish; leaf.isDeferred = true;
  leaf.loadIfDeferred = () => new Promise(resolve => { finish = resolve; });
  const pending = h.manager.activate("A");
  await h.manager.beginSwitch(); finish(); await pending;
  assert.equal(destinations.length, 1);
  const navigated = h.manager.activate("A");
  leaf.getViewState = () => ({ type: "pdf", state: { file: "Other.pdf" } });
  finish(); await navigated; assert.equal(destinations.length, 1);
});
check("a PDF hidden during geometry loading stays pending until reactivated", async () => {
  const h = harness(), { leaf, pdf, destinations } = pdfLeaf(); h.setLeaves([leaf]);
  await settle(h.manager.activate("A")); h.manager.beginSwitch();
  let ready; pdf.pagesPromise = new Promise(resolve => { ready = resolve; });
  const loading = h.manager.activate("A"); await settle();
  leaf.view.containerEl.clientHeight = 0; ready(); await settle(loading);
  assert.equal(destinations.length, 0);
  assert.ok(h.manager.pending.has(leaf));
  assert.ok(h.manager.deferred.has(leaf));
  await h.manager.checkpoint(); assert.equal(h.manager.storage.get("A")[0].position.page, 100);
  leaf.view.containerEl.clientHeight = 800;
  h.manager.onActiveLeaf(leaf); await settle();
  assert.equal(destinations.length, 1); assert.equal(h.manager.pending.has(leaf), false);
});
check("repeated toggles clean up listeners and timers; unload takes a final snapshot", async () => {
  const h = harness(), { leaf, pdf } = pdfLeaf(); h.setLeaves([leaf]);
  await settle(h.manager.activate("A"));
  for (let i = 0; i < 3; i++) {
    await settle(h.manager.configure()); assert.equal(h.active.size, 1); assert.equal(document.count(), 1);
    h.plugin.settings.scrollPositionRestoration = false; await settle(h.manager.configure());
    assert.equal(h.active.size, 0); assert.equal(document.count(), 0); assert.equal(h.time.jobs.size, 0);
    h.plugin.settings.scrollPositionRestoration = true;
  }
  await settle(h.manager.configure()); pdf._location.pageNumber = 42;
  h.manager.shutdown(); await h.manager.storage.flush();
  assert.equal(h.manager.storage.get("A")[0].position.page, 42);
  assert.equal(h.active.size, 0); assert.equal(document.count(), 0); assert.equal(h.time.jobs.size, 0);
  assert.equal(h.cleanups.length, 1);
});
const watchdog = setTimeout(() => { throw new Error("Scroll position tests stalled on an unresolved restoration"); }, 15000);
(async () => {
  for (const [name, fn] of tests) { await fn(); console.log(`  ok  ${name}`); }
  console.log(`\n${tests.length} scroll position checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
