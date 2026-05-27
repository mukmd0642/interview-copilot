// Node port of InterviewEngine.cs. Streams answer suggestions and key-point
// summaries via OpenAI Chat Completions. Preserves the settle-then-fire
// heuristic, the cancellation-on-new-question model, the bilingual prompt,
// and the same MAX_CONTEXT/TakeLast(6) shape so behavior matches the
// reference build the user has been tuning.

import { log, q } from '../log.js';
import type { Language, AnswerStyle } from '../../shared/ipc.js';
import { languagePromptName } from '../../shared/language.js';

export interface AnswerEvents {
  // (text, isDone)
  //   text="" + isDone=false → START signal (clear answer box).
  //   non-empty + isDone=false → streaming content chunk.
  //   text="" + isDone=true → DONE signal (success).
  //   non-empty + isDone=true → DONE-with-error-message.
  onAnswerChunk: (text: string, isDone: boolean) => void;
  onSummary: (text: string) => void;
}

interface ContextTurn {
  speaker: 'system' | 'mic';
  text: string;
}

// ── Settle / fire constants ────────────────────────────────────────────────
//
// The settle timer is the dominant latency contributor between "interviewer
// stops talking" and "first character of answer on screen." Old build used
// a single 3500 ms escape window — fine for hedging speakers, brutal for
// punchy ones who want a fast response.
//
// Two-clock approach:
//   • SETTLE_QUESTION_MS — fast path for utterances that already look like
//     questions (prefix like "How/What/Why/Tell me/Walk me/Describe…",
//     ends with "?", or contains "?"). Fires fast because waiting longer
//     rarely changes the answer.
//   • SETTLE_AMBIGUOUS_MS — soft window for non-question-shaped text. Reset
//     on every fresh delta so a slowly-arriving question accumulates fully.
//   • SETTLE_HARD_CAP_MS — measured from when the accumulator started, NOT
//     reset on new text. Guarantees we eventually fire even if a hedging
//     speaker keeps emitting fragments forever.
//
// MIN_WORDS_TO_FIRE is split: still 3 for ambiguous text (filters Whisper
// hallucinations like "you", "okay"), but 1 for question-shaped text so
// "Why MongoDB?" / "Scale?" / "Tradeoffs?" stop being silently swallowed.

const MAX_CONTEXT = 30;             // turns kept; only the last 6 enter the prompt
const SETTLE_QUESTION_MS = 800;     // question-shaped utterances — fire fast
const SETTLE_AMBIGUOUS_MS = 1500;   // non-question-shaped — wait a bit longer for more text
const SETTLE_HARD_CAP_MS = 3500;    // absolute max from accumulator start
const MIN_WORDS_AMBIGUOUS = 3;      // filter 1-2 word fragments (likely noise)
const MIN_WORDS_QUESTION_SHAPED = 1; // allow "Tradeoffs?" / "Scale?" to fire

const NOISE_WORDS = new Set([
  'um', 'uh', 'hmm', 'hm', 'yeah', 'yes', 'no',
  'ok', 'okay', 'right', 'sure', 'you', 'bye',
]);

// Words that, when they START an utterance, mark it as question-shaped.
// Lowercased; checked against the first whitespace-delimited token after
// stripping leading punctuation.
const QUESTION_PREFIXES = new Set([
  'how', 'what', 'why', 'when', 'where', 'which', 'who', 'whose', 'whom',
  'tell', 'walk', 'describe', 'explain', 'give', 'share',
  'can', 'could', 'would', 'should', 'will', 'do', 'does', 'did',
  'are', 'is', 'was', 'were', 'has', 'have', 'had',
]);

function isNoise(text: string): boolean {
  const s = text.trim().toLowerCase().replace(/[.,!?]+$/, '');
  return s.length < 4 || NOISE_WORDS.has(s);
}

function countWords(text: string): number {
  return text.split(/[\s\t\n\r]+/).filter((s) => s.length > 0).length;
}

/**
 * Returns true if the utterance is shaped like a question — either it
 * starts with a known question word, or it contains a literal "?", or
 * it ends with one. Used to pick the fast settle path and to lower the
 * min-words floor so genuinely short interviewer questions can fire.
 */
