# Coding Mode — UX Design

*Design for the agentic live-coding-interview mode, grounded in [research-coding-tools.md](./research-coding-tools.md). Supersedes the UX portions of [coding-mode-plan.md](./coding-mode-plan.md); that doc's main-process architecture still stands.*

## Design principles (what the research forces)

1. **Fast by default, agentic only when needed.** The market is single-shot because it's fast and proven. Our agent loop is the differentiator but it's slower. So the *common* case — one screenshot of a self-contained problem — must resolve in a single fast pass, same speed as Interview Coder. The loop only engages when the model genuinely needs more (long problem, references other files). **Never make a simple solve slow.**
2. **Match table stakes or look unfinished.** Persisted language picker, commented code, Big-O complexity, streaming output. All universal in the market.
3. **Inherit the hotkey vocabulary.** Switchers from Interview Coder/LeetCode Wizard have muscle memory: capture, add, process, reset, hide.
4. **Minimize on-screen reading.** Our advise-and-navigate flow inherently adds more glance-and-act than a single answer. Every extra word on screen is eye-movement risk. Short instructions, collapsible process, the code as the one thing in focus.
5. **Honest stealth.** We use the same OS flags as everyone — and they leak the same way (Zoom 6.1.6+, macOS recording, secondary device the universal fallback). Don't claim invisible. Offer the genuinely-safe path.

## The core interaction model

A **bounded agent loop that resolves on turn 1 for simple problems.** One mental model, two speeds.

```
Candidate: (optional) set goal — type or speak
Candidate: press Capture & Solve  ──► screenshot ──► agent
Agent decides:
  ├─ "I have everything"      ──► stream solution        ◄── 80% of cases, ~single-shot speed
  ├─ "show me the rest"       ──► instruction: ⬇ scroll, capture again
  ├─ "I need another file"    ──► instruction: 📂 open X, capture again
  └─ "which constraint?"      ──► question: ❓ quick answer
Candidate complies, captures again ──► back to agent (context accumulates)
Candidate can ALWAYS press "Solve now" ──► force a solution with whatever's captured
```

The escalation is the product. Interview Coder makes the candidate *manually* batch screenshots and guess when they've shown enough; our agent *tells* them exactly what's missing and decides when it has enough. For multi-file bug-fixes / feature-adds — which the market cannot do at all — the agent walks the candidate file by file.

## Screen layout

A dedicated **Coding view** (toolbar "Code" toggle switches the whole shell between Interview and Coding). Three zones:

```
┌─────────────────────────────────────────────────────────┐
│ GOAL BAR:  [ goal text… ] [🎤] [Lang ▾] [Fast|Careful] [Capture & Solve ⌨] │
├──────────────────┬──────────────────────────────────────┤
│ AGENT TIMELINE   │  SOLUTION                             │
│ (compact, collapsible) │  approach: one line             │
│ 📸 Captured 1    │                                       │
│ 🔍 thinking…     │  ```python                            │
│ ⬇ need the rest  │  def solve(...):     ← syntax hilit   │
│ 📸 Captured 2    │      ...                              │
│ ✅ solved        │  ```                                  │
│                  │  ⏱ Time O(n)  Space O(1)   [Copy code]│
├──────────────────┴──────────────────────────────────────┤
│ ▸ DO THIS NEXT  (only when agent needs you) ─ big, short │
└─────────────────────────────────────────────────────────┘
```

- **Goal bar** — task text (optional; blank = "solve what's on screen"), 🎤 push-to-talk voice goal, language picker (persisted), Fast/Careful toggle, the Capture & Solve button with its hotkey shown.
- **Agent timeline** — the running step list, compact and collapsible. It's *reassurance* ("something is happening"), not primary reading. Default collapsed to a one-line status once a solution is up.
- **Solution panel** — the focus. Approach (one line), code (monospace → syntax-highlighted in phase 2), complexity, **Copy code** (copies only the code, not the prose). This is what the candidate reads/types from.
- **DO THIS NEXT banner** — appears *only* when the agent emits an instruction or question. Big, ultra-short, glanceable: `⬇ Scroll down, then Capture` / `📂 Open the file with parseConfig(), then Capture` / `❓ Optimize for time or space? [time] [space]`. Disappears the moment the candidate acts.

## Agent loop — states & what the candidate sees

| State | Timeline | Banner | Solution panel |
|---|---|---|---|
| idle | — | — | empty / last solution |
| capturing | `📸 Captured N` | — | — |
| thinking | `🔍 thinking…` + elapsed timer (Careful can be 30s) | — | dimmed |
| needs view | `⬇/📂 <reason>` | **shown, prominent** | unchanged |
| needs answer | `❓ <question>` | **shown, with quick-pick or type** | unchanged |
| solving | `✍ writing solution…` | — | streaming in |
| done | `✅ solved` (auto-collapses) | — | final code |
| error | `⚠ <message>` | shown | error text |

The **elapsed timer in "thinking"** directly addresses the research finding that long agent turns feel frozen. The **auto-collapse on done** keeps the screen minimal for reading.

## Hotkeys (mode-aware; aligned with the market)

In Coding mode, inherit the de-facto vocabulary so switchers feel at home — but resolve our existing clashes (Ctrl+H = browser history) by making these **only active in Coding mode**, except the global capture key:

