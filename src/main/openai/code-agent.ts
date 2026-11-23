// Agentic coding-interview solver.
//
// Unlike the single-shot tools in the market (see docs/research-coding-tools.md),
// this is a real tool-calling loop that can ask the candidate to navigate —
// scroll for the rest of a long problem, or open another file — and then
// re-capture, accumulating visual context until it can solve. The candidate
// is the hands (autonomous cursor control would be visible to the interviewer
// on a screen-share); the agent is the brain.
//
// Suspend/resume shape
// ────────────────────
// The "loop" can't be a tight while() because request_view / ask_user must
// hand control back to the UI and WAIT for the candidate to act. So the
// agent is a state machine:
//   start(goal, image) → step()
//   step() asks the model (one tool call):
//     • request_view   → emit 'instruction', suspend (await provideCapture)
//     • ask_user       → emit 'question',    suspend (await provideAnswer)
//     • provide_solution → emit 'solution' + 'done', finish
//   provideCapture(image) → append image as a user turn → step()
//   provideAnswer(text)   → append answer as tool result → step()
//
// The controller owns screen capture (desktopCapturer) + IPC; the agent owns
// the model conversation and tool logic only.

import { log, q } from '../log.js';
import * as auth from '../auth.js';
import type {
  CodingStep,
  CodingLanguage,
  CodingEffort,
  CodingTaskType,
  CodeSolution,
  CodeEditStep,
  CodeReview,
  ReviewFinding,
  ReviewSeverity,
} from '../../shared/ipc.js';
import { CODING_LANGUAGES } from '../../shared/ipc.js';

// Safety cap on model round-trips so a confused agent can't loop forever.
// Kept modest: the prompt biases the agent to converge in 2-3 captures, so
// hitting this should be the EXCEPTION, not the normal exit. (At 12 it WAS the
// normal exit — the agent chased every imported file until the counter fired;
// see the "CONVERGE FAST" + one-view-per-turn rules in systemPrompt.)
const MAX_STEPS = 8;

// Transient model-call failures (network blips on the proxy path, 429, 5xx)
// get this many retries with backoff before surfacing as an error. 4xx —
// especially the 403 region block — are never retried; they don't self-heal.
const MAX_CALL_RETRIES = 2;

// The coding agent's model. HARD REQUIREMENT: it must support BOTH vision
// (it reads screenshots of the problem) AND function/tool calling (the
// request_view / ask_user / provide_solution loop). That rules out text-only
// or vision-only variants.
//
// Default gpt-5 — multimodal + tools + strong coding with high reasoning.
// To try a coding-specialised model (e.g. a GPT-5-Codex variant) just change
// this string, provided it accepts image_url input and tool_choice on the
// chat-completions API. Overridable via env for quick A/B without a rebuild.
const CODING_MODEL = process.env['IC_CODING_MODEL'] || 'gpt-5';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string; detail?: 'high' | 'low' | 'auto' };
}
interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type StepSink = (step: CodingStep) => void;

export class CodeAgent {
  private messages: ChatMessage[] = [];
  private stepCount = 0;
  private language: CodingLanguage = 'python';
  private effort: CodingEffort = 'fast';
  private taskType: CodingTaskType = 'solve';
  private disposed = false;
  // The id of the pending tool call we're waiting on the candidate to satisfy
  // (request_view / ask_user). Needed to emit a matching `tool` result.
  private pendingToolCallId: string | null = null;
  private abort: AbortController | null = null;
  // Serializes every model-stepping operation. Two callModel round-trips must
  // never overlap on the shared `messages` array — otherwise "Solve now", a
  // recapture, or interviewer speech firing while a step is in flight would
  // interleave tool calls / results and corrupt the conversation. Each public
  // intent runs only after the previous one fully settles.
  private queue: Promise<void> = Promise.resolve();
  // Interviewer-speech ops queued but not yet run. A burst of utterances
  // collapses into a single model round-trip: each appends context, only the
  // last (when this hits 0) kicks a step.
  private pendingSpeechOps = 0;
  // Interviewer utterances that arrived while we were SUSPENDED on a tool
  // call (pendingToolCallId set). They can't be pushed as user messages yet:
  // a `tool` result must immediately follow the `assistant` tool_call that
  // requested it, so a user message in between is a 400. We hold them here
  // and flush them right AFTER the tool result is appended.
  private pendingInterviewerNotes: string[] = [];
  // Set once provide_solution lands. A manual capture after this is ignored:
  // pressing capture post-solution used to instantly force-solve again
  // (stepCount was already past MAX_STEPS). Reset to start a new problem.
  private done = false;