function isQuestionShaped(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.includes('?')) return true;
  // First token, lowercased, leading punctuation stripped.
  const firstToken = t.split(/\s+/, 1)[0]?.toLowerCase().replace(/^[^a-z]+/, '');
  if (firstToken && QUESTION_PREFIXES.has(firstToken)) return true;
  return false;
}

/** Last char tells us whether to fire immediately or wait for more text. */
function looksComplete(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return false;
  const tail = trimmed[trimmed.length - 1];
  const w = countWords(trimmed);
  if ((tail === '?' || tail === '!') && w >= 3) return true;
  if (tail === '.' && w >= 5) return true;
  // Embedded ? / ! with reasonable length — speakers often continue past
  // their question without a full stop.
  if (w >= 5 && (trimmed.includes('?') || trimmed.includes('!'))) return true;
  return false;
}

export class InterviewEngine {
  private jobDescription = '';
  private resume = '';
  private summary = '';
  private language: Language;
  private answerStyle: AnswerStyle = 'informal';
  private answersEnabled = true;

  private context: ContextTurn[] = [];
  private entryCount = 0;

  private lastSuggestedAnswer = '';
  private lastQuestion = '';
  private readonly interviewerKeyPoints: string[] = [];
  private readonly candidateKeyPoints: string[] = [];

  // Settle/fire pipeline state — whisper streams a multi-sentence question
  // as multiple short finals separated by pauses, so we coalesce.
  private pendingQuestion = '';
  private pendingQuestionStartAt = 0;      // ms when accumulator went non-empty
  private settleTimer: NodeJS.Timeout | null = null; // soft timer — resets on new text
  private hardCapTimer: NodeJS.Timeout | null = null; // hard timer — fires from start, never resets

  // Cancellable answer generation. New questions cancel any in-flight gen.
  private genAbort: AbortController | null = null;

  private disposed = false;

  constructor(
    private readonly apiKey: string,
    language: Language,
    private readonly events: AnswerEvents
  ) {
    this.language = language;
  }

  setContext(jd: string, resume: string): void {
    this.jobDescription = jd;
    this.resume = resume;
  }

  setLanguage(language: Language): void {
    this.language = language;
  }

  setAnswerStyle(style: AnswerStyle): void {
    if (this.answerStyle === style) return;
    this.answerStyle = style;
    this.log(`answer style → ${style}`);
  }

  setAnswersEnabled(enabled: boolean): void {
    this.answersEnabled = enabled;
    if (!enabled) this.cancelInFlight('answers-disabled');
  }

  // ── Hot path: transcript events feed in here ────────────────────────────

  notifyInterviewerSpoke(text: string): void {
    if (this.disposed) {
      this.log(`notifyInterviewer SKIP (disposed): ${q(text)}`);
      return;
    }
    if (!text.trim()) {
      this.log('notifyInterviewer SKIP (whitespace)');
      return;
    }
    if (isNoise(text)) {
      this.log(`notifyInterviewer SKIP (noise): ${q(text)}`);
      return;
    }

    // Append to accumulator; remember when this accumulation started so the
    // hard cap can fire on a true elapsed-time basis.
    const wasEmpty = this.pendingQuestion.length === 0;
    if (this.pendingQuestion) this.pendingQuestion += ' ';
    this.pendingQuestion += text;
    if (wasEmpty) this.pendingQuestionStartAt = Date.now();

    const snapshot = this.pendingQuestion;
    const complete = looksComplete(snapshot);

    // Always cancel any pending SOFT settle: either we fire now, or we
    // restart the soft window with the new accumulated text. The HARD cap
    // is left running — it measures absolute elapsed time from when the
    // accumulator went non-empty, so resetting it would defeat its purpose.
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }

    if (complete) {
      this.fireAccumulated('FIRE-IMMEDIATE (looks-complete)');
      return;
    }

