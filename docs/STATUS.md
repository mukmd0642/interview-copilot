# Interview Copilot — Project Status & Handoff

*Last updated 2026-06-04. Snapshot of the whole project so work can resume cleanly (e.g. in Claude CLI). Read this first, then the linked design docs.*

## What this is

Cross-platform (Electron + React + TypeScript) interview copilot — a screen-capture-hidden overlay with two modes:

- **Interview mode** — live captions of both sides of a spoken interview (dual realtime transcription) + streamed gpt-5 answer suggestions the candidate reads aloud.
- **Code mode** (newest) — an **agentic** live-coding helper: screenshots the problem, a vision + tool-calling agent solves it, and — uniquely vs. the market — when it needs more it asks the candidate to scroll/open a file and re-capture, AND it listens to the interviewer's voice for spoken context/follow-ups.

Port of an older WinForms app (`C:\Users\Administrator\Documents\Projects\WindowsUtility`) — that's the reference, not maintained.

## Build / run

```bash
cd ~/Documents/Projects/InterviewCopilot
npm install
npm run dev            # electron-vite dev (HMR)
npm run typecheck      # tsc both halves (node + web) — ALWAYS run before declaring done
npm run build:win      # NSIS installer + portable .exe  → dist/
npm run build:mac      # DMG (run ON a Mac for signing)
```

