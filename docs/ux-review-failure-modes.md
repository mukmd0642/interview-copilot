# Failure-Mode & Error-Recovery Review — Interview Copilot

*Specialist review #4: what breaks mid-interview, and does the user know what to do?*

The dominant pattern across the codebase: errors are logged, sometimes downgraded to a single-line `status` toast, then forgotten. Because `applyStatus` is a single overwriting field (`store.ts:264`), each new status erases the prior one. There is no log viewer, no health indicator, no audio meter, no reconnect logic, and no way for the user to see *why* captions went silent. For a tool used during a literal interview, this is the central UX risk.

## Top 5 — most likely to bite mid-interview

### 1. OpenAI WebSocket dies silently mid-session (rate limit, network blip, idle hang)
**Current behavior.** `realtime-client.ts:103-118` handles `close` by clearing the silence timer and firing `onConnectionChange(false)` — but no consumer is wired to `onConnectionChange` in `transcription-controller.ts`. The `error` event emits one `[mic-fast] Disconnected: …` status, then any subsequent `sendAudio` (line 127) silently returns because `readyState !== OPEN`. Audio keeps flowing from the worklet straight into `/dev/null`. There is **no reconnect**, anywhere.

**User experience.** Captions just stop updating. The toolbar still says "Listening" (set once in `start`, never updated). The interviewer keeps talking; the candidate sees frozen text and assumes the model is slow.

**Should do.** Wire `onConnectionChange` to a persistent connection-health indicator (one dot per stream), auto-reconnect with backoff on unexpected close, and demote `status` to "Reconnecting captions…" instead of overwriting it with the next info message.

### 2. Connect-time failure is reported as success
**Current behavior.** `realtime-client.ts:80-119` constructs a Promise that resolves on `open` **and also resolves on `error`** ("resolve() is harmless if already fired"). `connect()` never rejects. Controller's `Promise.all` at `transcription-controller.ts:98-103` therefore always succeeds. The fallback check at line 105 (`!micFast.isConnected && !systemFast.isConnected`) only fires if **both** fast streams are dead — a single failed stream (e.g. mic auth fails on the fast pipeline but system succeeds) leaves the user with half-broken captions and a "Listening" status.

**User experience.** "Listening" appears. One side never produces text. User has no idea whether they aren't speaking loudly enough, the mic is wrong, or OpenAI is down.

**Should do.** `connect()` should reject on error; the controller should surface a per-stream status (e.g. "Mic captions disconnected — retrying").

### 3. 429 / 5xx on answer generation surfaces as `[Error: OpenAI 429: …]` inside the answer pane
**Current behavior.** `interview-engine.ts:499-502` throws on non-2xx; the catch at line 249-252 calls `onAnswerChunk('[Error: …]', true)`, which `store.ts:230-237` appends to `answerBox`. So the answer pane shows raw API JSON in place of an answer.

**User experience.** "Tell me about a time…" → answer pane prints `[Error: OpenAI 429: {"error":{"message":"Rate limit reached…"}}]`. Not actionable in real time, and the next question's start signal clears it — the user never knows the previous answer never came.

**Should do.** Classify 429 / 5xx / network distinctly; show a small persistent banner ("OpenAI is rate-limiting your account — answers paused"); keep retrying with backoff; show a countdown if `Retry-After` is provided.

### 4. User clicks CC, immediately clicks Stop while connect is in flight
**Current behavior.** `InterviewView.tsx:121-180` guards with `ccBusy`, but `setCcBusy(true)` happens *inside* the click handler. If the click that fires `startCc` races with another click before React re-renders the button as busy, both can fire. More importantly: `startCapture` resolves with a `handle` after `getDisplayMedia` and `getUserMedia` settle — if `stopCc` runs while `startCc` is still in `await window.api.transcript.start`, `captureRef.current` is still null. `stopCc` calls `transcript.stop` (which short-circuits because `active` is false yet — see `transcription-controller.ts:131`, returns early), then `handle?.stop` is skipped, then the in-flight `startCc` resumes, assigns `captureRef.current`, and the app is "stopped" but with live mic capture and four WebSockets connecting. Race results in stuck audio capture with no UI state.

**User experience.** App appears stopped, mic light stays on (Windows shows the red mic indicator), captions resume seconds later anyway.

**Should do.** Make `setCcBusy` synchronous-disable the toolbar button via the store before any await, and have `stopCc` cancel an in-flight `startCc` via an `AbortController` (not present anywhere in the start path).

