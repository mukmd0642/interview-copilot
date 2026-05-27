# Interview Copilot — Engine UX Review

*Specialist review #1: how the interview-support logic feels to the candidate. Focus is on timing, decision-making, and the answer-display flow — not code quality.*

## Top findings (ordered by impact)

### 1. "First character on screen" can take 4–10+ seconds after the question ends
**What the user feels:** Awkward silence. The interviewer has finished asking, the candidate is looking at the screen waiting, and nothing appears. They start filler-talking ("Sure, so…") to buy time, which then gets captured by the mic and pollutes the candidate context.

**Where it comes from (in order):**
- Server VAD `silence_duration_ms: 400` on the accurate pipeline before a final is even emitted — `realtime-client.ts:185`.
- Network + gpt-4o-transcribe processing latency for the accurate final (typically 400–900 ms).
- If `looksComplete()` returns false (no terminal `?`/`!`, or `.` with <5 words, or question phrased as a statement like "Walk me through your approach") the engine sits on `SETTLE_AMBIGUOUS_MS = 3500` — `interview-engine.ts:28, 149-163`.
- gpt-5 HTTP round-trip + first-token latency (`reasoningEffort: 'minimal'` helps, but typical 700–1500 ms) — `interview-engine.ts:222-234`.

**Desired behavior:** The 400 ms VAD + accurate-final round-trip is unavoidable, but the 3500 ms settle is the dominant contributor for *any question not ending in a question mark*. The settle should be aggressive (~1200 ms) for utterances that already look question-shaped (start with "how/what/why/walk/tell/describe/can you/could you/would you/do you/are you/have you"), and a START signal could fire on the first delta from the *fast* pipeline so the answer box at least clears and shows "thinking…" within ~500 ms instead of staying populated with the previous answer.

---

### 2. The 3500 ms settle window is wrong for two common interviewer styles
**What the user feels:** With a fast interviewer ("So tell me about a project you're proud of."), the answer feels acceptably snappy because `looksComplete()` triggers on the period+5-words rule. With a slow or hedging interviewer ("So I guess what I'm wondering is… how do you, like, think about scaling a system like this") the 3500 ms timer keeps resetting on every short clause, and the candidate stares at a frozen screen for 5–8 seconds after the interviewer is *actually* done speaking. Conversely, with a rapid-fire interviewer who asks two questions in a row, the engine bundles them into a single composite question and gpt-5 answers a hybrid.

**Where:** `interview-engine.ts:122-163` — every `notifyInterviewerSpoke` call resets the timer via `clearTimeout` and re-arms a fresh 3500 ms window. There's no "max stale" cap.