  constructor(private readonly onStep: StepSink) {}

  // Run a model-stepping op behind any in-flight one. The op's errors are
  // logged + surfaced as an error step (never re-thrown) so one failed op
  // can't wedge the queue for the rest of the session.
  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      if (this.disposed) return;
      try {
        await op();
      } catch (err) {
        if (this.disposed) return;
        const msg = err instanceof Error ? err.message : String(err);
        log('code-agent', `queued op threw: ${msg}`);
        this.onStep({ kind: 'error', message: msg });
      }
    });
    this.queue = next;
    return next;
  }

  // ── Public lifecycle ─────────────────────────────────────────────────────

  async start(
    goal: string,
    language: CodingLanguage,
    effort: CodingEffort,
    taskType: CodingTaskType,
    firstImageB64: string,
    spokenContext = ''
  ): Promise<void> {
    return this.enqueue(() => this.startImpl(goal, language, effort, taskType, firstImageB64, spokenContext));
  }

  private async startImpl(
    goal: string,
    language: CodingLanguage,
    effort: CodingEffort,
    taskType: CodingTaskType,
    firstImageB64: string,
    spokenContext: string
  ): Promise<void> {
    this.language = language;
    this.effort = effort;
    this.taskType = taskType;
    this.messages = [{ role: 'system', content: this.systemPrompt() }];
    const goalText = goal.trim() || (taskType === 'review'
      ? 'Review the code shown on screen.'
      : 'Solve the coding problem shown in the screenshot.');
    // Fold in anything the interviewer has said so far (problem framing,
    // rules, constraints) — it's first-class context alongside the image.
    const spoken = spokenContext.trim();
    const text = spoken
      ? `The interviewer has said so far:\n"""${spoken}"""\n\n${goalText}`
      : goalText;
    this.messages.push({
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${firstImageB64}`, detail: 'high' } },
      ],
    });
    log('code-agent', `start lang=${language} effort=${effort} spoken=${spoken.length}c goal=${q(goalText, 80)}`);
    await this.step();
  }

  /**
   * Interviewer said something mid-session (a follow-up, a new constraint, a
   * question). Queued like every other op: it appends the utterance as
   * context and — unless it's suspended on the candidate or coalescing with a
   * later utterance — kicks a step so the agent can adapt the solution or
   * answer the question.
   */
  async provideInterviewerSpeech(text: string): Promise<void> {
    if (this.disposed) return;
    const t = text.trim();
    if (!t) return;
    this.pendingSpeechOps += 1;
    await this.enqueue(() => this.interviewerSpeechImpl(t));
  }

  private async interviewerSpeechImpl(t: string): Promise<void> {
    this.pendingSpeechOps = Math.max(0, this.pendingSpeechOps - 1);
    if (this.disposed) return;
    // Suspended on a request_view / ask_user tool call: do NOT append a user
    // message now — it would land between the assistant's tool_call and its
    // tool result, which the API rejects. Buffer it; closePending flushes it
    // (in order) once the candidate satisfies the pending call.
    if (this.pendingToolCallId) {
      this.pendingInterviewerNotes.push(t);
      log('code-agent', `interviewer speech buffered while suspended (${t.length}c)`);
      return;
    }
    this.messages.push({ role: 'user', content: `Interviewer just said: "${t}"` });
    // Coalesce bursts: if more interviewer-speech ops are still queued behind
    // this one, just append context and let the LAST one kick the step — a run
    // of utterances becomes one model round-trip instead of N.
    if (this.pendingSpeechOps > 0) {
      log('code-agent', `interviewer speech appended; ${this.pendingSpeechOps} more queued`);
      return;
    }
    await this.step();
  }

  /** Candidate navigated as instructed and re-captured; feed the new view. */
  async provideCapture(imageB64: string): Promise<void> {
    if (this.disposed) return;
    await this.enqueue(() => this.captureImpl(imageB64));
  }

  private async captureImpl(imageB64: string): Promise<void> {
    if (this.disposed) return;
    if (this.done) {
      // Candidate is adding MORE context after a solution — e.g. the next
      // level of a multi-part problem. Re-open with a fresh step budget and
      // refine, rather than ignoring it (which left the hotkey feeling dead).
      log('code-agent', 'post-solution capture — refining with added context');
      this.done = false;
      this.stepCount = 0;
      this.messages.push({ role: 'user', content: 'Here is more of the problem / additional context the candidate has now shown. Update or EXTEND your previous solution to cover it; do not start over.' });
      this.messages.push({
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}`, detail: 'high' } }],
      });
      await this.step();
      return;
    }
    // Close out the request_view tool call (and flush any buffered
    // interviewer speech), then add the fresh screenshot as a user turn
    // (tool results can't carry images, so the image rides a separate user
    // message).
    this.closePending('Candidate captured the requested view; see the next image.');
    this.messages.push({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}`, detail: 'high' } }],
    });
    await this.step();
  }

  /** Candidate answered an ask_user question. */
  async provideAnswer(text: string): Promise<void> {
    if (this.disposed) return;
    await this.enqueue(() => this.answerImpl(text));
  }

  private async answerImpl(text: string): Promise<void> {
    if (this.disposed) return;
    if (this.pendingToolCallId) {
      this.closePending(text);
    } else {
      this.flushInterviewerNotes();
      this.messages.push({ role: 'user', content: text });
    }
    await this.step();
  }

  /** Force a solution now with whatever's been captured (the "Solve now" button). */
  async forceSolve(): Promise<void> {
    if (this.disposed) return;
    await this.enqueue(() => this.forceSolveImpl());
  }

  private async forceSolveImpl(): Promise<void> {
    if (this.disposed) return;
    const isReview = this.taskType === 'review';
    if (this.pendingToolCallId) {
      this.closePending(isReview
        ? 'Candidate pressed "Review now" — give your best review from what you have already seen. Do not ask for more. Call provide_review.'
        : 'Candidate pressed "Solve now" — provide your best solution from what you have already seen. Do not ask for more.');
    } else {
      this.flushInterviewerNotes();
    }
    this.messages.push({ role: 'user', content: isReview
      ? 'Review now with what you have. Call provide_review.'
      : 'Solve now with what you have. Call provide_solution.' });
    await this.step({ forceSolution: true });
  }

  /**
   * Candidate responded to a suggest_language proposal. accept=true switches
   * the agent to `language` for the rest of the session; either way the solve
   * continues.
   */
  async resolveLanguageSuggestion(accept: boolean, language: CodingLanguage): Promise<void> {
    if (this.disposed) return;
    await this.enqueue(() => this.resolveLanguageImpl(accept, language));
  }

  private async resolveLanguageImpl(accept: boolean, language: CodingLanguage): Promise<void> {
    if (this.disposed) return;
    if (accept) this.language = language;
    const msg = accept
      ? `Confirmed — solve in ${language}. Match the project on screen.`
      : `No — solve in ${this.language} as the candidate selected.`;
    log('code-agent', `resolveLanguageSuggestion accept=${accept} → ${this.language}`);
    if (this.pendingToolCallId) {
      this.closePending(msg);
    } else {
      this.flushInterviewerNotes();
      this.messages.push({ role: 'user', content: msg });
    }
    await this.step();
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.abort = null;
    this.messages = [];
    this.pendingInterviewerNotes = [];
  }

  // ── Suspension helpers ─────────────────────────────────────────────────────

  /**
   * Close out a pending request_view / ask_user tool call with the given
   * result text, then flush any interviewer speech that arrived while we were
   * suspended. The ordering is load-bearing: the `tool` result must directly
   * follow the `assistant` tool_call that requested it; the buffered user
   * notes go AFTER, never between.
   */
  private closePending(resultText: string): void {
    if (this.pendingToolCallId) {
      this.messages.push({ role: 'tool', tool_call_id: this.pendingToolCallId, content: resultText });
      this.pendingToolCallId = null;
    }
    this.flushInterviewerNotes();
  }

  /** Append interviewer speech buffered during a suspension as one user turn. */
  private flushInterviewerNotes(): void {
    if (this.pendingInterviewerNotes.length === 0) return;
    const joined = this.pendingInterviewerNotes.join(' ');
    this.pendingInterviewerNotes = [];
    log('code-agent', `flushing ${joined.length}c of buffered interviewer speech`);
    this.messages.push({ role: 'user', content: `Interviewer said while you were waiting: "${joined}"` });
  }

  // ── The step ─────────────────────────────────────────────────────────────

  private async step(opts: { forceSolution?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    if (this.stepCount >= MAX_STEPS && !opts.forceSolution) {
      log('code-agent', `MAX_STEPS hit — forcing solve`);
      // Call the impl directly: we're already inside a queued op, so going
      // back through the enqueuing forceSolve() would deadlock on the queue.
      return this.forceSolveImpl();
    }
    this.stepCount += 1;
    this.onStep({ kind: 'thinking' });

    let toolCall: ToolCall | null = null;
    try {
      toolCall = await this.callModel(opts.forceSolution === true);
    } catch (err) {
      if (this.disposed) return;
      const msg = err instanceof Error ? err.message : String(err);
      log('code-agent', `model error: ${msg}`);
      this.onStep({ kind: 'error', message: msg });
      return;
    }
    if (this.disposed) return;

    if (!toolCall) {
      this.onStep({ kind: 'error', message: 'Model returned no tool call.' });
      return;
    }

    // Record the assistant's tool call so the conversation stays well-formed
    // for the next turn's tool result.
    this.messages.push({ role: 'assistant', content: '', tool_calls: [toolCall] });

    const args = this.parseArgs(toolCall.function.arguments);

    switch (toolCall.function.name) {
      case 'request_view': {
        this.pendingToolCallId = toolCall.id;
        const instruction = typeof args.instruction === 'string' ? args.instruction : 'Show me more of the problem, then capture again.';
        log('code-agent', `request_view: ${q(instruction, 100)}`);
        this.onStep({ kind: 'instruction', text: instruction });
        return; // suspend — wait for provideCapture
      }
      case 'ask_user': {
        this.pendingToolCallId = toolCall.id;
        const question = typeof args.question === 'string' ? args.question : 'Could you clarify the task?';
        log('code-agent', `ask_user: ${q(question, 100)}`);
        this.onStep({ kind: 'question', text: question });
        return; // suspend — wait for provideAnswer
      }
      case 'suggest_language': {
        const language = this.resolveSolutionLanguage(args.language);
        if (language === this.language) {
          // No-op suggestion — it proposed the language already in use. Don't
          // bug the candidate with a pointless "switch python → python";
          // acknowledge and let the agent get on with solving.
          log('code-agent', `suggest_language no-op (already ${language}) — continuing`);
          this.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: `Already ${language}; no switch needed — proceed.` });
          await this.step();
          return;
        }
        this.pendingToolCallId = toolCall.id;
        const reason = typeof args.reason === 'string' && args.reason.trim()
          ? args.reason.trim()
          : `The problem looks like ${language}, not ${this.language}.`;
        log('code-agent', `suggest_language: ${language} (from ${this.language}) — ${q(reason, 80)}`);
        this.onStep({ kind: 'suggest_language', language, reason });
        return; // suspend — wait for resolveLanguageSuggestion
      }
      case 'provide_solution': {
        const solution = this.coerceSolution(args);
        log('code-agent', `provide_solution (${solution.code.length} chars code)`);
        this.done = true;
        // Close the tool call so the conversation stays well-formed: if the
        // interviewer asks a follow-up after the solution (e.g. "what's the
        // complexity?"), the next step won't send an orphaned tool_call.
        this.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: 'Solution delivered to the candidate.' });
        this.onStep({ kind: 'solution', solution });
        this.onStep({ kind: 'done' });
        return;
      }
      case 'provide_review': {
        const review = this.coerceReview(args);
        log('code-agent', `provide_review (${review.findings.length} findings, ${review.questions.length} questions)`);
        this.done = true;
        this.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: 'Review delivered to the candidate.' });
        this.onStep({ kind: 'review', review });
        this.onStep({ kind: 'done' });
        return;
      }
      default:
        // Unknown tool name still left an assistant tool_call on the stack;
        // close it so a later step doesn't choke on the orphan.
        this.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: `Unknown tool ${toolCall.function.name} ignored.` });
        this.onStep({ kind: 'error', message: `Unknown tool: ${toolCall.function.name}` });
    }
  }

  // ── OpenAI tool-calling call (non-streaming) ──────────────────────────────

  private async callModel(forceSolution: boolean): Promise<ToolCall | null> {
    const key = auth.apiKey();
    if (!key) throw new Error('Not signed in');

    const payload = {
      model: CODING_MODEL,
      reasoning_effort: this.effort === 'careful' ? 'high' : 'minimal',
      messages: this.messages,
      tools: this.taskType === 'review' ? REVIEW_TOOLS : SOLVE_TOOLS,
      // Force a tool every turn for a predictable state machine. When the
      // candidate forced a finish, pin it to the terminal tool (provide_solution
      // / provide_review) so it can't ask for more.
      tool_choice: forceSolution
        ? { type: 'function', function: { name: this.finalToolName() } }
        : 'required',
    };
    const body = JSON.stringify(payload);

    // Retry transient failures (network blips on the proxy path, 429, 5xx)
    // with backoff so one flaky hop doesn't kill the step. 4xx are NOT retried
    // — a 403 region block or a malformed request won't fix itself.
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= MAX_CALL_RETRIES; attempt++) {
      if (this.disposed) return null;
      this.abort = new AbortController();
      let resp: Awaited<ReturnType<typeof fetch>>;
      try {
        resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body,
          signal: this.abort.signal,
        });
      } catch (err) {
        if (this.disposed) return null;
        if ((err as Error).name === 'AbortError') throw err; // intentional — don't retry
        lastErr = new Error(`network error contacting OpenAI: ${(err as Error).message}`);
        if (attempt < MAX_CALL_RETRIES) { await this.backoff(attempt); continue; }
        throw lastErr;
      }

      if (resp.ok) {
        const json = (await resp.json()) as {
          choices?: Array<{ message?: { tool_calls?: ToolCall[] } }>;
        };
        const calls = json.choices?.[0]?.message?.tool_calls;
        return calls && calls.length > 0 ? calls[0]! : null;
      }

      const bodyText = await resp.text().catch(() => '');
      // Region block — surface an actionable message; never retry.
      if (resp.status === 403 && /unsupported_country|region|territory/i.test(bodyText)) {
        throw new Error('OpenAI is blocked in your region. Set an HTTPS_PROXY pointing at a supported region, then restart the app.');
      }
      // 429 / 5xx are transient — retry.
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error(`OpenAI ${resp.status}: ${bodyText.slice(0, 160)}`);
        if (attempt < MAX_CALL_RETRIES) { await this.backoff(attempt); continue; }
        throw lastErr;
      }
      // Other 4xx — caller's fault; not retryable.
      throw new Error(`OpenAI ${resp.status}: ${bodyText.slice(0, 300)}`);
    }
    throw lastErr ?? new Error('OpenAI call failed');
  }

  /** Exponential backoff between model-call retries: 400ms, 1200ms. */
  private backoff(attempt: number): Promise<void> {
    const ms = 400 * Math.pow(3, attempt);
    log('code-agent', `model call retry in ${ms}ms (attempt ${attempt + 2}/${MAX_CALL_RETRIES + 1})`);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private parseArgs(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private coerceSolution(args: Record<string, unknown>): CodeSolution {
    const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
    const isModification = args.is_modification === true;
    const originalCode = str(args.original_code);
    const steps = this.coerceSteps(args.steps);
    return {
      approach: str(args.approach),
      // Honour the language the agent actually used — the problem may dictate
      // one that differs from the candidate's default pick (e.g. React/.tsx
      // when the picker sat on python). Fall back to the pick if it's missing
      // or unrecognised.
      language: this.resolveSolutionLanguage(args.language),
      code: str(args.code),
      complexity: str(args.complexity),
      notes: str(args.notes),
      // Only treat it as a modification when we actually have something to
      // show as a change (original region and/or ordered steps); otherwise
      // it's an ordinary fresh solution.
      isModification: isModification && (originalCode.length > 0 || steps.length > 0),
      originalCode: originalCode.length > 0 ? originalCode : undefined,
      steps: steps.length > 0 ? steps : undefined,
    };
  }

  /** The terminal tool for the current task type. */
  private finalToolName(): string {
    return this.taskType === 'review' ? 'provide_review' : 'provide_solution';
  }

  private coerceReview(args: Record<string, unknown>): CodeReview {
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const sev = (v: unknown): ReviewSeverity => {
      const s = typeof v === 'string' ? v.toLowerCase().trim() : '';
      return (['high', 'medium', 'low', 'nit', 'praise'] as const).includes(s as ReviewSeverity)
        ? (s as ReviewSeverity)
        : 'low';
    };
    const findings: ReviewFinding[] = (Array.isArray(args.findings) ? args.findings : [])
      .map((f): ReviewFinding => {
        const o = (f ?? {}) as Record<string, unknown>;
        return { location: str(o.location), severity: sev(o.severity), issue: str(o.issue), suggestion: str(o.suggestion) };
      })
      .filter((f) => f.issue.length > 0 || f.suggestion.length > 0);
    const questions: string[] = (Array.isArray(args.questions) ? args.questions : [])
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      .map((q) => q.trim());
    return { summary: str(args.summary), findings, questions };
  }

  /** Coerce the model's `steps` array into well-formed CodeEditStep[]. */
  private coerceSteps(raw: unknown): CodeEditStep[] {
    if (!Array.isArray(raw)) return [];
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    return raw
      .map((s): CodeEditStep => {
        const o = (s ?? {}) as Record<string, unknown>;
        const step: CodeEditStep = {
          file: str(o.file),
          instruction: str(o.instruction),
          explanation: str(o.explanation),
        };
        const code = str(o.code);
        if (code) step.code = code;
        const oldCode = str(o.old_code);
        if (oldCode) step.oldCode = oldCode;
        const line = typeof o.start_line === 'number' ? o.start_line : Number(o.start_line);
        if (Number.isFinite(line) && line > 0) step.startLine = Math.floor(line);
        return step;
      })
      // Drop empties — a step with neither an instruction nor a snippet is noise.
      .filter((s) => s.instruction.length > 0 || (s.code?.length ?? 0) > 0 || (s.oldCode?.length ?? 0) > 0);
  }

  /** Map the agent's reported language onto a supported CodingLanguage. */
  private resolveSolutionLanguage(raw: unknown): CodingLanguage {
    if (typeof raw !== 'string') return this.language;
    const v = raw.toLowerCase().trim();
    if ((CODING_LANGUAGES as readonly string[]).includes(v)) return v as CodingLanguage;
    // Common aliases the model may emit that aren't the exact enum value.
    const alias: Record<string, CodingLanguage> = {
      react: 'typescript', tsx: 'typescript', 'react/typescript': 'typescript', ts: 'typescript',
      jsx: 'javascript', js: 'javascript', node: 'javascript', nodejs: 'javascript', 'react/javascript': 'javascript',
      'c++': 'cpp', 'c#': 'csharp', golang: 'go', py: 'python',
      rs: 'rust', kt: 'kotlin', kts: 'kotlin', ex: 'elixir', exs: 'elixir', erl: 'erlang',
      sh: 'bash', shell: 'bash', zsh: 'bash', pl: 'perl', hs: 'haskell',
    };
    return alias[v] ?? this.language;
  }

  private systemPrompt(): string {
    if (this.taskType === 'review') return this.reviewPrompt();
    const langName = this.language;
    return [
      'You are an expert competitive-programmer and senior engineer helping a candidate during a LIVE coding interview.',
      'You see the problem through screenshots the candidate captures. You CANNOT control their screen — if you need to see more, you must ASK the candidate to navigate (scroll, open a file) and re-capture.',
      '',
      'You have exactly four tools — call one each turn:',
      '• request_view(instruction): only when you genuinely cannot proceed. Ask for EXACTLY ONE thing the candidate can capture in a SINGLE screen — one scroll OR one file open. NEVER ask for two files or two actions in one instruction (the candidate captures one screen per turn, so a multi-part request like "open A.tsx and B.tsx" strands you waiting and you end up re-asking forever). Good: "Scroll down to show the rest of the function." / "Open TodoList.tsx." Bad: "Open TodoList.tsx and TodoItem.tsx and scroll App.tsx."',
      '• ask_user(question): when the TASK is ambiguous (e.g. optimize for time or space?). Keep it to one short question.',
      `• suggest_language(language, reason): when the on-screen project/problem is clearly in a DIFFERENT language or framework than the candidate's selected default (${langName}). NEVER call this proposing ${langName} itself — if ${langName} is already right, just solve. Propose the switch BEFORE solving — do NOT silently solve in the other language, and do NOT solve in ${langName} either. The candidate confirms with one tap, then you solve in the confirmed language.`,
      '• provide_solution(language, approach, code, complexity, notes): when you can solve. This ends the session.',
      '',
      'CONVERGE FAST — this is a live interview, not a code review. Aim to solve within 2-3 captures. BUT first make sure you have read the WHOLE problem: if the statement is cut off — it scrolls past the fold, says "Level/Part 1 of N", or has examples, constraints, input/output formats, or sections you have NOT seen yet — request_view to scroll and read ALL of it before solving. Reading the full problem is REQUIRED. What you must NOT chase is imported helper/component/type files — assume those work as their names suggest. Once you have the full problem and can see the code you will change, SOLVE: for a minor unseen detail, make a reasonable assumption and note it rather than spending another round-trip. A good answer now beats a perfect answer after six screenshots.',
      '',
      'MODIFICATIONS — make the SMALLEST change that satisfies the task. Preserve the existing code exactly: keep current names, imports, ordering, and formatting; do NOT refactor, rename, reorder, restyle, or rewrite anything the task does not require. Touch only the lines that must change. A 3-line task should be a 3-line diff, not a rewritten file.',
      '',
      // The picked language is a DEFAULT, not an override. The earlier build
      // hard-forced it and solved a React/.tsx task in Python because the
      // picker sat on its default. Now: match-or-suggest, never silently wrong.
      `Language: ${langName} is the candidate's selected default. If the problem is language-agnostic (a plain LeetCode prompt) OR already matches ${langName}, just solve in ${langName}. But if the screenshots or interviewer clearly indicate a DIFFERENT language/framework — a React/TypeScript project (.tsx/.jsx), a .py/.java/.go/.cpp file, a named framework, or the interviewer stating one — call suggest_language FIRST (with the closest of: ${CODING_LANGUAGES.join(', ')}) and let the candidate confirm before you solve. Only suggest on a CLEAR mismatch; never for ambiguous cases.`,
      '',
      'Requirements for provide_solution:',
      `• language: the language/framework you actually wrote the code in — the closest of: ${CODING_LANGUAGES.join(', ')}.`,
      '• approach: ONE sentence naming the approach.',
      '• code: complete, correct, runnable code. No placeholders or TODOs. Handle edge cases and empty/null input. Idiomatic and readable — the candidate may have to explain every line.',
      '• is_modification: true if you are CHANGING code already on the candidate\'s screen (fixing a bug, adding a feature to existing files); false if writing a fresh solution from scratch.',
      '• original_code: ONLY when is_modification is true. Transcribe VERBATIM from the screenshots (exact characters and indentation, no paraphrasing) the CURRENT code of JUST the region you are changing — the function/block you touch plus a few lines of context, NOT the whole file. `code` must be that SAME region after your edit (same scope, identical unchanged lines) so the line-by-line diff aligns. Omit when writing from scratch.',
      '• steps: ONLY when is_modification is true. The ordered, MINIMAL edits — each {file, instruction, explanation, old_code, code, start_line}. ORDER them top-to-bottom by position in each file; keep each small (the candidate applies them one at a time and reads the explanation aloud). To LOCATE each change reliably, in BOTH old_code and code include 2-3 UNCHANGED context lines immediately ABOVE and BELOW the change — byte-IDENTICAL on both sides — so the candidate can find the spot by matching surrounding code even after earlier edits shift the line numbers. Copy old_code and that context VERBATIM from the screenshot (exact characters and indentation, no paraphrasing or reformatting); if a line is unreadable, include more context you CAN read. So: old_code = context-above + current line(s) + context-below; code = context-above + new line(s) + context-below. Pure insertion: old_code = just the two context lines, code = those two lines with the new line(s) between them. start_line = the gutter line number of old_code\'s FIRST line in the ORIGINAL on-screen file (the UI shifts it to account for earlier steps). The steps together must produce the full `code`.',
      '• complexity: time and space, one line, e.g. "Time O(n), Space O(1)".',
      '• notes: 1-2 edge cases or talking points to mention aloud.',
    ].join('\n');
  }

  private reviewPrompt(): string {
    return [
      'You are a STAFF software engineer doing a CODE REVIEW alongside the candidate during a technical interview. Either the interviewer gave code to critique, or you are reviewing what the candidate just built in a live-coding round so they can discuss it together. Produce a sharp, senior-level review the candidate can present and defend out loud.',
      'You see the code through screenshots the candidate captures. You CANNOT control their screen — to see more, ASK them to navigate (scroll, open a file) and re-capture.',
      '',
      'You have exactly three tools — call one each turn:',
      '• request_view(instruction): only when you cannot review responsibly without seeing more. Ask for EXACTLY ONE thing capturable in a SINGLE screen — one scroll OR one file open. NEVER list multiple files or actions in one instruction (the candidate captures one screen per turn).',
      '• ask_user(question): one short question when the task or review scope is ambiguous.',
      '• provide_review(summary, findings, questions): when you have seen enough. This ends the session.',
      '',
      'CONVERGE FAST — aim to review within 2-3 captures. Focus on the code on screen; do not chase every import. Once you can see the main code, review it and note any assumptions rather than spending another round-trip.',
      '',
      'A strong review — what to put in provide_review:',
      '• summary: 1-2 sentences — overall quality and the single most important thing to address.',
      '• findings: ordered most-important-first; each is {location, severity, issue, suggestion}. PRIORITISE real problems — correctness bugs, security holes, race conditions, unhandled errors / edge cases, performance — over style nits. location = be specific ("App.tsx:42", "the retry loop", "useAuth"). severity = one of high | medium | low | nit | praise. issue = what is wrong (or, for praise, what is done well). suggestion = the concrete fix (brief for praise). Include at least one genuine STRENGTH (severity "praise") — good reviewers acknowledge what works.',
      '• questions: 1-3 sharp questions to raise with the interviewer that show senior judgement — clarify a requirement, surface a trade-off, or probe an assumption. These signal engagement in a collaborative review.',
      '',
      'Everything must be speakable — the candidate reads the review aloud and defends it. Be specific and concrete; never generic ("looks good", "add comments").',
    ].join('\n');
  }
}