| Action | Key | Notes |
|---|---|---|
| **Capture & Solve / next capture** | **global** accelerator (proposed `Ctrl+Shift+S`) | Must be global — fires while focus is in the editor. Configurable like pin/privacy/hide. The one key the candidate presses most. |
| Solve now (force) | `Ctrl+Enter` | Stop gathering, answer with what's captured. Market convention. |
| New problem / reset | `Ctrl+Shift+R` | Clears the session. |
| Copy code | `Ctrl+Shift+C` | Just the code block. |
| Toggle window hide | existing `Ctrl+Shift+H` global | Already built (panic-hide). |

Why not reuse market's bare `Ctrl+H`/`Ctrl+A`/`Ctrl+R`: those collide with our browser shortcuts and with select-all in the goal box. We keep the *shape* (one key to capture, one to process, one to reset) but pick non-colliding chords. Capture is global; the rest are mode-scoped.

## Goal input — voice + typed

- **Typed**: the goal box. Enter does *not* submit (capture hotkey does) so the candidate can edit freely.
- **Voice (push-to-talk)**: hold 🎤 → record mic via MediaRecorder → one-shot transcription through the OpenAI REST endpoint (decoupled from the live realtime pipeline) → fills the goal box. Lets the candidate state the task hands-free ("add input validation to the parse function") without typing on a watched screen. Editable after transcription.

## Honest stealth + the secondary-device answer

The research is unambiguous: our window-exclusion is **as good as the market's and as leaky as the market's.** Design accordingly:

- **Don't claim invisible.** Coding mode reuses the existing content-protection + panic-hide. Same Windows `WDA_EXCLUDEFROMCAPTURE`, same caveats.
- **Surface the failure modes** in a one-time Coding-mode notice: not safe against Zoom 6.1.6+ default capture, macOS native recording (Cmd+Shift+5), or on-device proctors. macOS is weaker than Windows (ScreenCaptureKit on 15+ may ignore the flag).
- **The differentiated, honest path — secondary-device companion (future, high-value):** serve the solution panel to a `localhost` URL the candidate opens on their **phone**. Nothing about the answer is ever on the shared screen — the one approach the whole market admits is actually safe, and which sidesteps the eye-movement tell entirely for the agentic flow. Phase it after the core, but design the solution-rendering so it can fork to a companion view.

## Reading-burden mitigations (the eye-movement tell)

Our advise-and-navigate model adds glances vs a single answer. Counter it:
- Instructions are **imperative and tiny** — "⬇ scroll, capture" not a sentence.
- Timeline **collapses** to one line once solved; the code is the only thing to read.
- **First sentence / approach line first**, so a single glance gives the candidate something to say while they read on (mirrors the conversational engine's "first sentence answers it" rule).
- The **secondary-device view** is the real fix for heavy back-and-forth — promote it for multi-file sessions.

## What we match vs. what differentiates us

**Match (table stakes):** screenshot→vision capture, persisted language picker, commented code, Big-O complexity, streaming, hotkey-driven, overlay read, market hotkey shape.

**Differentiate (the gap nobody fills):**
1. **Agentic multi-capture loop** — the agent decides when it has enough and *tells the candidate what's missing*, instead of manual screenshot-batching and guessing.
2. **Multi-file fix/feature on existing code** — walk the candidate file-by-file to fix a bug or add a feature across a repo. No tool in the market does this.
3. **One app, two modes** — coding shares the shell with the conversational copilot; a spoken interviewer follow-up ("now make it thread-safe") can feed the coding context.
4. **Honest stealth + secondary-device companion** — the safe path stated plainly, not marketing "100% invisible."

## Honest tradeoffs (state these, don't bury them)

- **Agentic = slower than single-shot.** Mitigated by the fast-path-on-turn-1 default; the loop is opt-in escalation, not mandatory.
- **More reading than a single answer** during a watched share. Mitigated by tiny instructions, collapse-on-done, and the secondary-device view.
- **Stealth is not guaranteed** — same ceiling as the entire category. The only honest "safe" is the companion device.
- **Vision cost/latency** grows as captures accumulate (multi-file sessions can be 30k-50k tokens). Cap loop iterations; keep recent images, summarize old ones.

## Revised phasing (UX-driven)

| Phase | Scope |
|---|---|
| **1** | Coding view + goal bar (typed) + **fast-path single-shot** capture→vision→solution panel (plain code + copy + complexity) + global capture hotkey + language picker + Fast/Careful. *Matches the market.* |
| **2** | The **agent loop**: request-view / ask-user / solve tools; timeline; DO-THIS-NEXT banner; "Solve now" force. *The differentiator.* |
| **3** | Syntax highlighting; voice goal (push-to-talk); reset/copy hotkeys; multi-monitor picker. |
| **4** | Multi-file fix/feature polish; context-budget management (summarize old captures). |
| **5** | Secondary-device companion view. *The honest stealth answer.* |

Phase 1 alone is a shippable Interview-Coder-equivalent. Phase 2 is where we pass it.

## Open decisions for build time

- Final global capture accelerator (proposed `Ctrl+Shift+S`) — confirm no clash on the candidate's setup.
- Default language (proposed Python) and the picker list.
- Careful-mode reasoning effort ceiling (`high` vs `medium`) — quality vs the 30s wait.
- Whether the timeline is visible by default or collapsed until the agent needs something.