### 5. Settle timer + abort race in `interview-engine.stream()`
**Current behavior.** `interview-engine.ts:510` loops `while (!this.disposed && !opts.signal?.aborted)`. When `disconnect`/`stop` flows in (`controller.stop` → `engine.dispose` → `cancelInFlight('dispose')`), the abort fires but the SSE reader can be blocked on `reader.read()`. The fetch's `signal` is passed (line 495), so this *should* unblock — but if the abort lands after the response headers but before any chunk, the reader may still hang briefly. More concerning: `pendingQuestion` and `settleTimer` (line 149) are cleared in `dispose`, but **a settle timer that fires between `disconnect()` returning and the user starting a new session can call `startGeneration` on a disposed engine** — guarded only by `if (this.disposed) return` at line 151. Fine on its own, but a settled question is then silently dropped with no UI indication.

## Likely & moderate severity

### 6. Mic permission denied at OS level
`audio-capture.ts:191` surfaces the raw browser error message (`Permission denied`, `NotAllowedError: …`) via `onError`, which becomes a single `warn`-level status that gets overwritten by the next "Listening" or "Connecting" message. `index.ts:44-57` auto-grants Chromium-layer permission, so the *only* gate is OS settings — and the message never tells the user "open Settings → Privacy → Microphone". On Windows, the OS revokes mid-session permission silently; mic stream just emits zeros.
**Should do.** Detect `NotAllowedError` / `NotFoundError` specifically, show a sticky banner with a "Open System Settings" deep-link (`ms-settings:privacy-microphone` on Windows, `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone` on Mac).

### 7. `getDisplayMedia` cancellation vs no-audio-track are indistinguishable
`audio-capture.ts:114-117` re-throws; `setDisplayMediaRequestHandler` in `index.ts:70-94` calls `callback({})` on empty sources, which manifests as an `AbortError` on the renderer side — **identical** to "user dismissed the picker". The user gets `Desktop audio capture failed: NotAllowedError` and no idea whether they cancelled, no screens exist (RDP / locked machine), or loopback isn't supported on their Windows build (line 131 has the better message but only fires if a video track came back without audio).

### 8. Mic unplugged mid-session
Nothing listens for `MediaStreamTrack.onended` or `ondevicechange` in `audio-capture.ts`. The worklet keeps consuming silence; the user notices only that their side of the captions stops updating. Captions for the interviewer continue, masking the problem.

### 9. AudioContext suspended after background
`makeContext` (line 61) resumes once at startup. After Windows sleeps or Chromium throttles a backgrounded renderer, the context can suspend. No resume path on visibility change or `statechange` event.

### 10. Token expiry — no refresh anywhere
`auth.ts` has no refresh path. `apiKey()` returns the stored OpenAI key directly (line 22-24); that key is fetched once at login. If the **OpenAI** key the Vercel backend issues is rotated or scoped to a TTL, every subsequent WebSocket / chat call fails with 401 and the user sees `Error: OpenAI 401: …` in the answer pane (#3 above). No "session expired, please re-login" UX.

### 11. BlackHole misconfigured on Mac
`audio-capture.ts:140-153` opens the device successfully even if BlackHole is set as input but not as output — the stream produces silence. The app has no audio-level indicator, so the user has no way to tell whether silence means "nothing was said" or "the routing is wrong". Worst case during a live interview.

## Lower severity / belt-and-braces

### 12. Settings corruption — handled.
`settings.ts:53-59` catches JSON parse errors and falls back to defaults, with extra defensive normalisation (lines 42-51). Good. Only nit: silent reset means a user who edited `settings.json` to share JD/resume across machines won't know it got wiped.

### 13. Empty catches in realtime client `send`
`realtime-client.ts:137-139` and `:204-206` log but don't surface. A send-failure storm (queue overflow on a degraded link) is invisible to the user.

### 14. `process.on('unhandledRejection')` only logs
`index.ts:128-134` writes to log file. No crash dialog, no telemetry, no "something broke, here's how to send us the log" prompt.

### 15. `applyStatus` overwrite is the meta-problem
Every finding above is amplified by the single-slot status. "Mic permission denied" → 200 ms later → "Listening · Live captions + answer suggestions" overwrites the only signal the user got.

## The worst-case stranding scenario

**Minute 28 of 30: WebSocket dropped at minute 24, answer-stream hit a 500 at minute 26, mic permission revoked at minute 27.** Each event fired one transient toast that the next overwrote. The toolbar still shows "Listening". The caption panel is frozen on the last `applyAccurateFinal` from four minutes ago. The answer pane shows `[Error: OpenAI 500: …]` for a question that's now stale. There is no log viewer, no connection dot, no audio meter, no "Reconnect" button. The candidate's only recovery move is to click Stop → CC, which they won't do because they don't know anything is wrong until the silence becomes obvious — and even then, the racy stop/start path (#4) may leave them worse off.

**Highest-leverage fixes:** (a) persistent status/error log surface with severity sticky-banners, (b) per-stream connection health dots, (c) WebSocket auto-reconnect, (d) mic-level meter on both sources, (e) make `connect()` actually reject so the controller can report which stream failed.
