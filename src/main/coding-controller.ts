// Orchestrates one agentic coding-mode session: owns screen capture
// (desktopCapturer, main-process only) and the CodeAgent, and bridges them to
// the renderer over IPC. The renderer never captures or talks to OpenAI for
// coding — it just sends intents (start / capture / answer / solve-now /
// cancel) and renders the CodingStep timeline this controller emits.

import type { BrowserWindow } from 'electron';
import { log, q } from './log.js';
import * as auth from './auth.js';
import { capturePrimaryScreen, displayCount } from './screen-capture.js';
import { CodeAgent } from './openai/code-agent.js';
import { transcriptionController } from './transcription-controller.js';
import * as settings from './settings.js';
import {
  IPC,
  type CodingStep,
  type CodingStartRequest,
  type CodingLanguage,
} from '../shared/ipc.js';

class CodingController {
  private agent: CodeAgent | null = null;
  private window: BrowserWindow | null = null;
  // Guards overlapping captures (hotkey mashing) — a capture is an async
  // desktopCapturer round-trip plus a model call.
  private busy = false;

  // Interviewer speech captured while listening. Pre-solve it accumulates as
  // context folded into the agent's goal; post-solve, new utterances are fed
  // to the live agent as follow-ups.
  private listening = false;
  private interviewerBuffer: string[] = [];
  // The latest solution/review as plain text, used as context when answering
  // the interviewer's spoken questions mid-session.
  private lastResult: string | null = null;
  // Guard so overlapping interviewer questions don't fire concurrent answer
  // calls.
  private answering = false;
  // Guard so the guided-apply verify button can't fire concurrent checks.
  private verifying = false;

  attachWindow(window: BrowserWindow): void {
    this.window = window;
  }

  isActive(): boolean {
    return this.agent != null;
  }

  // ── Listening lifecycle (starts on entering Code mode) ────────────────────

  async startListening(): Promise<{ ok: boolean; message?: string }> {
    if (this.listening) return { ok: true };
    const s = await settings.load();
    const res = await transcriptionController.startForCoding(s.language, (text) => this.onInterviewerSpeech(text));
    if (res.ok) {
      this.listening = true;
      this.interviewerBuffer = [];
      log('coding', 'listening started (interviewer audio)');
    }
    return res;
  }

  async stopListening(): Promise<void> {
    if (!this.listening) return;
    this.listening = false;
    await transcriptionController.stop();
    log('coding', 'listening stopped');
  }

  /** Interviewer (system) final transcript while in coding mode. */
  private onInterviewerSpeech(text: string): void {
    const t = text.trim();
    if (!t) return;
    if (this.agent) {
      // A session is engaged. A spoken QUESTION gets answered (pops a banner)
      // rather than fed to the solve loop; anything else is context the agent
      // may adapt to. (Not buffered — it's in the agent's own conversation.)
      if (this.looksLikeQuestion(t)) {
        void this.answerInterviewerQuestion(t);
        return;
      }
      void this.agent.provideInterviewerSpeech(t);
      return;
    }
    // Pre-solve: accumulate as task framing/context for the next start(). We
    // deliberately do NOT auto-answer here — a "Can you write a function
    // that…" task statement would be mistaken for a question.
    this.interviewerBuffer.push(t);
    if (this.interviewerBuffer.length > 40) this.interviewerBuffer.shift();
  }

