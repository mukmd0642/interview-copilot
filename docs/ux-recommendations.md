# Interview Copilot — UX Recommendations

*Synthesis of four parallel specialist reviews (engine logic, onboarding, power-user, failure modes). Each finding below has at least one of those reports as evidence; see [`ux-review-*.md`](.) for the raw analyses.*

---

## Executive summary

The app's core pipeline works. Captions stream, answers generate, privacy mode works, the audio plumbing is right. The remaining UX gap is in the **margins around the happy path**: what happens before the first question, what happens when something breaks, what happens when the candidate isn't reading the answer at the exact moment it appears, what happens at minute 28 of a 30-minute call.

Almost every issue traces back to one of four root causes:

1. **One-slot status string.** A single `applyStatus` overwrites itself — so warnings, errors, and benign "Connecting…" messages all share the same pixels. Recoverable problems become invisible.
2. **No diagnostic surfaces.** No audio level meters, no connection health dots, no in-app log viewer. The candidate cannot tell the difference between "this isn't working" and "nothing was said".
3. **Cold-start has no shape.** Post-login, the user lands in a dense 10-button UI with four empty panels and a one-line hint. The product never explains itself.
4. **The settle/cancel/buffer logic optimizes for one interviewer style.** Fast-cadence interviewers get a great experience; slow hedgers and rapid-fire askers get cut-off answers and 8-second silences.

Fix those four root causes and 80% of the specialist findings resolve as a side effect.

---

## Cross-cutting themes

### Theme A — "The candidate is flying blind"

Across all four reviews: when something is going slowly or going wrong, the user has no instruments. No audio meter to confirm the mic is being picked up. No connection dots to confirm OpenAI is reachable. No scrollback to verify a question was captured. No log to see why a generation failed. The frame is "trust the system" — and trust dies the first time a candidate doesn't get an answer they urgently needed.

This is the single biggest UX gap, and it shows up under both "first impression" and "mid-interview failure" framings.

### Theme B — "First-impression sells the wrong product"

The login screen says **Interview Copilot**. The post-login UI says nothing. A new user with a 20-minute runway is asked to: (1) figure out what "CC" means, (2) understand that "Priv ON" means their interviewer can't see the window, (3) install BlackHole if they're on Mac, (4) infer that Setup needs to come first. Nothing about the post-login view orients them.

Competitors (Cluely, Final Round AI, Sensei AI) all front-load a "Test your setup" / "Mock question" flow. Ours has none.

### Theme C — "Answers are timed for one interviewer style"

The engine's `SETTLE_AMBIGUOUS_MS = 3500` produces a great experience when interviewers end questions with clear punctuation. For interviewers who think out loud, hedge, or ask multi-part questions, it produces 5–8 second freezes and bundled answers. For interviewers who interrupt or chain questions, the cancel-on-new-question wipes answers the candidate was mid-reading. The buffered "Next ▼" mechanism exists but isn't used during in-flight generation — and even when it is, it's visually invisible.

### Theme D — "The keyboard story is half-built"

We have global hotkeys for pin/privacy and browser shortcuts for tab management. We don't have hotkeys for the actions the candidate does most: start/stop CC, copy the suggested answer, flush the buffered "Next" answer, clear the transcript. Every interview involves dozens of unnecessary mouse trips.

### Theme E — "Stop / start / failure paths have races and silent failures"

Multiple failure paths are silently swallowed (empty catches in WebSocket sends, `connect()` that resolves on error instead of rejecting, status overwrites that erase critical errors). A user clicking Stop while Start is mid-flight can end up with stuck audio capture and no UI state to indicate it. WebSockets that die mid-session don't reconnect. There's no token refresh.

---

## Prioritized recommendations

Roadmap below is organized by **impact × effort**. Effort estimates: S = under an hour, M = half a day, L = day or more.

### Tier 1 — Ship this week (high impact, low/medium effort)

These directly address Themes A, C, D, E and unblock several Tier-2 items.