- **Login:** auth against `career-forge-web.vercel.app`; the OpenAI API key is fetched server-side and **held in the main process only** (never sent to the renderer).
- **Logs:** `%APPDATA%\interview-copilot\app.log` (Win) / `~/Library/Application Support/interview-copilot/app.log` (Mac). Renderer errors are forwarded there too (category `renderer/*`).
- **Settings:** `%APPDATA%\interview-copilot\settings.json`.
- **QA flag:** `IC_DISABLE_CONTENT_PROTECTION=1 npm run dev` boots with stealth OFF so the window can be screenshotted. Env-gated, dev only.
- **Model override:** `IC_CODING_MODEL=<model>` swaps the coding agent's model (default `gpt-5`; must support vision + tool-calling).
- **Proxy:** auto-detected from `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (upper- or lower-case). When set, ALL traffic routes through it — `fetch` (auth, coding agent, answer engine, goal transcription) via an undici global dispatcher, the realtime WebSockets via a `ws` agent, and the embedded browser via Chromium's `--proxy-server`. http(s) CONNECT proxies only (socks is logged + ignored for API traffic); embedded `user:pass@` auth works on all three. No var set = direct connections (unchanged). See `src/main/proxy.ts`. To inspect traffic through mitmproxy/Burp/Charles, also set `NODE_EXTRA_CA_CERTS=<ca.pem>` so Node trusts the interceptor's cert.

## ⚠️ Dev gotcha that cost hours — read this

`npm run dev` leaves a detached `electron-vite` watcher + an Electron instance that **hold the single-instance lock**. A leftover instance makes the *next* `npm run dev` quietly quit right after `[CMW] enter` (it fails `requestSingleInstanceLock()`), which looks exactly like a crash. Also a launched **packaged build** (`dist\…-portable.exe`, process name "Interview Copilot", NOT "electron") will squat the lock the same way.

Before booting, kill leftovers:
```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -like '*electron-vite*' } | % { Stop-Process -Id $_.ProcessId -Force }
Get-Process | ? { $_.ProcessName -eq 'electron' -or $_.ProcessName -like 'Interview Copilot*' } | % { Stop-Process -Id $_.Id -Force }
```
`Get-Process electron` alone will MISS the packaged build (different process name).

## Status by area

| Area | State |
|---|---|
| Login / auth | ✅ working |
| Privacy/stealth (Win `WDA_EXCLUDEFROMCAPTURE` via koffi FFI; Mac `setContentProtection`) | ✅ working, verified by screenshot |
| Interview mode (dual transcription, gpt-5 answers, settle/fire, buffer-don't-wipe, mic-silence auto-flush) | ✅ working; runtime-tested in a real interview |
| Embedded browser (webview tabs, history, shortcuts incl. in-webview interception) | ✅ working |
| Compact/Full layout, per-mode remembered bounds | ✅ working |
| Dark/light theme, opacity slider, EN/ES/PT-BR, answer styles | ✅ working |
| Global hotkeys (pin, stealth-panic, hide, **code capture**) — all customizable in Setup | ✅ registers cleanly |
| Production build (NSIS + portable) | ✅ working; koffi asar-unpacked verified |
| **Code mode (agentic)** | ⚠️ **runtime-proven** (gpt-5 vision + tool loop round-trips, suspend/resume, language-suggest, diff/steps all fire in real sessions). Primary issue: the **request_view spiral** — was asking for multiple files/turn against one-screen captures and exiting via MAX_STEPS; prompt now biases to one-view-per-turn + solve in 2-3 captures, with retry on transient call failures and a region-block (403) message. Needs a fresh run to confirm it now solves organically. |

## Code mode — what's built (this is the frontier)

**Main process:**
- `src/main/screen-capture.ts` — `desktopCapturer` → downscaled base64 PNG (own window auto-excluded).
- `src/main/openai/code-agent.ts` — tool-calling loop: `request_view` / `ask_user` / `provide_solution`. Suspend/resume (hands control to candidate for navigation). `MAX_STEPS=8` cap. `CODING_MODEL` constant + `IC_CODING_MODEL` env. **Accepts spoken context** at start and `provideInterviewerSpeech()` mid-session (`running` flag prevents concurrent steps).
- `src/main/coding-controller.ts` — owns capture + agent + the listen lifecycle. Buffers interviewer speech; folds it into the agent's start goal; feeds new utterances to the live agent.
- `src/main/transcription-controller.ts` — gained a **coding-routing mode** (`startForCoding`): only the system/interviewer channel, NO InterviewEngine, system finals → coding sink. Captions still emit.

**Renderer:**
- `src/renderer/src/components/CodingView.tsx` — goal bar (type + 🎤 push-to-talk), language picker, Fast/Careful, Solve / Solve-now / Reset, DO-THIS-NEXT banner (navigate or question), agent timeline, solution panel (approach + monospace code + Copy + complexity).
- `src/renderer/src/lib/record-goal.ts` — push-to-talk → 16 kHz WAV → one-shot transcription.
- Store: coding state machine (`appMode`, `codingLanguage`/`codingEffort`, timeline, phase, instruction/question/solution, `applyCodingStep`).
- Coding IPC subscriptions (`onStep`, `onCaptureHotkey`) live in **InterviewView** (always-mounted shell) so a global-hotkey start from interview mode isn't missed.
- Entering Code mode **auto-starts** interviewer-audio listening + capture; leaving stops it (mutually exclusive with interview CC — it stops CC first).

**Interaction model (per [coding-mode-ux.md](./coding-mode-ux.md)):** fast single-shot by default; the agent only asks to navigate when it genuinely needs more. Interviewer voice is fused in (context, rules, follow-ups, questions). Global capture key `Ctrl+Shift+Space` (customizable in Setup): starts a solve, or re-captures mid-session.

## Top of the TODO list (next session)

1. **Confirm the request_view spiral is fixed** — the loop is runtime-proven, but every real session was ending via MAX_STEPS (force-solve), not organically: the agent asked for multiple files per turn against one-screen captures and never got everything. Prompt now enforces one-view-per-turn + "converge in 2-3 captures", MAX_STEPS lowered 12→8, and the navigate banner has a "Solve with this" escape + capture counter. Re-run and confirm it solves in 2-3 captures. Watch `code-agent` / `coding` lines for `request_view` count and whether `forceSolve`/MAX_STEPS still fires.
2. **Syntax highlighting** — DONE (bundled highlight.js, theme-aware). Side-by-side diff + step-by-step minimal edits also added for modification tasks.
3. **Solution is delivered whole** (tool-call result), not token-streamed — acceptable per design, but a streamed `provide_solution` would feel snappier.
4. **Secondary-device companion view** — the honest-stealth answer (serve solution to a phone via localhost). Phase 5; the market's de-facto "100% safe" fallback.
5. **macOS validation** — stealth is weaker on macOS 15+ (ScreenCaptureKit ignores content-protection); coding audio needs BlackHole for system audio on Mac. Test on a real Mac.
6. **Interview-mode reliability gaps** (from the UX review, still open): WebSocket auto-reconnect, per-stream connection health dots, severity-aware status log, audio level meters. See [ux-recommendations.md](./ux-recommendations.md).

## Carryover bug-fixes already applied (from the WinForms review)

No `async void` crash paths; all `catch` blocks log; Web Audio resampling (no aliasing); cancel-on-new-question buffers instead of wiping; non-Latin transcript hallucinations filtered.

## Doc map

| Doc | What |
|---|---|
| **STATUS.md** (this) | Project state + handoff |
| [README.md](./README.md) | Doc index |
| [coding-mode-ux.md](./coding-mode-ux.md) | Code mode design (interaction model, phasing) |
| [coding-mode-plan.md](./coding-mode-plan.md) | Code mode main-process architecture |
| [research-coding-tools.md](./research-coding-tools.md) | Verified competitive research (the market is single-shot; agentic is our gap) |
| [ux-recommendations.md](./ux-recommendations.md) | Interview-mode UX roadmap (3 tiers) + the 4 specialist reviews |
| [BUILD.md](./BUILD.md) | Packaging, signing, icons, installer vs portable |

## Honest caveats

- The **code-mode agent is runtime-proven** (full tool loop, vision, suspend/resume, language-suggest, diff/steps all fire). The open issue is *convergence*, not *function* — see TODO #1 (request_view spiral). Still geoblocked without an `HTTPS_PROXY`: OpenAI returns 403 `unsupported_country_region_territory` on direct connections.
- **Stealth is not foolproof anywhere** (same ceiling as the whole category — Zoom 6.1.6+, macOS recording, on-device proctors all defeat window-exclusion). The only genuinely-safe path is the secondary device.
- This tool fabricates interview content by design; that's a product/ethics decision the owner has made. The code is honest about what it does.