  /**
   * Guided-apply: capture the screen and check whether the candidate correctly
   * applied one edit step. Emits a 'verify' CodingStep (ok + a short note).
   * Standalone vision one-shot — independent of the solve agent.
   */
  async verifyStep(p: { index: number; total: number; file: string; instruction: string; code: string }): Promise<void> {
    if (this.verifying) return;
    this.verifying = true;
    try {
      const cap = await this.grabScreen();
      if (!cap) { this.emit({ kind: 'verify', index: p.index, ok: false, message: 'Screen capture failed — try again.' }); return; }
      const key = auth.apiKey();
      if (!key) { this.emit({ kind: 'verify', index: p.index, ok: false, message: 'Not signed in.' }); return; }
      const payload = {
        model: process.env['IC_CODING_MODEL'] || 'gpt-5',
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: 'You verify whether a candidate correctly applied ONE code edit, by looking at a screenshot of their editor. Reply in ONE line: begin with "CORRECT" if the intended change is present and right, or "NEEDS_FIX" if it is missing or wrong — then a brief note (<=20 words). Be lenient about whitespace/formatting; judge whether the intended change is there.' },
          { role: 'user', content: [
            { type: 'text', text: `Step ${p.index + 1} of ${p.total}, file ${p.file}.\nIntended change: ${p.instruction}\nExpected result:\n${p.code}\n\nIs this correctly applied in the screenshot?` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${cap}`, detail: 'high' } },
          ] },
        ],
      };
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) { this.emit({ kind: 'verify', index: p.index, ok: false, message: `Check failed (${resp.status}) — try again.` }); return; }
      const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = (json.choices?.[0]?.message?.content ?? '').trim();
      const ok = /^correct/i.test(text);
      const message = text.replace(/^(correct|needs[_\s-]*fix)[:\s-]*/i, '').trim() || (ok ? 'Looks right.' : 'Not applied yet — re-check.');
      log('coding', `verifyStep ${p.index + 1}/${p.total} → ${ok ? 'OK' : 'FIX'}: ${q(message, 60)}`);
      this.emit({ kind: 'verify', index: p.index, ok, message });
    } catch (err) {
      this.emit({ kind: 'verify', index: p.index, ok: false, message: `Check error: ${(err as Error).message}` });
    } finally {
      this.verifying = false;
    }
  }

  /** Cheap heuristic: does this interviewer utterance read as a question? */
  private looksLikeQuestion(t: string): boolean {
    const s = t.trim();
    if (s.endsWith('?')) return true;
    return /^(how|what|what's|whats|why|why's|whys|when|where|which|who|whom|can|could|would|should|do|does|did|is|are|was|were|will|explain|walk|tell|describe|talk)\b/i.test(s);
  }

  /** Intercept agent steps to remember the latest result as Q&A context. */
  private onAgentStep(step: CodingStep): void {
    if (step.kind === 'solution') {
      this.lastResult = `Approach: ${step.solution.approach}\n\nCode:\n${step.solution.code}`.slice(0, 4000);
    } else if (step.kind === 'review') {
      const fs = step.review.findings.map((f) => `- [${f.severity}] ${f.location}: ${f.issue}`).join('\n');
      this.lastResult = `Review: ${step.review.summary}\n${fs}`.slice(0, 3000);
    }
    this.emit(step);
  }

  /**
   * One-shot answer to an interviewer's spoken question, using the latest
   * solution/review as context when available. Best-effort: a failure is
   * logged and dropped (answering is a convenience, not a step in the loop).
   */
  private async answerInterviewerQuestion(question: string): Promise<void> {
    if (this.answering) return;
    this.answering = true;
    try {
      const key = auth.apiKey();
      if (!key) return;
      const ctx = this.lastResult ? `The candidate is working on:\n"""${this.lastResult}"""\n\n` : '';
      const payload = {
        model: process.env['IC_CODING_MODEL'] || 'gpt-5',
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: 'You help a candidate during a LIVE coding interview answer the interviewer\'s spoken questions. Reply with a concise, confident spoken answer (2-4 sentences, ~40-70 words) the candidate can say out loud. Be technically precise and specific to the code/approach in context. No preamble, no "great question".' },
          { role: 'user', content: `${ctx}The interviewer just asked: "${question}"` },
        ],
      };
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) { log('coding', `answer call ${resp.status}`); return; }
      const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const answer = (json.choices?.[0]?.message?.content ?? '').trim();
      if (answer) {
        log('coding', `answered interviewer Q (${question.length}c→${answer.length}c)`);
        this.emit({ kind: 'answer', question, answer });
      }
    } catch (err) {
      log('coding', `answer error: ${(err as Error).message}`);
    } finally {
      this.answering = false;
    }
  }

  // ── Intents from the renderer ────────────────────────────────────────────

  async start(req: CodingStartRequest): Promise<{ ok: boolean; message?: string }> {
    if (this.busy) return { ok: false, message: 'Busy' };
    this.busy = true;
    try {
      // Fresh agent per session. Null it during setup so interviewer speech
      // arriving mid-setup accumulates in the buffer (folded into start
      // below) instead of racing a not-yet-started agent.
      this.agent?.dispose();
      this.agent = null;
      this.lastResult = null;
      const agent = new CodeAgent((step) => this.onAgentStep(step));

      if (displayCount() > 1) {
        log('coding', `multi-monitor (${displayCount()}) — capturing primary only`);
        // Surface it: capturing only the primary screen is a silent footgun
        // if the problem is on another monitor.
        this.send(IPC.Events.Status, {
          message: `${displayCount()} displays detected — capturing your PRIMARY screen only. Keep the problem there.`,
          level: 'warn',
        });
      }
      const cap = await this.grabScreen();
      if (!cap) return { ok: false, message: 'Screen capture failed' };

      this.emit({ kind: 'capture', n: 1 });
      // Fold everything the interviewer has said so far into the agent's
      // starting context, then clear the buffer: that context now lives in
      // the agent's conversation, so a later solve must not replay it.
      const spoken = this.interviewerBuffer.join(' ');
      this.interviewerBuffer = [];
      // Expose the agent only now — immediately before start(), with no await
      // in between — so any live speech is ordered after the agent's first turn.
      this.agent = agent;
      await agent.start(req.goal, req.language, req.effort, req.taskType, cap, spoken);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('coding', `start error: ${msg}`);
      this.emit({ kind: 'error', message: msg });
      return { ok: false, message: msg };
    } finally {
      this.busy = false;
    }
  }

  /** Candidate navigated as instructed and wants a fresh capture fed in. */
  async recapture(): Promise<void> {
    if (!this.agent || this.busy) return;
    this.busy = true;
    try {
      const cap = await this.grabScreen();
      if (!cap) {
        this.emit({ kind: 'error', message: 'Screen capture failed' });
        return;
      }
      this.emit({ kind: 'capture', n: 0 }); // n filled by renderer counter
      await this.agent.provideCapture(cap);
    } finally {
      this.busy = false;
    }
  }

  async answer(text: string): Promise<void> {
    if (!this.agent) return;
    await this.agent.provideAnswer(text);
  }

  async solveNow(): Promise<void> {
    if (!this.agent) return;
    await this.agent.forceSolve();
  }

  /** Candidate accepted/declined a suggest_language proposal. */
  async resolveLanguage(accept: boolean, language: CodingLanguage): Promise<void> {
    if (!this.agent) return;
    await this.agent.resolveLanguageSuggestion(accept, language);
  }

  cancel(): void {
    this.agent?.dispose();
    this.agent = null;
    this.emit({ kind: 'done' });
    log('coding', 'cancelled');
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async grabScreen(): Promise<string | null> {
    try {
      const { pngBase64 } = await capturePrimaryScreen();
      return pngBase64;
    } catch (err) {
      log('coding', `capture error: ${(err as Error).message}`);
      return null;
    }
  }

  private emit(step: CodingStep): void {
    this.send(IPC.Events.CodingStep, step);
  }

  private send<T>(channel: string, payload: T): void {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      log('coding', `send(${channel}) failed: ${(err as Error).message}`);
    }
  }
}

export const codingController = new CodingController();
