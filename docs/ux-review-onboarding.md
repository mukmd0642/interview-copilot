# Cold-Start UX Review: Interview Copilot

*Specialist review #2: first-time / new-user experience. The user has a real interview in 20 minutes and has never seen this app before.*

A first-time user with a 20-minute runway will hit several friction points before they get a single caption on screen. Below are the highest-impact problems, then secondary findings.

## Top 5 user-hostile moments

### 1. The post-login view explains nothing about what this app is or does
**What the user feels:** They sign in, the window slides into view, and they see a 10-button toolbar across the top, four empty panels labelled INTERVIEWER / YOU / SUGGESTED ANSWER / KEY POINTS, and a tiny status string telling them to "Click Setup to enter job details & resume, then CC to start." That status line is the *only* in-product explanation of what the app does — and it's smaller than every button. There is no welcome card, no product tagline, no "How it works in 30 seconds." The login screen's `<h1>` says "Interview Copilot"; after login, the words "interview copilot" never appear again.

**Code:** `App.tsx` jumps straight from `LoginForm` to `InterviewView`; `InterviewView.tsx` lines 70-76 set the only orienting message into the toolbar status.

**Fix:** First-run empty-state overlay or coachmarks on the four panels ("This is where the interviewer's words will appear once you start CC"). At minimum, replace the status string with a centred, prominent first-run banner: "Welcome. To begin: 1) Setup → paste the JD & your resume, 2) Pick how to hear the interviewer, 3) Click CC."

### 2. "CC" is the central verb of the product and nobody knows what it means
**What the user feels:** "CC" reads as "carbon copy" or "closed captions" — neither maps to "start the interview assistant." The toolbar has Setup (clear), Browser (clear), **CC** (?), Clear (so... CC adds and Clear removes?), and CC* when active (an asterisk that means nothing).

**Code:** `Toolbar.tsx` lines 75-81. The button is labelled `CC` / `CC*` with no `title` attribute and no surrounding label.

**Fix:** Rename to "Start" / "Stop" (or "Listen" / "Stop listening") with a small "CC" subscript if the brand language matters. Replace `CC*` with `■ Stop` or a live dot. Add a tooltip the first time.

### 3. The Setup dialog hands a Mac user a homework assignment, not an interview tool
**What the user feels:** On macOS, the audio source default is `{ kind: 'off' }` (`settings.ts` line 16). Setup opens, the hint says: *install BlackHole, route system output to it via a Multi-Output Device, then come back and pick it.* Multi-Output Device requires Audio MIDI Setup.app, three sub-steps, knowing what "aggregate output" means, and switching the OS default output before the interview — none of which is in the hint or linked. The hint links the BlackHole download page only. There is no "Test it's working" feedback loop; the user saves Setup, clicks CC, and either the interviewer panel populates or it doesn't, with no diagnostic.

**Code:** `SetupDialog.tsx` lines 133-152. The hint is a single sentence.

**Fix:** Replace the inline hint with a step-by-step modal ("Set up interviewer audio on Mac") with screenshots of Audio MIDI Setup, a "Test Audio" button that plays a system sound and shows a live level meter on the selected device, and a clear pass/fail. The first 30 seconds of an interview is the worst time to discover BlackHole isn't routed.

### 4. Privacy mode is invisibly ON and the UI never explains the trade-off
**What the user feels:** The window is hidden from screen capture, taskbar, and Alt+Tab by default. The user might Zoom-share their screen to confirm the link works, see the copilot is invisible, and conclude *the app is broken* — or worse, *not* test it and assume the interviewer will see it, then panic-quit mid-interview. They see a "Priv ON" button (`Toolbar.tsx` line 120) with no tooltip, no explanation, no first-run tour.

**Code:** `Toolbar.tsx` lines 116-121; the `togglePrivacy` confirm dialog at line 31 only warns when *disabling*.

**Fix:** First-run "Privacy mode is ON — your interviewer can't see this window even if you screen-share. Click here to verify with a test screenshot" affordance. Add a tooltip on the button. Consider a "Test screen-share" helper that takes a screenshot via the OS and shows the user proof the window was excluded.

### 5. Hotkeys are undiscoverable and one of them is load-bearing
**What the user feels:** Ctrl+\ is the *only* way to bring the window back after Unpin (the window is hidden from Alt+Tab and taskbar — see `shortcuts.ts` lines 7-9). The Unpin button's `title` mentions Ctrl+\, but only if the user hovers it. There is no Help menu, no shortcuts cheat-sheet, no in-app reference. If they click "Unpin" to move it out of the way during a non-pinned moment, they may lose the window and not know how to recover.

**Code:** `Toolbar.tsx` line 109 (title attribute only); `shortcuts.ts` defines the hotkey; nothing surfaces it.

**Fix:** Add a "?" / "Shortcuts" button to the toolbar opening a small reference panel. Show a one-time toast the first time Unpin is clicked: "Window hidden. Press Ctrl+\ to bring it back."

## Secondary findings

- **"Next ▼" appears with no explanation.** `AnswerPanel.tsx` lines 14-26: a button labelled `Next ▼` materialises in the header when `pendingReady` is true. New user has no model of *buffered answers* — they'll either ignore it or click it and not understand what changed. Needs a label like "New answer ready" and a tooltip on first appearance.
- **Loading state is silent.** Between clicking CC and the first transcript word, the user sees: status flicks to "Connecting…" then the panels stay empty. No skeleton, no level meter, no "Listening — say something to test." On a Mac with mis-routed BlackHole the user has no signal that the interviewer side is dead until silence persists. Add a per-source listening indicator (live audio meter under each caption panel header).
- **No mic / system audio permission preflight.** `startCc` (`InterviewView.tsx` lines 121-164) jumps straight to `startCapture`; if the OS prompt fires mid-call it could derail the candidate. Run a permission probe during onboarding or first Setup save.
- **`Setup` button is `--primary`-styled even after JD/resume are saved.** `Toolbar.tsx` line 71. Demote to ghost styling once configured, so the *next* required action (CC) reads as the primary CTA.
- **"Answers" checkbox is a hidden landmine.** Toolbar far-right, unlabelled context — toggling it off mid-interview silently stops AI suggestions. Move under Setup or add a confirm.
- **Login screen has no sign-up / forgot-password / SSO.** `LoginForm.tsx` is just two inputs and a button. If the user mistypes their password they're shown an error but no recovery path.
- **Language toggle silently doesn't take effect until next CC start** — tooltip says so (`Toolbar.tsx` line 86), but a user who clicks it mid-session will think it changed and lose trust when it didn't.

## Table-stakes gaps vs Cluely / Final Round AI / Sensei AI

- **No "Test your setup" pre-interview screen** with mic level, interviewer-audio level, and a sample question/answer round-trip. This is the single most universal feature among competitors and the most catastrophic to lack.
- **No interview-type / role / company picker.** Setup is just two free-form blobs; competitors offer "Behavioral / Technical / System Design" presets that tune the answer style.
- **No "How to position the windows on your second monitor" / Zoom-overlay guide.** The privacy-mode value prop is undersold; users need an explicit "Here's where to put us during a Zoom call" diagram.
- **No onboarding checklist** ("1. Add your resume ✓  2. Test audio  3. Run a mock question"). Even a static four-step list during first run would address findings 1, 3, and 4 at once.
- **No mock interview / dry-run mode.** A user with 20 minutes wants to verify the system works before the real call. There's no built-in "Read me a sample question" affordance.
