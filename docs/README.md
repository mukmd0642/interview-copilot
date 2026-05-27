# Interview Copilot — Design Docs

This folder collects UX and design analysis. Start with the **recommendations** doc — it's the synthesis. The four specialist reviews underneath it are the raw evidence.

| File | What's in it |
|---|---|
| [`ux-recommendations.md`](./ux-recommendations.md) | **Start here.** Cross-cutting themes, prioritized roadmap (3 tiers), and "top 3 if you only ship three things this week." |
| [`ux-review-engine-logic.md`](./ux-review-engine-logic.md) | How the settle/fire/cancel/buffer logic *feels* to the candidate. 4–10s latency, MIN_WORDS_TO_FIRE silently swallowing short questions, cancel-on-new-question wiping mid-read answers, the invisible "Next ▼" pattern. |
| [`ux-review-onboarding.md`](./ux-review-onboarding.md) | A new user with 20 minutes before an interview. "CC" reads as "carbon copy". Mac BlackHole hint is a homework assignment. Privacy mode invisibly ON with no explanation. Hotkeys undiscoverable. |
| [`ux-review-power-user.md`](./ux-review-power-user.md) | A candidate using this 5–10×/week. No hotkeys for the actions used most. Caption panels capped at 6 lines with no scrollback. Status bar overwrites itself. Setup dialog is the only path to update JD between interviews. |
| [`ux-review-failure-modes.md`](./ux-review-failure-modes.md) | What breaks mid-interview, and whether the user can tell. WebSocket dies silently with no reconnect. Connect-time errors reported as success. Raw API JSON dumped into the answer pane on 429/500. Race condition between Stop and in-flight Start. |

## How these were produced

Four parallel specialist agents (general-purpose, sonnet) read the same codebase from different angles, each writing a 500–800 word report. The recommendations doc synthesizes them — every item there has at least one report as evidence with file:line refs.

Source files reviewed (collectively): `src/main/{auth,index,settings,shortcuts,transcription-controller,window}.ts`, `src/main/openai/{interview-engine,realtime-client}.ts`, `src/renderer/src/App.tsx`, all `src/renderer/src/components/*.tsx`, `src/renderer/src/lib/{audio-capture,audio-devices,use-shortcuts,webview-registry}.ts`, `src/renderer/src/state/store.ts`, `src/renderer/src/styles.css`.

## What's NOT in here

- Code-level review (correctness, security, performance). See the WindowsUtility code review in the earlier project.
- Backend / Vercel auth design.
- Pricing / packaging / GTM.