| # | What | Why | Effort |
|---|---|---|---|
| 1 | **Replace single-slot status with a severity-aware log + sticky-banner pattern.** `info` messages can decay; `warn` and `error` persist until acknowledged or auto-decay after ~10s. Add a small log-icon button that opens a 20-line ring-buffer history. | Eliminates the meta-problem that hides every other failure. Without this, fixes #6, #8, #11 below all leak. | M |
| 2 | **Rename "CC" → "Start" / "Stop" with a live dot when active.** | Removes the single biggest "what does this button do" mystery for new users. (Onboarding finding #2) | S |
| 3 | **Add app-level hotkeys: `Ctrl+Enter` toggle CC, `Ctrl+Shift+C` copy answer, `Space` flush Next, `Ctrl+L` clear (with confirm), `Ctrl+,` Setup, `Ctrl+R` regenerate.** | Removes 16–24 mouse trips per 30-min interview. (Power-user #1) | S |
| 4 | **Two-clock settle:** *soft* settle 1500ms reset-on-text, *hard* settle 3500ms measured from `pendingQuestion` start. Plus question-shaped detection (starts with How/What/Why/Tell/Walk/Describe/Can/Could/Do/Are/Have/etc.) → soft settle drops to 800ms. | Slow / hedging interviewers stop creating 5–8s freezes. (Engine #2) | M |
| 5 | **Stop wiping the answer pane on new-question. Always buffer.** Use the existing `pendingAnswer` machinery — START signal during streaming sets `pendingReady=true` instead of clearing `answerBox`. | Candidate doesn't lose their place mid-sentence when interviewer adds a follow-up. (Engine #4) | M |
| 6 | **Make `realtime-client.ts::connect()` reject on error instead of silently resolving.** Wire `onConnectionChange` from each of the four clients to a per-stream health indicator. | Half-broken sessions stop pretending to be healthy. (Failure modes #1, #2) | S |
| 7 | **Lower `MIN_WORDS_TO_FIRE` from 3 to 1 when the utterance ends in `?` or starts with a question word.** | "Why MongoDB?" / "Scale?" / "Tradeoffs?" stop being silently swallowed. (Engine #3) | S |
| 8 | **Don't dump raw API JSON into the answer pane on 429/500.** Classify the error, show a sticky banner ("OpenAI is rate-limiting — answers paused; retrying in Xs"), retry with backoff using `Retry-After` if present. | Stops printing `[Error: OpenAI 429: {...}]` where the answer should be. (Failure modes #3) | S |
| 9 | **Confirm or undo for the Clear button.** Toast with "Undo" for 8 seconds. | One misclick mid-interview vaporizes the entire session. (Power-user secondary) | S |
| 10 | **Toolbar reorder so CC is the leftmost action button.** Setup demotes to ghost-style after first save. Below ~900px, ghost buttons collapse into a "More" overflow. | Fitts's Law on the most-frequent button. (Power-user #5; Onboarding secondary) | S |

**Tier 1 total: roughly 1–2 days of focused work for the most-felt improvements.**

### Tier 2 — Ship next sprint (higher effort, essential)

Once Tier 1 lands, these layer on top of the new infrastructure.

| # | What | Why | Effort |
|---|---|---|---|
| 11 | **Audio level meters under each caption panel header.** Live RMS from the worklet at 20 Hz, posted via existing IPC. | Solves "is my mic working" / "is BlackHole routed" without leaving the app. Theme A. | M |
| 12 | **Scrollable caption history with `Ctrl+F` search.** Drop the 6-line cap, virtual-scroll the full `entries` array. Auto-stick-to-bottom unless scrolled up; show "Jump to live" pill. | A 45-min behavioral round becomes searchable. (Power-user #2) | M |
| 13 | **WebSocket auto-reconnect with exponential backoff.** Up to 5 attempts, 1s/2s/4s/8s/16s. Each attempt produces a sticky status. Resume audio buffering on reconnect (the worklet keeps sending; we just queue or drop). | The single biggest mid-interview reliability gap. (Failure modes #1) | M |
| 14 | **First-run onboarding overlay.** A 3-step checklist on the post-login view: ☐ Add JD + Resume ☐ Test audio ☐ Try a sample question. Dismissible. | Anchors the cold-start experience. (Onboarding #1, #4) | M |
| 15 | **"Test your setup" panel.** Plays a tone, asks the user to speak, shows level meters for both sources, runs a single round-trip through realtime + engine. Pass/fail per source. | Catches BlackHole / mic / desktop-audio misconfigurations before the real interview. (Onboarding #1, #3; Failure modes #11) | L |
| 16 | **Pending-answer visual signal + `Space` to flush.** Pulsing colored bar at top of answer pane, line-count of buffered content, keyboard binding. Auto-flush on detected candidate silence (~2s of no mic activity). | Makes the buffered-answer pattern actually usable in real time. (Engine #5) | S |
| 17 | **Shortcuts cheat sheet behind a `?` button** (and `F1`). Lists every binding with its current action. | Makes hotkeys discoverable. (Onboarding #5) | S |
| 18 | **Quick-edit JD popover.** `Ctrl+J` or a "JD" toolbar chip → single textarea pre-filled with current JD, Save+dismiss on `Ctrl+Enter`. Optional: dropdown of last 5 JDs. | The only field that changes per-interview gets a per-interview path. (Power-user #4) | S |
| 19 | **Privacy mode education on first run.** Single inline card: "Hidden from screen capture (verified) — interviewer cannot see this window even during a screen-share. Press Ctrl+Shift+\\ to re-enable if it ever turns off." | Otherwise users panic-test it mid-interview. (Onboarding #4) | S |
| 20 | **OS deep-links on permission errors.** When mic permission is denied, show "Open System Settings" button. Windows: `ms-settings:privacy-microphone`. Mac: `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`. | Recovery without a Google search. (Failure modes #6) | S |

### Tier 3 — Longer-term polish

These are the items that make the product *feel* polished rather than fix outright problems.

| # | What | Why |
|---|---|---|
| 21 | **Mock-interview mode.** Pre-canned questions, pre-canned reference answers, real engine pipeline. Use this as both the onboarding "first try" and as ongoing practice. |
| 22 | **Tempo adaptation.** Track rolling avg time between interviewer finals; scale answer-length targets (engine system prompt) accordingly. Fast interviewer → shorter answers. |
| 23 | **Regenerate / Shorter / Longer / Tone controls** on the answer pane, with `Ctrl+R`, `Ctrl+[`, `Ctrl+]`. Re-streams against the existing question. |
| 24 | **Interview-type presets** in Setup: Behavioral / Technical / System Design / Recruiter Screen / Final Round. Each preset adjusts the system prompt's question-type weighting. |
| 25 | **Speakerphone-bleed echo detection.** If the same text appears on mic within 1.5s of a system final, drop the system final (it's the candidate's own voice looping back). |
| 26 | **Chain-of-questions splitter.** Detect "Tell me X. What about Y. And Z?" pattern; answer each separately with light context carry. |
| 27 | **Token-expiry refresh path.** Today auth fetches the OpenAI key once at login and never re-fetches. Add a refresh on 401 from any OpenAI call. |
| 28 | **`MediaStreamTrack.onended` + `ondevicechange` listeners.** Detect mic unplug / disable mid-session, prompt the user. |
| 29 | **`AudioContext` resume on visibility change.** Currently resumes once at startup; can suspend after backgrounding. |
| 30 | **Webview `before-input-event` interception.** Make app-level shortcuts work even when the embedded ChatGPT tab has focus. (Power-user secondary) |
| 31 | **`Ctrl+Arrow` window-snap shortcuts.** Snap to screen corners; useful when the floating copilot is on a second monitor alongside Zoom. |
| 32 | **Demote Setup button to ghost styling after configured.** Visual hierarchy follows what the user still needs to do. |
| 33 | **Highlight the first sentence of each answer** (bold or border). The engine prompt already guarantees the first sentence answers the question on its own; the UI should signal where to start reading. |
| 34 | **Telemetry-free crash dialog.** When `unhandledRejection` fires, show "Something broke — here's the log file path. Reload?" instead of silent log entry. |

---

## Top-3 "if I only ship three things this week"

If you only act on three items, do these. They are individually high impact and they *unlock* most of the other Tier-1 work:

1. **#1 — Severity-aware status log + sticky banners.** Until this lands, every other error fix leaks. This is the platform for surfacing the next 20 things.
2. **#3 — App-level hotkeys for Start / Copy / Next / Clear.** Compounds across every session forever. One day of work, value every day after.
3. **#4 + #5 — Two-clock settle + buffer-don't-wipe.** Together they kill the two worst "feel" issues: the 5–8s freezes and the mid-reading wipe.

Everything else, including the onboarding overlay, audio meters, and auto-reconnect, is high-value but easier to slot in once these three are foundational.

---

## What I'd argue against

A few competitor-driven items are worth *not* doing yet, despite the agents flagging them:

- **Onboarding tour / coachmarks.** A 3-step checklist (#14) gives most of the value at 10% of the build cost. Save coachmarks for a polish pass.
- **Interview-type presets.** Tempting, but the current system prompt's question-type matrix is already doing this work implicitly per-question. Presets add a UI surface that the engine doesn't actually need yet. Revisit after #4 + #5 land.
- **History search.** The Browser-tab history (`HistoryDialog`) is fine as-is. Investing in caption-panel search (#12) is more important.
