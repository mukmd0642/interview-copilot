# Power-User Efficiency Review — InterviewCopilot

*Specialist review #3: someone who runs 5–10 interviews a week. They've learned the basics; now what slows them down?*

Five-to-ten interviews a week means the same hands-on-keyboard loop repeats hundreds of times: launch CC, watch captions, copy answer, advance buffered "Next," edit JD between calls. The current build covers the basics but leans heavily on the mouse for the actions that fire most often. Below are the five wins that would compound across every session, then secondary findings.

## Top 5 highest-leverage wins

### 1. There is no keyboard shortcut for CC start/stop, Copy Answer, Next ▼, or Clear
This is the single biggest issue. The four actions a candidate hits most during an interview — start CC, copy the suggested answer, flush the buffered next answer, clear transcript between practice rounds — are all mouse-only.
- File: `src/renderer/src/lib/use-shortcuts.ts:30-104` — only browser/tab and Esc are registered; no app-level CC/answer bindings.
- Friction: every answer requires moving the mouse to the panel header (`AnswerPanel.tsx:27-34`) and clicking "Copy," then back to the caption area. In a 30-min interview with ~8-12 answers, that's 16-24 unnecessary mouse moves through a small-window UI where the cursor also covers what you're reading.
- Desired: `Ctrl+Enter` toggle CC, `Ctrl+Shift+C` copy current answer (distinct from system copy), `Ctrl+J` (or `Space` when no focused input) advance Next ▼, `Ctrl+L` clear transcript, `Ctrl+,` open Setup, `Ctrl+Shift+A` toggle Answers.

### 2. Caption panels are read-only, capped at 6 lines, with no scrollback, search, or pin
`CaptionPanel.tsx:14` slices `entries` to the last 6 lines and renders them in a non-scrollable flex body. The full `entries` array exists in the store (`store.ts:48,191-207`) but the UI throws away access to it. In a 45-minute behavioural round, the user cannot scroll back to "what was the question 5 minutes ago," cannot Cmd+F a name the interviewer mentioned, and cannot pin a requirement to keep it visible.
- Desired: panel body becomes a scrollable virtual list of full `entries`; `Ctrl+F` opens an inline find; an icon on each line pins it to a "context strip" between the caption and answer panels. Auto-scroll to bottom unless the user has scrolled up (then show a "jump to live" pill).

### 3. Status bar overwrites itself silently — losing CC failure / privacy state warnings
`Toolbar.tsx:98` is a single span fed by `applyStatus` (`store.ts:264`). Any new message immediately wipes the previous one. During CC startup a warning like "Could not start interviewer audio" (`InterviewView.tsx:134-138`) can be replaced by a benign "Connecting…" half a second later and the user never sees the problem until silence kills the interview. There is no log, no history, no severity-based persistence.
- Desired: ring buffer of last ~20 statuses, severity-weighted — `error` and `warn` persist until acknowledged (or for at least N seconds), `info` decays. A small log icon in the toolbar opens the recent-status panel. Don't make a transient string the only place a real error lives.

### 4. Setup dialog is the only path to update JD — there's no per-interview quick edit
`InterviewView.tsx:218,240-247` opens the full Setup modal for every JD swap, even though the JD is the only field that changes between interviews (resume and audio source are stable). The modal is blocking, full-page, and requires Save → CC sequence. With 5-10 interviews a week that's 5-10 round trips through a heavyweight dialog.
- Desired: a "JD" affordance directly in the toolbar (or a `Ctrl+J`-summoned popover) that opens a single textarea pre-filled with current JD, Save submits and dismisses, Cmd+Enter commits. Optionally a small history dropdown of the last 5 JDs so re-runs of the same role are one click.

### 5. Toolbar puts the most-used button (CC) third, behind Setup and Browser
`Toolbar.tsx:71-81` order is: Setup → Browser → CC → Clear. CC is the action fired every session, often under time pressure; Setup is fired once per session at most. Fitts's Law: the highest-frequency control should be leftmost (or in a stable, gesture-reachable corner), not buried after two lower-frequency buttons. Also, the status div has `flex:1` (`styles.css:230-234`) which pushes Answers/Pin/Opacity/Privacy to the far right edge — fine on 1920px, but on 1024px the variable-width status squeezes the row and the right-side cluster can be partially clipped because nothing collapses.
- Desired: CC first, then Clear, then a "context" group (JD/Setup), then status (with `min-width:0` and ellipsis), then secondary cluster. Below ~900px, ghost buttons (Lang/Theme/Opacity) should collapse into a "More" overflow menu.

## Secondary findings

**Ctrl+W silently no-ops on the interview view** (`use-shortcuts.ts:43-54`) — a power user expecting "close" gets nothing. Make it close the active *modal/panel* (history → setup → browser) so the key is always meaningful.

**Ctrl+Tab is intercepted by the window even when a webview has focus** — but per the comment at `use-shortcuts.ts:8-16`, in-webview keys aren't captured at all, so users clicking into ChatGPT cannot use *any* app shortcut without first Esc/clicking out. For a private-browser-in-the-window pattern this is a daily papercut; route critical keys through `before-input-event` in main.

**No "regenerate" or "shorter/longer" controls on AnswerPanel** (`AnswerPanel.tsx:18-38`) — only Copy and Next ▼. Otter, Cluely, Granola all expose tone/length re-rolls without restarting transcription. A `Ctrl+R` to regen and `Ctrl+[`/`Ctrl+]` to shorten/lengthen would let the user adapt in real time.

**History dialog has no search, no Delete, no "Open in current tab"** (`HistoryDialog.tsx:30-50`) — every click force-opens a new tab. For a 500-entry capped list (`store.ts:329`) this becomes unusable past the first interview.

**Clear has no confirmation and no undo** (`Toolbar.tsx:82` → `resetSessionUi` at `store.ts:266-277`). Misclicking it mid-interview vaporises the transcript, summary, and current answer with no recovery. Add an undo toast for 5-10 seconds.

**No window resize / re-position shortcuts.** Cluely-class tools offer `Ctrl+Arrow` to snap the floating window to corners. Useful because the screen-capture-protected window sits on top of an interview client and the user may want to nudge it quickly without grabbing the title bar.

**No "double Esc" panic-hide.** The privacy panic hotkey re-enables capture protection but doesn't hide the window. A `Ctrl+Shift+Esc` (or just rapid double-Esc) to also `win.hide()` is a common stealth-tool affordance worth borrowing.