    // Pick the soft settle window. Question-shaped text fires fast because
    // (a) it's almost certainly a complete-enough question already, and
    // (b) the cost of being wrong (interviewer adds more text) is just
    // cancel-and-restart, which the buffer pattern handles cleanly now.
    const questionShaped = isQuestionShaped(snapshot);
    const softMs = questionShaped ? SETTLE_QUESTION_MS : SETTLE_AMBIGUOUS_MS;
    this.log(
      `notifyInterviewer ENQUEUE: ${q(text)}; pending=${snapshot.length} chars; ` +
      `shape=${questionShaped ? 'question' : 'ambiguous'}; soft-settle ${softMs}ms`
    );

    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.fireAccumulated('soft-settle');
    }, softMs);

    // Arm the hard cap once per accumulation. It does NOT reset on fresh
    // text — that's the whole point: even if a slow speaker emits a new
    // clause every 1.4 s (keeping the soft timer alive forever), the hard
    // cap eventually fires and stops the user staring at a frozen UI.
    if (!this.hardCapTimer) {
      const elapsed = Date.now() - this.pendingQuestionStartAt;
      const remaining = Math.max(0, SETTLE_HARD_CAP_MS - elapsed);
      this.hardCapTimer = setTimeout(() => {
        this.hardCapTimer = null;
        // Only fire via the hard cap if the soft timer didn't beat us to it.
        if (this.pendingQuestion.length === 0) return;
        this.fireAccumulated('HARD-CAP');
      }, remaining);
    }
  }

  /**
   * Common path for firing the accumulated question: clear timers, validate
   * min-words (with relaxed floor for question-shaped text), add to context,
   * kick off generation.
   */
  private fireAccumulated(reason: string): void {
    if (this.disposed) return;
    if (this.settleTimer) { clearTimeout(this.settleTimer); this.settleTimer = null; }
    if (this.hardCapTimer) { clearTimeout(this.hardCapTimer); this.hardCapTimer = null; }

    const accumulated = this.pendingQuestion.trim();
    this.pendingQuestion = '';
    this.pendingQuestionStartAt = 0;
    if (!accumulated) return;

    const w = countWords(accumulated);
    const questionShaped = isQuestionShaped(accumulated);
    const floor = questionShaped ? MIN_WORDS_QUESTION_SHAPED : MIN_WORDS_AMBIGUOUS;

    this.log(`fire [${reason}] (${w} words, shape=${questionShaped ? 'question' : 'ambiguous'}): ${q(accumulated, 100)}`);
    if (w < floor) {
      this.log(`fire SKIP (too short: ${w} < ${floor})`);
      return;
    }
    this.addEntry('system', accumulated);
    this.startGeneration(accumulated);
  }

  notifyCandidateSpoke(text: string): void {
    if (this.disposed || !text.trim()) return;
    this.addEntry('mic', text);
    // Extract key points in the background — never blocks the hot path.
    void this.extractCandidateKeyPoints(text);
  }

  // ── Context bookkeeping ─────────────────────────────────────────────────

  private addEntry(speaker: 'system' | 'mic', text: string): void {
    this.context.push({ speaker, text });
    if (this.context.length > MAX_CONTEXT) this.context.shift();
    this.entryCount += 1;
    if (this.entryCount % 6 === 0) void this.updateSummary();
  }

  // ── Generation pipeline ─────────────────────────────────────────────────

  private startGeneration(question: string): void {
    if (!this.answersEnabled) {
      this.log('startGeneration SKIP (answers disabled)');
      return;
    }
    // Cancel previous in-flight call so the user always sees the answer for
    // the LATEST question. The reason 'new-question' tells the cancelled
    // gen's catch handler NOT to emit a DONE — because the new gen is
    // about to emit its own START, and ordering DONE before START is what
    // tells the store to enter buffer mode. Without this, the new START
    // arrives while answerStreaming is still true and the store wipes
    // the visible answer the candidate is mid-reading.
    this.cancelInFlight('new-question');
    this.genAbort = new AbortController();
    const signal = this.genAbort.signal;
    void this.generateAnswer(question, signal);
  }

  private cancelInFlight(reason: string): void {
    if (this.genAbort && !this.genAbort.signal.aborted) {
      this.log(`cancel in-flight (${reason})`);
      // AbortController.abort(reason) attaches the reason to signal.reason,
      // which the in-flight generateAnswer's catch handler checks.
      this.genAbort.abort(reason);
    }
    this.genAbort = null;
  }

  private async generateAnswer(question: string, signal: AbortSignal): Promise<void> {
    this.lastQuestion = question;
    // Fire-and-forget key-point extraction for the interviewer side.
    void this.extractInterviewerKeyPoints(question);

    const startedAt = Date.now();
    let firstChunkAt: number | null = null;
    const acc: string[] = [];

    try {
      if (signal.aborted) return;
      this.log(`generateAnswer START gpt-5 q=${q(question, 160)}`);
      this.events.onAnswerChunk('', false); // START → renderer clears

      // reasoning_effort=minimal: gpt-5 with default reasoning takes 10-20+ s
      // before first token. Live captions can't wait that long. Minimal
      // makes it emit nearly immediately while preserving answer quality.
      await this.stream(
        this.buildAnswerMessages(question),
        (chunk) => {
          if (signal.aborted) return;
          if (firstChunkAt === null) {
            firstChunkAt = Date.now();
            this.log(`first chunk after ${firstChunkAt - startedAt}ms: ${q(chunk, 60)}`);
          }
          acc.push(chunk);
          this.events.onAnswerChunk(chunk, false);
        },
        { model: 'gpt-5', maxTokens: 5000, reasoningEffort: 'minimal', signal }
      );

      if (signal.aborted) {
        this.log(`generateAnswer cancelled after stream completed`);
        return;
      }
      this.lastSuggestedAnswer = acc.join('');
      this.log(`generateAnswer DONE after ${Date.now() - startedAt}ms; ${this.lastSuggestedAnswer.length} chars`);
      this.events.onAnswerChunk('', true);
    } catch (err) {
      if (signal.aborted) {
        const reason = signal.reason as string | undefined;
        this.log(
          `generateAnswer aborted after ${Date.now() - startedAt}ms ` +
          `(reason=${reason ?? 'unspecified'}); partial=${acc.join('').length} chars`
        );
        // If we were aborted because a NEW question is starting, the new
        // generation will emit its own START momentarily. Emitting DONE
        // here would race that START and cause the store to enter the
        // wrong branch (wiping the visible answer the candidate is reading).
        // Other abort reasons (dispose, answers-disabled) still need DONE
        // so the renderer's answerStreaming flag flips off cleanly.
        if (reason !== 'new-question') {
          this.events.onAnswerChunk('', true);
        }
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`generateAnswer EXCEPTION: ${msg}`);
      this.events.onAnswerChunk(`[Error: ${msg}]`, true);
    }
  }

  // ── Prompt assembly ────────────────────────────────────────────────────
  //
  // The system prompt below is the product. It's been tuned through real
  // interview use to push gpt-5 toward narrative, scenario-specific answers
  // rather than the generic resume-summary tone the model defaults to.
  // Kept verbatim from the C# build so behaviour is comparable.

  private buildAnswerMessages(question: string): Array<{ role: string; content: string }> {
    const langName = languagePromptName(this.language);
    const sys: string[] = [];

    sys.push(`You are a real-time interview coach. The candidate is in a live interview RIGHT NOW. They read your output on a screen and speak it aloud, word for word, while the interviewer watches.`);
    sys.push(`IMPORTANT: Respond entirely in ${langName}.`);
    sys.push('');
    sys.push('Your goal: generate the answer that gets them the job offer.');
    sys.push('');

    // Style block — switches between two FORMAT regimes:
    //   informal: flowing spoken prose (the WinForms default)
    //   formal:   structured with bullets and brief section labels
    // The downstream LENGTH / DEPTH / REALISM / BY-QUESTION-TYPE blocks
    // describe content goals and apply to both styles.
    if (this.answerStyle === 'formal') {
      sys.push('FORMAT — structured, document-style answers (the candidate still reads aloud, so sentences must be speakable):');
      sys.push('  - The FIRST line is a one-sentence direct answer, bold-tone. If interrupted there, they have still answered.');
      sys.push('  - Use bullets LIBERALLY to organize details, steps, trade-offs, examples, comparisons. Default to bullets after the opening sentence for everything except short factual answers.');
      sys.push('  - For behavioral / experience / project deep-dives, structure the body under brief inline section labels: **Background**, **What I owned**, **Where it got hard**, **What I did**, **Result**. Each section is a tight bullet group of 1-3 items.');
      sys.push('  - Bullets are COMPLETE SENTENCES, not fragments. The candidate is speaking each one — fragments sound clipped.');
      sys.push('  - Tone: clear, professional, dense — but still speakable. No nested clauses, no sentence over 25 words. Plain English; contractions OK ("we\'d", "didn\'t").');
      sys.push("  - Conceptual technical explanations still get prose for the central reasoning, but the trade-offs and the alternatives considered should be enumerated as bullets.");
      sys.push('  - The BY QUESTION TYPE section below describes CONTENT goals (what to cover, what to include). When that section says things like "Narrative prose, no bullets," that is the informal-style directive; in THIS formal style, you still cover the same content but format it per these rules — opening sentence + bullets + section labels.');
    } else {
      sys.push('FORMAT — critical because they read it on a screen and speak it out loud while being watched:');
      sys.push('  - The FIRST sentence must answer the question on its own. If interrupted there, they have still answered.');
      sys.push('  - Default to spoken prose in short paragraphs of 2-4 sentences separated by a blank line. Each paragraph is one natural pause where the candidate can breathe.');
      sys.push("  - Sentences are short and speakable — no nested clauses, no sentence over 25 words. Use plain conversational English with contractions ('we'd', 'didn't', 'I've'). It must read out loud naturally, exactly as written.");
      sys.push("  - Use bullets ONLY when the answer is genuinely a list of discrete items: 'what tools have you used', 'list the steps', 'X vs Y', 'what are the tradeoffs of A vs B', 'what frameworks/languages do you know'. For these, bullets help the candidate scan and read smoothly.");
      sys.push("  - Conceptual technical explanations ('how does X work', 'walk me through your design', 'how would you architect this', 'why did you choose Y') are spoken prose, NOT bullets — the candidate is explaining the system out loud, not reading items off a list. Use natural connective tissue ('the reason that matters is…', 'where this gets tricky is…', 'so what we did was…').");
    }
    sys.push('');
    sys.push('LENGTH — give the interviewer enough to chew on. Short answers feel evasive. Match these targets:');
    sys.push('  - Trivial / yes-no / quick factual: 2-4 sentences (~50-100 words).');
    sys.push("  - Behavioral / experience / 'tell me about a time' / 'walk me through a project': RICH storytelling, ~280-450 words. Set the scene, name the system and stakes, walk through the specific actions and the moments of friction, land the result with a concrete number or change. Don't shortcut the middle — the friction and the decisions are what the interviewer is actually evaluating.");
    sys.push("  - Intro / background / 'tell me about yourself': ~250-350 words of narrative. Move through the career arc with one or two concrete moments that make it land.");
    sys.push("  - Technical conceptual deep-dives (architecture, system design, debugging walkthroughs, 'how would you build…'): ~280-450 words of PROSE. One-sentence direct answer, then explain how it works, the trade-offs you weighed and why, and one concrete moment from experience that grounds it.");
    sys.push('  - Technical list / comparison: bullet format, 5-8 bullets, with a one-sentence preamble and a one-sentence closer stating your pick and why.');
    sys.push('  - Opinion / approach / culture: ~180-280 words of prose. Position in the first sentence, one real experience that formed it, brief honest acknowledgement of the trade-off.');
    sys.push('');
    sys.push('DEPTH — every answer must give the interviewer something to follow up on:');
    sys.push("  - Name the specific project, team, system, or decision — never 'a project I worked on'.");
    sys.push('  - Include at least one moment of friction or surprise: the bug we missed, the assumption that broke, the pushback from a stakeholder, the trade-off we reluctantly made.');
    sys.push('  - Include at least one concrete number or scale marker: latency, traffic, team size, cost, time-to-recovery, percent improvement.');
    sys.push("  - For experience answers, hit this arc implicitly: where I was → what I owned → what got hard → what I did about it → what the result was → what I learned. Don't label the stages, just walk through them.");
    sys.push('');
    sys.push('REALISM — answers must sound like lived experience, not a resume summary:');
    sys.push("  - Invent specific details: project names, incident names, internal tool names, team names, metrics, timelines, client descriptions ('a mid-size logistics company', 'our biggest enterprise account').");
    sys.push('  - Invent concrete challenges: the outage, the failed migration, the scope creep, the team conflict, the thing that went wrong first before it went right.');
    sys.push('  - Use numbers: p99 latency, deploy frequency, team size, cost delta, data volume — whatever fits naturally.');
    sys.push("  - Forbidden: 'We had some challenges', 'I worked on various projects', 'I improved performance'. Always say what specifically happened.");
    sys.push('');
    sys.push('CONSISTENCY — the candidate has already said things in this interview. You must not contradict them.');
    sys.push('  - If a project, company, tool, or metric was mentioned earlier in the conversation, use the exact same name and details.');
    sys.push("  - If this is a follow-up question about something already mentioned, go deeper — add new detail, don't repeat what was already said.");
    sys.push('');
    sys.push('BY QUESTION TYPE:');
    sys.push("  INTRO / BACKGROUND ('tell me about yourself', 'walk me through your background'): Narrative prose, no bullets. ~250-350 words. Move through the career naturally — what the work was, what was interesting or hard, what led to the next move. Reference one or two concrete projects so it isn't generic. Land on why this role, right now.");
    sys.push("  BEHAVIORAL ('tell me about a time', 'how did you handle', 'describe a situation'): Narrative prose, no bullets. ~280-450 words. Tell the specific incident in depth — set the scene with the system and stakes, what you tried first, what didn't work, what finally worked, what the measurable result was. Embed STAR naturally, never label it. End with what changed or what you learned.");
    sys.push("  EXPERIENCE / PROJECT DEEP-DIVE ('walk me through a project you're proud of', 'tell me about something you built', 'describe your role on…'): Narrative prose, no bullets. ~300-450 words. Treat like a behavioral answer — name the system, the team, the constraints, the specific technical decisions you made and why, the moments of friction, and the concrete outcome. This is the answer that proves seniority; do not shortcut it.");
    sys.push("  OPINION / APPROACH / CULTURE: Prose. ~180-280 words. State position clearly in the first sentence, back it with one real experience, briefly acknowledge the trade-off so it doesn't sound dogmatic.");
    sys.push('  DO YOU HAVE ANY QUESTIONS FOR US:');
    sys.push('    First, infer the meeting type from the conversation and key points so far:');
    sys.push('      - INTRO / RECRUITER SCREEN: focus on role clarity, team structure, hiring process and timeline, what success looks like in the first 90 days, why the position is open.');
    sys.push('      - TECHNICAL INTERVIEW: focus on the tech stack decisions and why they were made, biggest current technical challenges, how the team handles incidents and tech debt, deployment and release process, how technical decisions are made.');
    sys.push('      - HIRING MANAGER / CULTURE: focus on team dynamics, management style, how feedback is given, what the best performers on the team have in common, what makes people leave.');
    sys.push('      - PANEL / FINAL ROUND: mix of strategic questions — company direction, how cross-team collaboration works, what the interviewer wishes they had known before joining.');
    sys.push('    Generate 4-5 questions. Use bullets. Rules:');
    sys.push("      - Each question must be creative and specific — reference something from the job description, the conversation, or the interviewer key points. No generic questions like 'What does a typical day look like?'");
    sys.push('      - Vary the categories: at least one about the team, one about challenges, one about culture or growth, one about the role itself or next steps.');
    sys.push('      - Phrase as natural spoken questions, not formal written ones.');
    sys.push('      - The best questions show the candidate has been paying attention and is thinking like someone who already works there.');
    sys.push("  AMBIGUOUS / UNCLEAR QUESTION: If the question is vague or could mean multiple things, start the answer with a brief natural clarifying question ('Just to make sure I'm answering the right thing — are you asking about X or more about Y?'), then give a short answer for the most likely interpretation so the candidate isn't left silent while waiting for the reply.");
    sys.push("  TECHNICAL CONCEPTUAL ('how does X work', 'walk me through how you would design Y', 'explain Z', 'why would you use A', debugging walkthroughs, architecture/system design): Spoken PROSE, not bullets. ~280-450 words. Lead with a one-sentence direct answer that takes a clear position. Then in flowing paragraphs cover: how it actually works, what the alternatives are and why you chose this one, the trade-offs and the case where it would fall over, and one concrete moment from your own experience where you applied it. The candidate is having a technical conversation, not reading a slide.");
    sys.push("  TECHNICAL LIST / COMPARISON ('X vs Y', 'list the steps', 'what tools/frameworks/languages have you used', 'what are the differences between A and B', 'what are the tradeoffs'): Bullets are appropriate. One-sentence preamble, then 5-8 tight bullets — each bullet one distinct idea, one line, easy to glance at and speak. Close with one sentence stating your preference or recommendation and the brief reason.");
    sys.push('');
    sys.push("Never open with: 'Great question', 'Absolutely', 'Sure', 'Of course', 'Certainly', or any filler affirmation.");

    if (this.jobDescription.trim()) {
      sys.push('');
      sys.push('JOB DESCRIPTION:');
      sys.push(this.jobDescription.length > 1200 ? this.jobDescription.slice(0, 1200) + '…' : this.jobDescription);
    }
    if (this.resume.trim()) {
      sys.push('');
      sys.push('CANDIDATE RESUME / KEY POINTS:');
      sys.push(this.resume.length > 1800 ? this.resume.slice(0, 1800) + '…' : this.resume);
    }
    if (this.summary.trim()) {
      sys.push('');
      sys.push('CONVERSATION SUMMARY SO FAR:');
      sys.push(this.summary);
    }
    if (this.interviewerKeyPoints.length > 0) {
      sys.push('');
      sys.push('INTERVIEWER KEY POINTS (topics raised, requirements, preferences mentioned so far):');
      sys.push('Use these to understand what the interviewer cares about. Make sure the answer addresses their focus areas.');
      for (const f of this.interviewerKeyPoints.slice(-40)) sys.push(`  • ${f}`);
    }
    if (this.candidateKeyPoints.length > 0) {
      sys.push('');
      sys.push('CANDIDATE KEY POINTS (what the candidate has actually stated in this interview):');
      sys.push('Ground truth — build on these, never contradict them.');
      for (const f of this.candidateKeyPoints.slice(-40)) sys.push(`  • ${f}`);
    }

    const ctxLines: string[] = ['Last 6 conversation turns:'];
    for (const t of this.context.slice(-6)) {
      ctxLines.push(`${t.speaker === 'system' ? 'Interviewer' : 'Candidate'}: ${t.text}`);
    }

    const userLines: string[] = [...ctxLines];
    if (this.lastSuggestedAnswer.trim()) {
      const prev = this.lastSuggestedAnswer.length > 700
        ? this.lastSuggestedAnswer.slice(0, 700) + '…'
        : this.lastSuggestedAnswer;
      userLines.push('');
      userLines.push(`Last suggested answer (check the conversation above to see what the candidate actually said — they may have gone off-script):`);
      userLines.push(prev);
    }
    userLines.push('');
    userLines.push(`Interviewer just asked:`);
    userLines.push(`"${question}"`);
    userLines.push('');
    userLines.push('Suggest what the candidate should say:');

    return [
      { role: 'system', content: sys.join('\n') },
      { role: 'user', content: userLines.join('\n') },
    ];
  }

  // ── Summary + key-points background tasks ──────────────────────────────

  private async updateSummary(): Promise<void> {
    if (this.disposed) return;
    try {
      if (this.context.length < 3) return;
      const snap = this.context
        .map((t) => `${t.speaker === 'system' ? 'Interviewer' : 'Candidate'}: ${t.text}`)
        .join('\n');
      const lang = languagePromptName(this.language);
      const result: string[] = [];
      await this.stream(
        [
          { role: 'system', content: `Summarize this job interview as 4-5 bullet points starting with •. Topics, candidate strengths, key skills, open questions. Be very concise. Respond in ${lang}.` },
          { role: 'user', content: snap },
        ],
        (chunk) => result.push(chunk),
        { model: 'gpt-5-mini', maxTokens: 5000, reasoningEffort: 'minimal' }
      );
      const s = result.join('').trim();
      if (s) {
        this.summary = s;
        this.events.onSummary(s);
      }
    } catch (err) {
      this.log(`updateSummary error: ${(err as Error).message}`);
    }
  }

  private async extractInterviewerKeyPoints(text: string): Promise<void> {
    try {
      const out: string[] = [];
      await this.stream(
        [
          { role: 'system', content: 'You are a precise extractor. Return only valid JSON with no markdown fences.' },
          { role: 'user',   content: `Interviewer said: "${text}"\n\nExtract key points: topics raised, requirements mentioned, constraints, preferences, names. Short phrases only. Empty array if nothing notable.\nReturn only valid JSON: {"keyPoints": []}` },
        ],
        (chunk) => out.push(chunk),
        { model: 'gpt-5-mini', maxTokens: 300, reasoningEffort: 'minimal' }
      );
      const points = this.parseKeyPoints(out.join(''));
      if (points.length > 0) this.interviewerKeyPoints.push(...points);
    } catch (err) {
      this.log(`extractInterviewer error: ${(err as Error).message}`);
    }
  }

  private async extractCandidateKeyPoints(text: string): Promise<void> {
    try {
      const out: string[] = [];
      await this.stream(
        [
          { role: 'system', content: 'You are a precise extractor. Return only valid JSON with no markdown fences.' },
          { role: 'user',   content: `Candidate said: "${text}"\n\nExtract key points the candidate revealed about themselves: names, technologies, companies, projects, numbers, claims, decisions. Short phrases only. Empty array if nothing notable.\nReturn only valid JSON: {"keyPoints": []}` },
        ],
        (chunk) => out.push(chunk),
        { model: 'gpt-5-mini', maxTokens: 300, reasoningEffort: 'minimal' }
      );
      const points = this.parseKeyPoints(out.join(''));
      if (points.length > 0) {
        this.candidateKeyPoints.push(...points);
        this.log(`candidate key points: +${points.length}`);
      }
    } catch (err) {
      this.log(`extractCandidate error: ${(err as Error).message}`);
    }
  }

  private parseKeyPoints(raw: string): string[] {
    let json = raw.trim();
    // Strip code fences if the model added them despite the system prompt.
    if (json.startsWith('```')) {
      const lines = json.split('\n');
      lines.shift(); // opening fence
      while (lines.length > 0 && !lines[lines.length - 1]?.startsWith('```')) {
        // keep going until we find a closing fence or run out
        break;
      }
      // simpler: strip first line, drop any trailing fence
      const closing = lines.findIndex((l) => l.startsWith('```'));
      json = (closing >= 0 ? lines.slice(0, closing) : lines).join('\n');
    }
    try {
      const parsed = JSON.parse(json) as { keyPoints?: unknown };
      const arr = parsed.keyPoints;
      if (!Array.isArray(arr)) return [];
      return arr.filter((s): s is string => typeof s === 'string' && s.length > 0);
    } catch {
      return [];
    }
  }

  // ── OpenAI SSE streaming ───────────────────────────────────────────────

  private async stream(
    messages: Array<{ role: string; content: string }>,
    onChunk: (text: string) => void,
    opts: { model: string; maxTokens: number; reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'; signal?: AbortSignal }
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      model: opts.model,
      stream: true,
      max_completion_tokens: opts.maxTokens,
      messages,
    };
    if (opts.reasoningEffort) payload.reasoning_effort = opts.reasoningEffort;

    const httpStart = Date.now();
    this.log(`POST ${opts.model}`);

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: opts.signal,
    });

    this.log(`HTTP ${resp.status} after ${Date.now() - httpStart}ms`);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      this.log(`ERROR ${resp.status}: ${q(body, 500)}`);
      throw new Error(`OpenAI ${resp.status}: ${body || resp.statusText}`);
    }
    if (!resp.body) throw new Error('OpenAI returned no response body');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (!this.disposed && !opts.signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are split by blank lines. Each frame starts "data: ...".
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const text = json.choices?.[0]?.delta?.content;
          if (text) onChunk(text);
        } catch {
          // Malformed SSE chunk — skip, don't tear down the stream.
        }
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelInFlight('dispose');
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.hardCapTimer) {
      clearTimeout(this.hardCapTimer);
      this.hardCapTimer = null;
    }
    this.pendingQuestion = '';
    this.pendingQuestionStartAt = 0;
  }

  private log(msg: string): void {
    log('engine', msg);
  }
}