// ── Tool schemas ────────────────────────────────────────────────────────────

const SOLVE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'request_view',
      description: 'Ask the candidate to navigate (scroll / open a file) and re-capture, because the current screenshots are not enough to solve.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'Short imperative instruction the candidate can act on in seconds.' },
        },
        required: ['instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the candidate ONE short clarifying question when the task is ambiguous.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
        },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'suggest_language',
      description: "Propose switching to the language/framework the problem is clearly in, when it differs from the candidate's selected default. Suspends until the candidate confirms; only then solve.",
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', description: `The language/framework the problem calls for — the closest of: ${CODING_LANGUAGES.join(', ')}.` },
          reason: { type: 'string', description: 'Short reason the switch is warranted, e.g. "the project uses React .tsx components".' },
        },
        required: ['language', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'provide_solution',
      description: 'Provide the final solution. Ends the session.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', description: `Language/framework you actually wrote the code in — the closest of: ${CODING_LANGUAGES.join(', ')}. Match what the problem requires (e.g. typescript for a React/.tsx task), NOT necessarily the candidate's default pick.` },
          approach: { type: 'string', description: 'One sentence naming the approach.' },
          code: { type: 'string', description: 'Complete, runnable solution code. For a modification, this is the edited region AFTER your changes.' },
          is_modification: { type: 'boolean', description: 'True if editing code already on the candidate\'s screen; false if writing a fresh solution.' },
          original_code: { type: 'string', description: 'Only when is_modification is true: the current code of the edited region, transcribed from the screenshots, at the SAME scope as `code`. Unchanged lines must be identical in both so the before/after diff reads correctly.' },
          steps: {
            type: 'array',
            description: 'Only when is_modification is true: the ordered MINIMAL edits, one focused change each. Together they equal `code`.',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string', description: 'File this edit applies to, e.g. "src/App.tsx".' },
                instruction: { type: 'string', description: 'Short imperative — what to change.' },
                explanation: { type: 'string', description: 'One sentence the candidate can say aloud: what it does / why.' },
                old_code: { type: 'string', description: 'Verbatim from the screenshot: 2-3 unchanged context lines ABOVE the change + the current line(s) being changed + 2-3 unchanged context lines BELOW. The context anchors the location.' },
                code: { type: 'string', description: 'The SAME block after the edit: identical context lines, with the changed line(s) swapped in. The shared context must be byte-identical to old_code.' },
                start_line: { type: 'number', description: 'Gutter line number of old_code\'s FIRST line in the ORIGINAL on-screen file. The UI shifts it for earlier steps.' },
              },
              required: ['file', 'instruction', 'explanation'],
            },
          },
          complexity: { type: 'string', description: 'Time and space complexity, one line.' },
          notes: { type: 'string', description: '1-2 edge cases / talking points.' },
        },
        required: ['language', 'approach', 'code', 'is_modification', 'complexity', 'notes'],
      },
    },
  },
] as const;

