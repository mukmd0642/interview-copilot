# Competitive Research — Live Coding Interview Copilots

*Deep-research pass (107 agents, ~2.6M tokens, adversarially verified — 18 claims confirmed, 7 killed). Focus: how market tools support the live-coding round. Features & UX only.*

## TL;DR

The market converges on **one architecture, and it's exactly the capture half of our plan** — screenshot → vision LLM, hotkey-triggered, pixel-based (so portable across CoderPad/HackerRank/LeetCode/any IDE with zero per-platform integration).

**But every tool examined is single-shot. None is agentic.** No autonomous loop, no multi-file navigation, no traversing existing code to fix bugs or add features. "Debugging" = take another screenshot and re-run. Long problems = manually batch several screenshots into one request. **The agentic multi-capture loop we want to build is a genuine, unfilled gap in this market.**

## What's solidly verified

The high-confidence evidence centers on **Interview Coder** + its two open-source reproductions (verifiable down to TypeScript source) and **LeetCode Wizard** (vendor docs). Claims about LockedIn AI, Final Round AI, Cluely, Sensei AI, AmInterview's *coding* rounds were all **refuted or unverifiable** — treat their coding specifics as unknown.

### 1. Capture: screenshot → vision model, hotkey-triggered *(high)*
"Captures problems from CoderPad, HackerRank, LeetCode, or any IDE with a single keyboard shortcut. No copy-paste needed." Verified at code level: GPT-4o / Gemini / Claude vision extract the problem from screenshots; `Cmd/Ctrl+H` takes the shot. Not OCR, not browser integration, not paste. Portable *because* it reads pixels. → **Validates our capture approach exactly.**

### 2. Single-shot, not agentic *(high — verified against source, resisted vendor spin)*
`ProcessingHelper.ts` is a deterministic 3-stage pipeline (extract → generate; separate debug stage), **one API call per stage, no loop, no tool-calling, no file navigation.** The de-paywalled README says it plainly: "one model call per trigger event… no agentic loop… single-pass conversion, not an iterative multi-step agent." Interview Coder's marketing *spins* iterative debugging as agentic; the architecture refutes it. → **Our differentiator is real.**

### 3. Long problems / debugging = manual screenshot batching *(high)*
`Cmd/Ctrl+A` adds screenshots (multi-page), `Cmd/Ctrl+Enter` processes them all in **one** batched request; `Cmd/Ctrl+R` resets for a new problem. Debugging = screenshot the error, re-process. It's still a single request — not navigate-and-iterate. (Exact screenshot cap varies by build; a "2 max" claim was refuted, vendor page implies ~5.) → **We replace manual batching with an agent that decides when it has enough.**

