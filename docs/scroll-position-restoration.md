# Scroll restoration implementation

Capture is synchronous: snapshot the outgoing views before changing layouts, then
serialize writes in the background. Slow storage does not delay switching. Positions
stay separate from saved layouts so temporary tab changes do not overwrite a workspace.

Markdown restores through `MarkdownView.setEphemeralState({ scroll })`. In Obsidian
1.14.4's bundled implementation, reading view routes this through
`renderer.applyScrollDelayed`, which waits for rendered sections. Calling
`currentMode.applyScroll()` directly can silently fail before measurement. Hashed
source anchors remain available for edits; unchanged notes only need a local check.
Source mode and Live Preview first navigate to the target, then correct the position
once after CodeMirror's `requestMeasure` has measured the wrapped lines. The native
setter alone can use estimated heights and leave a visible offset after measurement.
The correction runs after CodeMirror's queued writes and is cancelled by input,
workspace switching, file/view changes, or the timeout. Its private `currentMode.cm`
access is guarded; it adds no runtime dependency on CodeMirror.

PDF capture uses PDF.js's first-visible-page `_location`, which already contains PDF
coordinates. Restore waits for `pagesPromise` and the next task before passing
`page=…&zoom=…,x,y` to Obsidian's `PDFViewerApplication.applySubpath`. This gives
native initialization a task to finish its queued writes. Input, a workspace
switch, or a 12-second timeout cancels the wait. Both adapters share that lifecycle
through `renderReady.ts`; neither polls.

Obsidian 1.14.4's bundled `scrollIntoView` omits the page's `clientTop`/`clientLeft`,
while `getVisibleElements` includes them when calculating the saved location. Native
navigation therefore drifts by the border width on each round trip. After native
navigation establishes zoom and page layout, the adapter inverts the saved PDF point
using the page viewport and its actual offsets, including borders. It calls `update`
synchronously so hiding the tab before the next animation frame cannot leave a stale
location for native resize/zoom to reuse. If the tab hides during the geometry wait,
the manager keeps its saved position pending for the next activation.

The PDF wrapper is private and guarded in `adapters.ts`. These dependencies were
inspected in the installed Obsidian 1.14.4 bundle. See
[the vault test report](scroll-position-vault-test.md) for live checks and limitations.
Public reference: [Obsidian View API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts).
PDF.js references: [coordinate capture and navigation](https://github.com/mozilla/pdf.js/blob/master/web/pdf_viewer.js),
[initial view loading](https://github.com/mozilla/pdf.js/blob/v4.0.379/web/app.js).

Before submitting, manually check in a disposable vault on the minimum supported
Obsidian version (1.8.7) and the current version:

- Switch A → B → A with the same PDF and note at different positions; include
  duplicate tabs and different pane widths, numeric zoom, and page-width zoom.
- Use a large PDF with mixed page sizes; switch while it loads, then scroll or
  switch again before initialization finishes. Check for delayed jumps.
- Repeat with source mode, Live Preview, and reading mode, including images and
  text inserted above the saved anchor. Activate a previously hidden tab.
- Rename/delete a workspace, restart, and toggle restoration repeatedly. Repeat
  in mobile emulation and on a real mobile device.

Automated fixtures cover plugin behavior and native API arguments. They do not
exercise Obsidian rendering or establish compatibility with older private APIs.