// Tools for a 'review' task: navigate + clarify + deliver the review. No
// suggest_language / provide_solution — review doesn't write code.
const REVIEW_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'request_view',
      description: 'Ask the candidate to navigate (scroll / open a file) and re-capture, because the current screenshots are not enough to review.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'Short imperative the candidate can do in one capture — ONE scroll or ONE file open.' },
        },
        required: ['instruction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the candidate ONE short clarifying question when the review scope or task is ambiguous.',
      parameters: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'provide_review',
      description: 'Provide the final code review. Ends the session.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One or two sentences: overall quality + the single most important thing to address.' },
          findings: {
            type: 'array',
            description: 'Review findings, most-important-first. Prioritise real problems over style nits; include at least one genuine strength (severity "praise").',
            items: {
              type: 'object',
              properties: {
                location: { type: 'string', description: 'Where — be specific, e.g. "App.tsx:42", "the retry loop", "useAuth".' },
                severity: { type: 'string', enum: ['high', 'medium', 'low', 'nit', 'praise'], description: 'high | medium | low | nit | praise.' },
                issue: { type: 'string', description: 'What is wrong (or, for praise, what is done well).' },
                suggestion: { type: 'string', description: 'Concrete fix or improvement (brief for praise).' },
              },
              required: ['location', 'severity', 'issue', 'suggestion'],
            },
          },
          questions: {
            type: 'array',
            description: '1-3 sharp questions to raise with the interviewer (clarify a requirement, surface a trade-off, probe an assumption).',
            items: { type: 'string' },
          },
        },
        required: ['summary', 'findings', 'questions'],
      },
    },
  },
] as const;