### 4. Code output is mature — table stakes *(high)*
Switchable languages (Python/Java/JS/C++/Go, broader sets add C#/Kotlin/Ruby/Rust/SQL/Swift), **preference persisted across sessions**; step-by-step explanatory comments; **Big-O time & space complexity** framed for discussing trade-offs; **real-time streaming** into the overlay. The complexity analysis is real in the prompt code, not just marketing. → **We must match all of this or we look unfinished.**

### 5. Stealth = OS window-exclusion — and it is NOT foolproof *(high)*
Windows `SetWindowDisplayAffinity` + `WDA_EXCLUDEFROMCAPTURE` (build 19041+); macOS `NSWindow` sharing-none. Rendered as a click-through overlay. **This is exactly what we already do** — and the research is blunt that it leaks:
- Defeated by **Zoom 6.1.6+**, **macOS native screen recording (Cmd+Shift+5)**, DirectX / kernel / GPU frame grabs, QuickTime.
- **macOS 15+ ScreenCaptureKit reportedly ignores content-protection** entirely (Tauri issue #14200) — Mac stealth is weakening.
- On-device proctors (Proctaroo) "can see running applications and hidden background processes."
- Microsoft's own docs: "no guarantee… not a security feature or DRM… works only when DWM is composing."
- **Vendors themselves recommend running the answer view on a separate secondary device for 100% safety** — the de-facto fallback the whole market quietly relies on.

### 6. Real user complaints *(medium)*
Overlay buttons/pop-ups "bleed through" on newer macOS/Zoom; hands-on reviewer called the pop-ups "super obvious" and "a huge chunk of the screen"; process visible in Activity Monitor; a candidate caught on CoderPad ("Buddy, are you serious right now?"); multi-screenshot upload reported to freeze. → **Eye-movement and overlay size are real tells; our agentic flow adds reading burden, so this matters more for us, not less.**

### 7. Interaction = hotkeys + overlay, no chat thread *(high)*
De-facto shortcut vocabulary worth inheriting for muscle memory: capture `Cmd/Ctrl+H`, area-capture `Cmd/Ctrl+D`, add-screenshot `Cmd/Ctrl+A`, process `Cmd/Ctrl+Enter`, reset `Cmd/Ctrl+R`, toggle-local-visibility `Cmd/Ctrl+B`. Follow-ups ("optimize this") = re-screenshot + re-process, **not** a persistent conversation. Note: the local visibility toggle only hides on the candidate's own display — it is *not* the screen-share exclusion.

## What this means for our design (carried into coding-mode-ux.md)

1. **Our agentic loop is the differentiator** — but it's also the thing the market deliberately avoided (latency, complexity). So: **default to a fast single-shot solve; escalate to the agent loop only when the problem needs it.** Don't make every solve slow.
2. **Match table-stakes output**: persisted language picker, commented code, Big-O, streaming.
3. **Inherit the hotkey vocabulary** so switchers feel at home.
4. **Be honest about stealth.** It already works as well as the market's (same API), and it's already as fragile. Don't claim "invisible." The genuinely-safe path the whole market falls back on is a **secondary-device companion view** — worth planning as our differentiated, honest answer.
5. **Minimize on-screen reading.** The agentic flow inherently adds more glance-and-act than single-shot; short instructions, collapsible process, and the secondary-device option all mitigate the eye-movement tell.

## Final Round AI & LockedIn AI — targeted follow-up

The main workflow couldn't verify these two (the only sources it found were a low-quality blog, refuted 0-3). A focused primary-source pass (their own sites, help docs, demos, independent reviews — accessed 2026-06-03) fills the gap. Both are **more product-mature** than Interview Coder (dedicated, named coding modes) — but **neither breaks the single-shot pattern.** Our agentic differentiator survives contact with both.

### Final Round AI
- **Dedicated "Coding Copilot"** distinct from the audio/conversational copilot. *(confirmed)*
- **Capture, two paths:** (a) Chrome extension screenshots the active tab (icon turns yellow while sending; tip: Ctrl +/− to zoom so the whole question fits); (b) native desktop app reads the screen via Screen-Recording permission. Screenshot/screen-read — same family as everyone. *(vendor, independently echoed)*
- **Single-shot per capture.** No agent loop; "iteration" = re-screenshot. *(no evidence of agentic/multi-file — treat their framing as marketing)*
- **Output:** structured **Idea → Code → Walk Through → Test Cases**, ~12 languages. Big-O only *implied*, not guaranteed; streaming unconfirmed.
- **Stealth:** window-exclusion (share only the interview window). **Documented failures:** Trustpilot reviewer (May 2026) — interface "completely visible to other participants during Zoom screen sharing." Electron-overlay-in-composition-tree argument for FAANG rounds.
- **Complaints:** freezing mid-question (blank screen), stopped responding mid-interview, billing.

### LockedIn AI
- **Two dedicated modes:** "Coding Copilot" + "Online Assessment" (the latter takes **audio input**, claims to work across HireVue / CodeSignal / HackerRank). *(confirmed)*
- **Capture is the richest in the market:** **drag-to-select a screen region** ("Smart Area Selection") + manual paste + audio. "Reads the problem directly from your screen… no IDE plugins required." Vision-vs-OCR not disclosed. *(vendor)* — Note: their **region-select** is what we'd parked in our Phase 4; it's proven useful, worth pulling earlier.
- **Correction to the earlier "refuted" claim:** the **VS Code / Cursor integration is a LIVE vendor claim**, not a debunked falsehood. Homepage advertises it as "NEW" with editor hotkeys `Ctrl/Cmd+Alt+L` (send to copilot) / `Ctrl/Cmd+Alt+K` (add to context). **But** it's absent from their own coding-copilot page (which says "no IDE plugins required") and **not in the VS Code Marketplace / OpenVSX** — so it's *advertised but independently unconfirmed to ship*. The earlier workflow killed it because the *source* was unreliable, not because the feature is fake. Closest anyone gets to "work inside the editor," but it's send-selection-to-copilot, **not autonomous navigation.**
- **Single-shot / re-trigger per capture.** "Handles follow-ups" = re-querying. No multi-file/agentic evidence.
- **Output:** 12 languages, approach + **explicit Big-O** + clean code + edge cases + "communication prompts." Streaming/comments unclear.
- **Stealth:** desktop app, hidden during share, no taskbar/Dock, process aliasing ("Ghost.exe"), absent from Alt/Cmd-Tab, OS-level global hotkeys. Mechanism undisclosed. **Failures:** reviewer screenshotted the transparent window; "share entire screen" exposes it; vendor recommends a second monitor.
- **Complaints:** 3.6/5 — vague "classic AI" answers, transcription lag, the stealth screenshot leak, subscription-cancellation friction.

### What this changes for our design
1. **Agentic loop differentiator confirmed across all 5 major tools** — Interview Coder, LeetCode Wizard, Final Round AI, LockedIn AI all single-shot. The gap is real and wide.
2. **Pull region-select capture earlier** (was Phase 4). LockedIn proves "drag-select the problem" is a valued, low-friction capture that also cuts vision tokens vs full-screen. Strong candidate for Phase 1/3.
3. **Two more capture surfaces validated as alternatives** to our OS-screenshot choice: paste (everyone offers it as a fallback) and editor-send (LockedIn's claimed IDE path). We chose OS capture deliberately; keep paste as the trivial fallback.
4. **"Online Assessment" framing** (one mode that spans HackerRank/CodeSignal/HireVue, audio for non-coding Qs) is a positioning idea — our coding mode could explicitly claim platform-agnostic capture as a selling point.
5. **Structured output is the norm** (Idea→Code→Walkthrough→Tests / approach+Big-O+edge-cases). Our solution panel should mirror this structure, not just dump code.

## Caveats

- Evidence is skewed to the **Interview Coder family + LeetCode Wizard**. LockedIn/Final Round/Cluely/Sensei/AmInterview coding-round specifics are **unverified** here (every blog-sourced claim about them was refuted 0-3).
- Invisibility claims survived only as "what the vendor *claims*" — contradicted in practice. **Do not design assuming the OS flags reliably hide the overlay.**
- Stealth is a fast cat-and-mouse domain (macOS worsening, Zoom changed at 6.1.6/6.16). Anything here may shift.

## Key sources
- interviewcoder.co/coding-interview (primary vendor)
- github.com/Ornithopter-pilot/interview-coder-withoupaywall-opensource (open-source, code-level verified)
- github.com/MinhOmega/interview-coder (open-source fork)
- leetcodewizard.io/help/detection (invisibility matrix, secondary-device recommendation)
- adamsvoboda.net/how-interview-cheating-tools-hide-from-zoom (technical teardown)
- learn.microsoft.com — SetWindowDisplayAffinity (the WDA_EXCLUDEFROMCAPTURE caveats)
- TechCrunch (Proctaroo on-device detection quote)
