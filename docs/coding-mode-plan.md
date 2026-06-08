# Coding Mode — Implementation Plan

Live-coding-interview support: hotkey → screenshot the problem → vision model →
streamed code solution in a dedicated panel.

## Locked decisions

| Decision | Choice |
|---|---|
| Capture surface | **OS full-screen** (`desktopCapturer`), hotkey-triggered. Universal — works with web platforms (CoderPad/HackerRank) and native desktop apps alike. |
| Mode model | **Separate Coding mode** — a top-level view switch, its own panel layout. |
| Speed vs correctness | **Fast / Careful toggle** per solve. Fast = `reasoning_effort: minimal` (~3–8s). Careful = `high` (~10–30s, better code). |

## Why this is mostly reuse

The hard infrastructure already exists:
- `desktopCapturer` is wired up (we use it for audio loopback in [main/index.ts](../src/main/index.ts)). Grabbing a screen PNG is one call.
- `stream()` in [interview-engine.ts](../src/main/openai/interview-engine.ts) already does abortable SSE chat-completion streaming with key management. Vision = extend the message `content` to carry an image block. Same endpoint, same key, same loop.
- The global-hotkey machinery in [shortcuts.ts](../src/main/shortcuts.ts) (recently refactored to take accelerators as params) is the pattern for the capture hotkey.
- The store + panel + IPC-event pattern from the answer pipeline maps directly onto a code pipeline.

What's genuinely new: screen capture → base64, a vision message shape, a coding system prompt, and a code-output panel with syntax highlighting.

## Architecture

### Main process

**`src/main/screen-capture.ts` (new)**
```
captureScreen(): Promise<{ pngBase64: string; width: number; height: number }>
```
- `desktopCapturer.getSources({ types: ['screen'], thumbnailSize: <primary display work area> })`
- Take `sources[0].thumbnail` (a NativeImage at full res), `.toPNG()`, base64.
- Downscale **moderately** to ~1568px wide before encoding — enough to cut vision tokens/latency, but code text is small so we must not over-shrink or the model misreads identifiers.
- Our own window is auto-excluded by `WDA_EXCLUDEFROMCAPTURE`, so the screenshot cleanly shows the editor behind it.
- **Multi-monitor (Phase 1):** capture the primary display only; log if >1 screen detected. Picker is Phase 2.
- **macOS:** requires Screen Recording (TCC) permission; first call triggers the OS prompt. May light the menu-bar indicator. Add `NSScreenCaptureUsageDescription`-style note to entitlements when Mac build is done. (No-op on Windows.)

**`src/main/openai/code-engine.ts` (new, or method on InterviewEngine)**
```
generateCodeSolution({ pngBase64, language, effort, audioContext? }, signal): stream
```
- Builds a vision chat-completion: system prompt + user message with `[{type:'text', text}, {type:'image_url', image_url:{url:'data:image/png;base64,…'}}]`.
- `model: 'gpt-5'`, `reasoning_effort: effort === 'careful' ? 'high' : 'minimal'`.
- Streams chunks back exactly like the answer pipeline.
- `audioContext` (optional, Phase 3): the last few interviewer/candidate transcript turns, so follow-ups like "optimize the space" have context.

**Coding system prompt (new, distinct from the interview-coach prompt):**
> You are solving a coding problem shown in a screenshot from a live technical interview. The candidate will type your solution. Respond with, in order:
> 1. ONE sentence naming the approach.
> 2. Complete, correct, runnable **{LANGUAGE}** code. No placeholders, no `// TODO`, handle edge cases and empty/`null` input.
> 3. Time and space complexity, one line.
> 4. One or two edge cases worth mentioning aloud.
> Keep the code idiomatic and readable — the candidate may have to explain every line.

### IPC

Add to [shared/ipc.ts](../src/shared/ipc.ts):
- `IPC.Coding.Solve` (renderer→main invoke): `{ language, effort }` → main captures + solves, streams back.
- `IPC.Events.CodeChunk` (main→renderer): `{ text, done }` — same shape as `AnswerChunk`.
- Capture can also fire from a **global hotkey** (e.g. `Ctrl+Shift+Enter`) so it works while focus is in CoderPad — routes through shortcuts.ts → same solve path.

### Renderer

**`CodingView.tsx` (new)** — parallel to `InterviewView`, shown when coding mode is active. Toolbar gets a **Code** toggle.

**`CodePanel.tsx` (new):**
- Language picker (default Python) + Fast/Careful toggle (bound to settings).
- "Solve — capture screen" button + hotkey hint.
- Code area: monospace, syntax-highlighted (bundle **highlight.js** — CSP blocks CDN).
- **Copy Code** button — copies *only* the code block, not the prose.
- Collapsible approach + complexity above the code.
- A "Solve again" / follow-up affordance (re-captures).

**Store additions** ([state/store.ts](../src/renderer/src/state/store.ts)): `codingMode`, `codingLanguage`, `codingEffort`, `codeSolution`, `codeStreaming`, plus `applyCodeChunk`.

**Settings** ([main/settings.ts](../src/main/settings.ts)): persist `codingLanguage` and `codingEffort`.

## Phasing

| Phase | Scope | Effort |
|---|---|---|
| **1 — MVP** | screen-capture.ts → vision stream → CodingView + CodePanel (plain monospace code + Copy) → capture button + global hotkey → language picker + Fast/Careful. End-to-end solve. | ~1.5 days |
| **2 — Polish** | highlight.js syntax highlighting, approach/complexity split, multi-monitor picker. | ~½ day |
| **3 — Follow-up fusion** | Re-capture + recent interviewer audio + prior solution → spoken follow-ups ("make it O(n)") work against the live code. | ~1 day |
| **4 — Precision capture** | Drag-select region overlay → fewer tokens, sharper reads, less of the screen sent. | ~1 day |

## Cost / latency notes

- A ~1568px screenshot ≈ 1.5–2k image-input tokens. Fast solve ~3–8s; Careful ~10–30s.
- Careful mode genuinely improves correctness on medium/hard problems — worth the wait when the candidate has thinking time.
- One vision call per "Solve" press — candidate-controlled, no background polling, predictable spend.

## Open items to confirm during build

- Exact capture hotkey (proposed `Ctrl+Shift+Enter`) — must not collide with the pin/privacy/hide globals.
- Language list for the picker (Python, JS/TS, Java, C++, Go, C#, Ruby, SQL?).
- Whether Careful mode should show a visible "thinking…" timer so 30s doesn't feel frozen.