**Desired behavior:** Two clocks instead of one — reset-on-new-text up to a *soft* settle (~1500 ms), but a *hard* settle (~3500 ms) measured from when the pending question *started* accumulating. After the hard cap fires regardless of fresh deltas. Also: a brief candidate-side silence detection could fire the settle early (interviewer paused → candidate's turn).

---

### 3. `MIN_WORDS_TO_FIRE = 3` silently swallows legitimate short questions
**What the user gains:** Whisper hallucinations on background noise ("you", "okay", "hmm um") and one-word interviewer back-channeling ("Right.", "Sure.") don't trigger a generation. This is real and valuable — `interview-engine.ts:31-39` already filters NOISE_WORDS, but the 3-word floor is the belt to that suspenders.

**What the user loses:** Genuine short questions that need an answer. "Why MongoDB?" (2 words), "Tradeoffs?" (1), "Scale?" (1), "How big?" (2), "Your role?" (2), "And then?" (2) — all silently dropped after the settle. From the candidate's POV the engine just *doesn't respond*, with no visible indicator that anything was heard or rejected. `interview-engine.ts:139-142, 157-160`.

**Desired behavior:** Keep noise filtering, but lower the floor to 1 word when the utterance ends in `?` or starts with a question word. When dropping a sub-3-word utterance the UI should at least flash a "(too short — say more?)" hint so the candidate knows the engine heard them and decided not to fire.

---

### 4. Cancel-on-new-question cuts off answers the candidate was reading
**What the user feels:** Mid-answer, the interviewer says "And actually, one more thing — what about Postgres?" The candidate is 60% through reading the previous answer aloud. The screen wipes (`onAnswerChunk('', false)` → renderer clears, `interview-engine.ts:217`, `store.ts:209-227`) and a new answer starts streaming over it. The candidate loses their place mid-sentence in front of the interviewer.

This also hurts on speakerphone bleed: the candidate's own voice loops through system audio, gets transcribed as the interviewer, and cancels the answer the candidate was about to use. `transcription-controller.ts:222-237` routes every accurate-system final to `notifyInterviewerSpoke` with no echo check.

**Where:** `interview-engine.ts:184-203` cancels unconditionally on any new interviewer final that passes noise/settle.

**Desired behavior:** Don't cancel; *buffer*. The existing pendingAnswer/Next ▼ mechanism (`store.ts:209-251`) is the right pattern but the engine never uses it during in-flight generation — it only buffers post-DONE. While `answerStreaming === true`, the START signal should set `pendingReady = true` instead of clearing `answerBox`. Also: detect cross-channel echo (same text appearing on mic within ~1.5 s of a system final → drop the system final).

---

### 5. The "Next ▼" buffer pattern is invisible during a real interview
**What the user sees during back-and-forth:** Q1 arrives → box clears → answer streams → DONE. Candidate reads answer aloud. Q2 arrives mid-read → currently *cancels*, see finding #4. Assume that's fixed: a `pendingReady` flag sets and the button label changes to "[ Next ▼ ]". But the candidate is *looking down at the visible answer reading it word-for-word*; they have no peripheral signal that a new answer is ready. There is no flash, count-down, audio cue, or color shift — just a subtle header text change in `AnswerPanel.tsx:14-16`.

**Desired behavior:** Pending answers need a strong visual affordance — a pulsing badge, a colored header bar, line count of how much new answer is buffered, and ideally a keyboard shortcut (e.g. spacebar) to flush so the candidate doesn't have to look up and find the button. Auto-advance on detected candidate silence (the comment at `store.ts:215-216` mentions this but it isn't wired).

---

## Secondary findings

- **System prompt is well-tuned but produces over-long answers for snappy interviewers.** The 280–450 word target for behavioral questions (`interview-engine.ts:280-282`) is a lot to read aloud at a natural pace — roughly 100–150 seconds of speaking. Interviewers asking rapid follow-ups will interrupt long before the candidate finishes the suggested answer, and the buffer pattern then triggers cancel/buffer dynamics constantly. A "tempo" hint inferred from the rolling cadence of system finals (avg time between interviewer turns) could scale the target length.

- **The "first sentence answers the question on its own" rule (`interview-engine.ts:272`) is gold for this product** — it means even with 8s latency, once the first sentence appears the candidate can start talking. Worth surfacing in UI as a visual marker (bold or highlight the first sentence) so the candidate knows where to start.

- **Interviewer "thinking out loud" is misread.** Phrases like "Hmm, so I'm trying to think of a good question for you…" pass noise filter, accumulate over the settle, and trigger a meaningless generation. No discriminator between question-shaped and non-question-shaped utterances exists — `looksComplete()` and the settle just measure shape and pause, not intent.

- **Chain-of-questions get merged.** "Tell me about your last project. What was the team size? What was your role?" arrives as three separate accurate finals; they accumulate inside `pendingQuestion` (`interview-engine.ts:122-123`) and get answered as one composite. The candidate gets one big narrative when the interviewer expected three short answers.

- **Summary refresh every 6 turns** (`interview-engine.ts:179`) is fine, but it's a `gpt-5-mini` round-trip that competes for OpenAI rate-limit headroom with the live answer call. On flaky connections it can starve the hot path. Background, but not free.

- **`extractInterviewerKeyPoints` happens *before* the answer fires** (`interview-engine.ts:208`) — it's fire-and-forget so it doesn't block, but it does mean an extra concurrent HTTP request hits OpenAI at the exact moment latency matters most.

## Relevant locations
- `src/main/openai/interview-engine.ts:28,108-164,184-253,266-323`
- `src/main/openai/realtime-client.ts:181-191,210-244`
- `src/main/transcription-controller.ts:222-237`
- `src/renderer/src/state/store.ts:209-261`
- `src/renderer/src/components/AnswerPanel.tsx:10-26`
