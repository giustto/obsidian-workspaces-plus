# Test-vault results — 2026-10-16

Environment: macOS, Obsidian 1.14.4, `Testing-Tools` vault. The installed
`main.js` matched the repository build (SHA-1
`40e5773cc2166bc346aeca8cea66d73eaf3907a4`). Scroll restoration was enabled.
Interactions used Obsidian's UI; saved coordinates were read from the plugin's
`scroll-positions.json` to corroborate the observations.

## Observed results

- **Pass: PDF page isolation.** In `New workspace`, navigate `Probeklausur 1.pdf`
  to page label 3 (physical page 4). Switch to `New workspace 2`, navigate the
  same file to page label 8 (physical page 9), and return to `New workspace`.
  The PDF returns to label 3. Both workspaces retain separate saved coordinates.
- **Fail: exact Live Preview restoration.** Open `Lorem Ipsum.md` in
  `New workspace`, scroll down, then switch to `New workspace 2` and place the
  same note farther down. Return to `New workspace` and activate its note tab.
  The correct paragraph returns, but several wrapped display lines move above
  the saved reading point. Before switching, the saved source scroll was
  `7.4375` and pixel top `856`. After restoration and the next checkpoint,
  they became approximately `6.895833333333333` and `769.5`. No note edits or
  pane resize occurred between these observations. The differing positions
  in the second workspace remained separately stored (`38.75`, pixel top `3814`).

The native Markdown scroll setter alone is therefore insufficient to establish
exact restoration in this setup. Rendering/measurement timing is a hypothesis,
not a confirmed cause. The unit fixtures passed but did not model this behavior.

## Fix and focused retest

The subsequent build (SHA-1 `f3f88432725e689bf7e321e7bbc50dea9a3d359f`) adds
one correction after CodeMirror measures the target viewport, rather than a polling
loop. It was installed in the same test vault and loaded using **View → Force reload**.

A focused integration check ran against the loaded plugin's real Markdown adapter
and Obsidian's real CodeMirror editor through the visible developer console. At an
editor pane width of 680 CSS pixels, it captured the source scroll `7.4375`, pixel
top `856`, moved the viewport to the top, invoked restoration, and waited for native
measurement. The resulting capture was exactly `7.4375`, pixel top `856`.
This validates the adapter correction in the real editor, rather than establishing
that all workspace-switching paths have been retested.

The automated suite now includes the estimated-height regression and late-measurement
cancellation on input, abort, timeout, and file/view/mode changes. All 14 scroll checks
pass. The production build and project type check with `--skipLibCheck` pass; lint
still reports the same two pre-existing errors and four warnings.

## Continued live testing of the fixed build

After the user brought Obsidian to the foreground, computer control resumed.
The following integration checks invoked the loaded plugin through Obsidian's
visible developer console. They exercised real views and workspace layouts,
rather than simulated test fixtures.

- **Pass: completed Markdown workspace switches.** Six consecutive switches,
  waiting for the target workspace and its pending note restoration, alternated
  exactly between source scroll `7.4375` and `45.988425925925924`. The first
  workspace remained at pixel top `856`. In the second, pixel top changed from
  `4585.5` to `4489.5` while the source coordinate stayed identical; absolute
  pixel offsets alone are not a reliable comparison for a virtualized editor.
- **Pass: overlapping load requests.** Request A, B, A without waiting between
  requests. After the final load and note restoration completed, the manager
  reported A (`New workspace`) and source scroll `7.4375`.
- **Pass: Reading view and Source mode adapter checks.** In each mode, capture
  source scroll `20.25`, move to the top, and invoke the real adapter. Both
  returned exactly `20.25` after rendering settled. These were focused adapter
  checks, not saved-layout round trips in those modes. An initial test attempt
  captured before the Reading view container became visible and returned null;
  the repeated check explicitly waited for the view to be ready.
- **Fail: exact PDF coordinates at numeric zoom.** With the PDF active, capture
  physical page `6`, scale `1.5`, PDF point `(36, 604)`. Checkpoint, load A,
  then load B, keeping the PDF active and waiting for pending restoration and
  another 500 ms. Page `6` and scale `1.5` returned, but the PDF point became
  `(32, 608)`. The stored input was confirmed as `(36, 604)`. A separate native
  navigation check stayed at `(36, 604)` after 300, 1300, and 3300 ms, so ordinary
  settling before the switch does not explain this discrepancy.
- **Fail observed, cause unresolved: mixed PDF/note activation.** A related
  round trip that activated the note after each load, then returned to the PDF,
  changed page `6`, scale `1.5`, point `(36, 604)` to page `3`, scale `1.5`, point
  `(-4, 210)`. This larger jump needs a focused reproduction of tab activation
  timing; it must not be counted as a passing PDF test.

An earlier fast UI driver also observed B's note near the top. That driver could
select a tab from the previous layout before the requested layout finished loading.
The completed-load and overlapping-request checks above did not reproduce this
note failure; the original fast interaction remains inconclusive.

No implementation changes were made during this continued test pass. The fixed
build improves the confirmed Live Preview regression, but the PDF failures mean
it should not yet be described as ready to merge.

## Remaining checks

Reading/Source saved-layout round trips, resized panes, duplicate tabs,
interaction during slow loading, restart persistence, mobile, and Obsidian 1.8.7
remain unverified in the live app. PDF coordinate drift and mixed-tab activation
need correction and a live retest.

## PDF correction after the continued test pass

Build SHA-1 `1852c5ae663d73c1f1f1b6e45e780933bc466ee8` was built and copied into
the test vault; both files have the same checksum. The source now corrects the
page-border asymmetry in Obsidian's bundled PDF navigation, publishes the final
PDF.js location synchronously, and keeps a view pending if it hides while geometry
loads. The border asymmetry was confirmed by reading the installed application's
bundled PDF.js source. The relationship between stale location/tab timing and the
larger mixed-tab jump is still a hypothesis until the live scenario is repeated.

Two regression checks cover repeated exact PDF-point round trips at multiple
scales and rotations, plus hiding a PDF while its geometry promise is pending.
All 16 scroll checks and the rest of `npm test` pass. The production bundle and
type check with `--skipLibCheck` pass. Lint reports the same two pre-existing
errors and four warnings.

**The new PDF build has not been validated in the live vault.** Computer control
stopped executing console/reload actions reliably and a coordinate click returned
`noWindowsAvailable`, even after the user foregrounded Obsidian and the control
session was reset. The attempted reload could not be confirmed. Reload Obsidian
before repeating the PDF-only and mixed PDF/note round trips above; do not interpret
the earlier console results as results for this new build.
