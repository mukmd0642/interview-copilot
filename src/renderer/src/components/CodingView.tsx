import { useState, useRef, useEffect, type ComponentProps } from 'react';
import { useApp } from '../state/store.js';
import { CODING_LANGUAGES, type CodingLanguage, type CodingStep, type CodeEditStep, type CodeReview, type ReviewSeverity } from '../../../shared/ipc';
import { startGoalRecording, type GoalRecorder } from '../lib/record-goal.js';
import { highlightCode } from '../lib/highlight.js';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';

// Agentic coding mode. Fast-by-default, agentic-when-needed:
//   • Set a goal (type or 🎤), pick language + Fast/Careful, hit Solve.
//   • Most problems resolve on the first capture (single-shot speed).
//   • When the agent needs more it shows a DO-THIS-NEXT banner ("scroll",
//     "open file X", or a question); you act + re-capture and it continues.

const LANG_LABEL: Record<CodingLanguage, string> = {
  python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java',
  cpp: 'C++', csharp: 'C#', go: 'Go', ruby: 'Ruby', sql: 'SQL',
};

export function CodingView(): JSX.Element {
  const language = useApp((s) => s.codingLanguage);
  const setLanguage = useApp((s) => s.setCodingLanguage);
  const effort = useApp((s) => s.codingEffort);
  const setEffort = useApp((s) => s.setCodingEffort);
  const taskType = useApp((s) => s.codingTaskType);
  const setTaskType = useApp((s) => s.setCodingTaskType);
  const review = useApp((s) => s.codingReview);
  const codingAnswer = useApp((s) => s.codingAnswer);
  const clearAnswer = useApp((s) => s.clearCodingAnswer);
  const guidedActive = useApp((s) => s.guidedActive);
  const startGuided = useApp((s) => s.startGuided);
  const active = useApp((s) => s.codingActive);
  const phase = useApp((s) => s.codingPhase);
  const timeline = useApp((s) => s.codingTimeline);
  const instruction = useApp((s) => s.codingInstruction);
  const captureCount = useApp((s) => s.captureCount);
  const question = useApp((s) => s.codingQuestion);
  const suggestLanguage = useApp((s) => s.codingSuggestLanguage);
  const suggestReason = useApp((s) => s.codingSuggestReason);
  const solution = useApp((s) => s.codingSolution);
  const codingError = useApp((s) => s.codingError);
  const beginSession = useApp((s) => s.beginCodingSession);
  const endSession = useApp((s) => s.endCodingSession);
  // Live interviewer caption (so the candidate sees it's listening + what
  // was heard). Coding-mode transcription emits the same Transcript events
  // the interview view uses, so system entries / liveSystem are populated.
  const entries = useApp((s) => s.entries);
  const liveSystem = useApp((s) => s.liveSystem);
  const lastInterviewer = [...entries].reverse().find((e) => e.source === 'system')?.text ?? '';
  const heard = (liveSystem.trim() || lastInterviewer).slice(0, 160);

  const [goal, setGoal] = useState('');
  const [answer, setAnswer] = useState('');
  const [recording, setRecording] = useState(false);
  const recRef = useRef<GoalRecorder | null>(null);

  // NOTE: the coding IPC subscriptions (onStep / onCaptureHotkey) live in
  // InterviewView, the always-mounted shell — NOT here. CodingView isn't
  // mounted in interview mode, so a subscription here would miss a session
  // kicked off by the global capture hotkey, and could race early steps on
  // mode-switch. This component is pure presentation over store state.

  const handleSolve = async (): Promise<void> => {
    beginSession();
    const res = await window.api.coding.start({ goal: goal.trim(), language, effort, taskType });
    if (!res.ok) {
      useApp.getState().applyCodingStep({ kind: 'error', message: res.message ?? 'Failed to start' });
    }
  };

  const handleVoice = async (): Promise<void> => {
    if (recording) {
      const rec = recRef.current;
      recRef.current = null;
      setRecording(false);
      if (!rec) return;
      try {
        const wav = await rec.stop();
        const out = await window.api.coding.transcribeGoal(wav);
        if ('text' in out && out.text) setGoal((g) => (g ? `${g} ${out.text}` : out.text));
      } catch { /* ignore — user can type instead */ }
    } else {
      try {
        recRef.current = await startGoalRecording();
        setRecording(true);
      } catch { /* mic denied — typing still works */ }
    }
  };

  const submitAnswer = async (): Promise<void> => {
    const text = answer.trim();
    if (!text) return;
    setAnswer('');
    await window.api.coding.answer(text);
  };

  // suggest_language: accept switches the picker (persisted) + tells the agent
  // to solve in the new language; decline keeps the current pick.
  const acceptSuggestion = async (): Promise<void> => {
    if (!suggestLanguage) return;
    setLanguage(suggestLanguage);
    await window.api.coding.resolveLanguage(true, suggestLanguage);
  };
  const declineSuggestion = async (): Promise<void> => {
    await window.api.coding.resolveLanguage(false, language);
  };

  const reset = (): void => {
    void window.api.coding.cancel();
    endSession();
  };

  const busy = active && (phase === 'thinking');

  // Keep the agent log scrolled to the newest entry — it appends at the
  // bottom, and without this the view stays pinned at the top so new steps
  // never come into view.
  const timelineRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline.length, busy]);

  return (
    <div className="coding">
      {/* Goal bar */}
      <div className="coding__goalbar">
        {/* Solve vs Review — what the agent is being asked to do. */}
        <div className="coding__effort coding__tasktype" title="Solve a problem, or review existing code">
          <button className={taskType === 'solve' ? 'on' : ''} onClick={() => setTaskType('solve')} disabled={active}>Solve</button>
          <button className={taskType === 'review' ? 'on' : ''} onClick={() => setTaskType('review')} disabled={active}>Review</button>
        </div>
        <input
          className="coding__goal"
          placeholder={taskType === 'review'
            ? "What should I review?  (blank = review what's on screen)"
            : "What should I do?  (blank = solve what's on screen)"}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          disabled={active}
        />
        <button
          className={`coding__mic${recording ? ' coding__mic--rec' : ''}`}
          onClick={() => void handleVoice()}
          title="Hold-to-talk goal (push to start/stop)"
          disabled={active}
        >
          {recording ? '● Rec' : '🎤'}
        </button>
        <select
          className="coding__lang"
          value={language}
          onChange={(e) => setLanguage(e.target.value as CodingLanguage)}
          disabled={active}
        >
          {CODING_LANGUAGES.map((l) => <option key={l} value={l}>{LANG_LABEL[l]}</option>)}
        </select>
        <div className="coding__effort" title="Fast = ~3-8s. Careful = deeper, ~10-30s.">
          <button className={effort === 'fast' ? 'on' : ''} onClick={() => setEffort('fast')} disabled={active}>Fast</button>
          <button className={effort === 'careful' ? 'on' : ''} onClick={() => setEffort('careful')} disabled={active}>Careful</button>
        </div>
        {!active ? (
          <button className="coding__solve" onClick={() => void handleSolve()}>{taskType === 'review' ? 'Review ⤓' : 'Solve ⤓'}</button>
        ) : (
          <>
            <button className="coding__solve coding__solve--now" onClick={() => void window.api.coding.solveNow()} disabled={phase === 'solved'}>{taskType === 'review' ? 'Review now' : 'Solve now'}</button>
            <button className="coding__reset" onClick={reset}>Reset</button>
          </>
        )}
      </div>

      {/* Live interviewer caption — shows it's listening + what was heard */}
      <div className="coding__heard" title={heard}>
        <span className="coding__heard__icon">🎧</span>
        <span className="coding__heard__text">{heard || 'Listening to the interviewer…'}</span>
      </div>

      {/* Answer to an interviewer's spoken question — auto-pops, dismissible. */}
      {codingAnswer && (
        <div className="coding__banner coding__banner--answer">
          <span className="coding__banner__icon">💬</span>
          <span className="coding__banner__text">{codingAnswer.answer}</span>
          <button className="coding__banner__btn coding__banner__btn--ghost" onClick={() => clearAnswer()}>Dismiss</button>
        </div>
      )}

      {/* DO THIS NEXT banner — only when the agent needs the candidate */}
      {phase === 'navigate' && (
        <div className="coding__banner coding__banner--nav">
          <span className="coding__banner__icon">⬇</span>
          <span className="coding__banner__text">{instruction}</span>
          {captureCount > 0 && <span className="coding__banner__count" title="Screens captured this session">{captureCount} captured</span>}
          <button className="coding__banner__btn" onClick={() => void window.api.coding.capture()}>Capture again</button>
          {/* Escape hatch: let the candidate cut a request_view spiral and finish now. */}
          <button className="coding__banner__btn coding__banner__btn--ghost" onClick={() => void window.api.coding.solveNow()}>{taskType === 'review' ? 'Review with this' : 'Solve with this'}</button>
        </div>
      )}
      {phase === 'ask' && (
        <div className="coding__banner coding__banner--ask">
          <span className="coding__banner__icon">❓</span>
          <span className="coding__banner__text">{question}</span>
          <input
            className="coding__answer"
            placeholder="Answer…"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitAnswer(); }}
            autoFocus
          />
          <button className="coding__banner__btn" onClick={() => void submitAnswer()}>Send</button>
        </div>
      )}
      {phase === 'suggest' && suggestLanguage && (
        <div className="coding__banner coding__banner--suggest">
          <span className="coding__banner__icon">💡</span>
          <span className="coding__banner__text">
            Looks like <b>{LANG_LABEL[suggestLanguage]}</b>. Solve in {LANG_LABEL[suggestLanguage]} instead of {LANG_LABEL[language]}?
            {suggestReason ? ` — ${suggestReason}` : ''}
          </span>
          {/* autoFocus so ⏎ confirms; the global solve hotkey confirms too. */}
          <button className="coding__banner__btn" onClick={() => void acceptSuggestion()} autoFocus>Switch &amp; solve ⏎</button>
          <button className="coding__banner__btn coding__banner__btn--ghost" onClick={() => void declineSuggestion()}>Keep {LANG_LABEL[language]}</button>
        </div>
      )}

      <div className="coding__body">
        {/* Agent timeline (compact, scrollable) — auto-scrolls to newest. */}
        <div className="coding__timeline" ref={timelineRef}>
          {timeline.length === 0 && !active && (
            <div className="coding__hint">
              Open the coding problem on screen, set a goal (optional), and hit <b>Solve</b>.
              The agent reads your screen. If it needs more, it&apos;ll tell you what to scroll to or open — you navigate, then re-capture.
            </div>
          )}
          {timeline.map((t) => (
            <div key={t.id} className={`coding__step coding__step--${t.step.kind}`}>
              {stepLabel(t.step)}
            </div>
          ))}
          {busy && <div className="coding__step coding__step--thinking">thinking…</div>}
        </div>

        {/* Solution / review */}
        <div className="coding__solution">
          {review ? (
            <ReviewView review={review} />
          ) : solution ? (
            <>
              <div className="coding__approach">{solution.approach}</div>
              {solution.isModification ? (
                <>
                  {solution.steps && solution.steps.length > 0 && (
                    guidedActive ? (
                      <GuidedView steps={solution.steps} language={solution.language} />
                    ) : (
                      <>
                        {solution.steps.length >= 2 && (
                          <button className="coding__guide" onClick={() => startGuided()}>▶ Guide me through these steps</button>
                        )}
                        <StepsView steps={solution.steps} language={solution.language} />
                      </>
                    )
                  )}
                  {solution.originalCode && (
                    solution.steps && solution.steps.length > 0 ? (
                      <details className="coding__diffwrap">
                        <summary className="coding__diffsummary">Show full diff</summary>
                        <DiffView original={solution.originalCode} modified={solution.code} language={solution.language} />
                      </details>
                    ) : (
                      <DiffView original={solution.originalCode} modified={solution.code} language={solution.language} />
                    )
                  )}
                </>
              ) : (
                <div className="coding__codewrap">
                  <button
                    className="coding__copy"
                    onClick={() => { if (solution.code) navigator.clipboard.writeText(solution.code); }}
                    title="Copy code"
                  >Copy code</button>
                  <pre className="coding__code"><code className="hljs" dangerouslySetInnerHTML={{ __html: highlightCode(solution.code, solution.language) }} /></pre>
                </div>
              )}
              <div className="coding__meta">
                <span className="coding__complexity">{solution.complexity}</span>
                {solution.notes && <span className="coding__notes">{solution.notes}</span>}
              </div>
            </>
          ) : phase === 'error' ? (
            <div className="coding__error">{codingError}</div>
          ) : (
            <div className="coding__placeholder">
              {active ? 'Working…' : taskType === 'review' ? 'The review will appear here.' : 'The solution will appear here.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Git-style before/after view for modification tasks, via
// react-diff-viewer-continued: word-level intra-line diff, our highlight.js
// for syntax colours, theme-aware. disableWorker uses the synchronous path so
// there's no web-worker bundle to fail under the packaged app's file:// + CSP.
// The "Original" side is the agent's transcription of the on-screen code, so
// treat it as guidance, not ground truth.
// Style overrides drive the three fixes the bare library got wrong in the
// overlay: (1) word-wrap long lines, (2) readable contrast — subtle line tints
// + colored gutters so our hljs token colours stay legible, (3) an exact 50/50
// split via table-layout:fixed + fixed gutter/marker widths (the 2 content
// columns then share the remainder equally). Colors reference the app's CSS
// vars so the diff follows the theme.
const tint = {
  dark: { add: 'rgba(63,185,80,0.12)', rem: 'rgba(248,81,73,0.12)', wAdd: 'rgba(63,185,80,0.32)', wRem: 'rgba(248,81,73,0.32)', gAdd: 'rgba(63,185,80,0.22)', gRem: 'rgba(248,81,73,0.22)' },
  light: { add: 'rgba(46,160,67,0.13)', rem: 'rgba(200,60,60,0.10)', wAdd: 'rgba(46,160,67,0.28)', wRem: 'rgba(200,60,60,0.24)', gAdd: 'rgba(46,160,67,0.20)', gRem: 'rgba(200,60,60,0.18)' },
};
function diffVars(t: { add: string; rem: string; wAdd: string; wRem: string; gAdd: string; gRem: string }) {
  return {
    diffViewerBackground: 'var(--bg)', diffViewerColor: 'var(--fg)',
    addedBackground: t.add, addedColor: 'var(--fg)',
    removedBackground: t.rem, removedColor: 'var(--fg)',
    wordAddedBackground: t.wAdd, wordRemovedBackground: t.wRem,
    addedGutterBackground: t.gAdd, removedGutterBackground: t.gRem,
    gutterBackground: 'var(--bg-elev2)', gutterBackgroundDark: 'var(--bg-elev2)',
    gutterColor: 'var(--fg-very-muted)', addedGutterColor: 'var(--fg-muted)', removedGutterColor: 'var(--fg-muted)',
    emptyLineBackground: 'transparent', codeFoldBackground: 'var(--bg-elev2)', codeFoldGutterBackground: 'var(--bg-elev2)',
  };
}
const DIFF_STYLES = {
  variables: { dark: diffVars(tint.dark), light: diffVars(tint.light) },
  diffContainer: { width: '100%', tableLayout: 'fixed' },
  gutter: { width: '30px', minWidth: '30px', maxWidth: '30px', padding: '0 4px' },
  marker: { width: '14px', minWidth: '14px', maxWidth: '14px', padding: 0 },
  lineNumber: { fontSize: '10px' },
  contentText: {
    fontFamily: "'Cascadia Code', 'Consolas', 'SF Mono', monospace",
    fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere',
  },
} as ComponentProps<typeof ReactDiffViewer>['styles'];

const SEV_LABEL: Record<ReviewSeverity, string> = {
  high: 'High', medium: 'Med', low: 'Low', nit: 'Nit', praise: 'Good',
};

// Code-review result: overall summary, severity-ordered findings, and smart
// questions to raise with the interviewer (great for the collaborative
// post-live-coding review).
function ReviewView({ review }: { review: CodeReview }): JSX.Element {
  return (
    <div className="coding__review">
      {review.summary && <div className="coding__approach">{review.summary}</div>}
      {review.findings.length > 0 && (
        <ul className="coding__findings">
          {review.findings.map((f, i) => (
            <li key={i} className={`coding__finding coding__finding--${f.severity}`}>
              <div className="coding__finding__head">
                <span className={`coding__sev coding__sev--${f.severity}`}>{SEV_LABEL[f.severity]}</span>
                {f.location && <span className="coding__finding__loc">{f.location}</span>}
              </div>
              {f.issue && <div className="coding__finding__issue">{f.issue}</div>}
              {f.suggestion && <div className="coding__finding__fix">→ {f.suggestion}</div>}
            </li>
          ))}
        </ul>
      )}
      {review.questions.length > 0 && (
        <div className="coding__questions">
          <div className="coding__questions__head">Ask the interviewer</div>
          <ul>
            {review.questions.map((qn, i) => <li key={i}>{qn}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

// Ordered, explained minimal edits — the primary view for modification tasks.
// Each step: which file, what to change, a one-line explanation to read aloud,
// and the snippet to type. Apply top to bottom.
function lineCount(s: string): number {
  return s.length === 0 ? 0 : s.split('\n').length;
}

// Step `idx`'s displayed start line, adjusted for net lines added/removed by
// earlier steps in the SAME file (so the gutter tracks the file as edits are
// applied top-to-bottom).
function adjustedStartLine(steps: CodeEditStep[], idx: number): number | undefined {
  const file = steps[idx]?.file || '';
  let shift = 0;
  for (let j = 0; j < idx; j++) {
    if ((steps[j]?.file || '') === file) shift += lineCount(steps[j]?.code ?? '') - lineCount(steps[j]?.oldCode ?? '');
  }
  const base = steps[idx]?.startLine;
  return base != null ? base + shift : undefined;
}

// Guided-apply: walk the steps one at a time, verifying each with a screenshot
// before advancing. Opt-in (the "Guide me" button starts it).
function GuidedView({ steps, language }: { steps: CodeEditStep[]; language: CodingLanguage }): JSX.Element {
  const idx = useApp((s) => s.guidedIndex);
  const verify = useApp((s) => s.guidedVerify);
  const busy = useApp((s) => s.guidedBusy);
  const setBusy = useApp((s) => s.setGuidedBusy);
  const next = useApp((s) => s.guidedNext);
  const exit = useApp((s) => s.exitGuided);

  const total = steps.length;
  const step = steps[Math.min(idx, total - 1)];
  const last = idx >= total - 1;
  const v = verify && verify.index === idx ? verify : null;
  const shownLine = adjustedStartLine(steps, idx);
  if (!step) return <></>;

  const check = async (): Promise<void> => {
    setBusy(true);
    await window.api.coding.verifyStep({ index: idx, total, file: step.file, instruction: step.instruction, code: step.code ?? '' });
  };

  return (
    <div className="coding__guided">
      <div className="coding__guided__head">
        <span className="coding__guided__progress">Step {idx + 1}/{total}</span>
        {step.file && <span className="coding__stepfile">{step.file}{shownLine != null ? `:${shownLine}` : ''}</span>}
        <button className="coding__guided__exit" onClick={() => exit()}>Exit guide</button>
      </div>
      <div className="coding__steptitle">{step.instruction}</div>
      {step.explanation && <div className="coding__stepwhy" style={{ marginLeft: 0 }}>{step.explanation}</div>}
      {(step.code || step.oldCode) && (
        <div className="coding__stepcode" style={{ marginLeft: 0 }}>
          <DiffView original={step.oldCode ?? ''} modified={step.code ?? ''} language={language} split={false} startLine={shownLine} header={false} />
        </div>
      )}
      {v && (
        <div className={`coding__verify coding__verify--${v.ok ? 'ok' : 'fix'}`}>
          {v.ok ? '✓ ' : '✗ '}{v.message}
        </div>
      )}
      <div className="coding__guided__actions">
        {!v || !v.ok ? (
          <button className="coding__banner__btn" disabled={busy} onClick={() => void check()}>
            {busy ? 'Checking…' : v ? 'Re-check ✓' : 'I did it — check ✓'}
          </button>
        ) : last ? (
          <button className="coding__banner__btn" onClick={() => exit()}>Done ✓</button>
        ) : (
          <button className="coding__banner__btn" onClick={() => next()}>Next step →</button>
        )}
        {(!v || !v.ok) && !last && (
          <button className="coding__banner__btn coding__banner__btn--ghost" onClick={() => next()} title="Skip the check and move on">Skip →</button>
        )}
        <span className="coding__guided__hint">the capture hotkey also checks / advances — hands-free from your editor</span>
      </div>
    </div>
  );
}

function StepsView({ steps, language }: { steps: CodeEditStep[]; language: CodingLanguage }): JSX.Element {
  // start_line on each step is for the ORIGINAL file. As the candidate applies
  // earlier steps the file grows/shrinks, so the gutter numbers drift. Adjust
  // each step's displayed start line by the net lines added/removed by prior
  // steps in the SAME file (steps are ordered top-to-bottom per file).
  const shift: Record<string, number> = {};
  return (
    <ol className="coding__steps">
      {steps.map((s, i) => {
        const hasDiff = (s.oldCode ?? '').length > 0 || (s.code ?? '').length > 0;
        const file = s.file || '';
        const shownLine = s.startLine != null ? s.startLine + (shift[file] ?? 0) : undefined;
        if (hasDiff) {
          shift[file] = (shift[file] ?? 0) + (lineCount(s.code ?? '') - lineCount(s.oldCode ?? ''));
        }
        return (
          <li key={i} className="coding__stepitem">
            <div className="coding__stephead">
              <span className="coding__stepnum">{i + 1}</span>
              {s.file && <span className="coding__stepfile">{s.file}{shownLine != null ? `:${shownLine}` : ''}</span>}
              <span className="coding__steptitle">{s.instruction}</span>
              {s.code && (
                <button
                  className="coding__stepcopy"
                  onClick={() => navigator.clipboard.writeText(s.code ?? '')}
                  title="Copy new code"
                >Copy</button>
              )}
            </div>
            {s.explanation && <div className="coding__stepwhy">{s.explanation}</div>}
            {hasDiff && (
              <div className="coding__stepcode">
                {/* Inline +/- diff. old_code/code include unchanged context lines
                    on both sides, so the candidate locates the change by matching
                    surrounding code; gutter starts at the drift-adjusted line. */}
                <DiffView original={s.oldCode ?? ''} modified={s.code ?? ''} language={language} split={false} startLine={shownLine} header={false} />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function DiffView({ original, modified, language, split = true, startLine, header = true }: {
  original: string; modified: string; language: CodingLanguage;
  split?: boolean;      // split (full diff) vs inline +/- (per-step)
  startLine?: number;   // gutter line numbers start here (so they match the file)
  header?: boolean;     // show the "Before → After" + Copy bar
}): JSX.Element {
  const theme = useApp((s) => s.theme);
  const linesOffset = startLine && startLine > 1 ? startLine - 1 : 0;
  return (
    <div className="coding__diff">
      {header && (
        <div className="coding__diffhead">
          <span>Before&nbsp;→&nbsp;After</span>
          <button
            className="coding__diffcopy"
            onClick={() => { if (modified) navigator.clipboard.writeText(modified); }}
            title="Copy modified code"
          >Copy</button>
        </div>
      )}
      <div className="coding__diffbody">
        <ReactDiffViewer
          oldValue={original}
          newValue={modified}
          splitView={split}
          linesOffset={linesOffset}
          disableWorker
          showDiffOnly={false}
          hideSummary
          compareMethod={DiffMethod.WORDS}
          useDarkTheme={theme === 'dark'}
          styles={DIFF_STYLES}
          renderContent={(source) => <span dangerouslySetInnerHTML={{ __html: highlightCode(source, language) }} />}
        />
      </div>
    </div>
  );
}

function stepLabel(step: CodingStep): string {
  switch (step.kind) {
    case 'capture': return `📸 Captured screenshot ${step.n || ''}`.trim();
    case 'thinking': return '🔍 thinking…';
    case 'instruction': return `⬇ ${step.text}`;
    case 'question': return `❓ ${step.text}`;
    case 'suggest_language': return `💡 Suggests ${LANG_LABEL[step.language]} — ${step.reason}`;
    case 'solution': return '✅ Solution ready';
    case 'review': return '✅ Review ready';
    case 'error': return `⚠ ${step.message}`;
    case 'done': return '✓ done';
    default: return '';
  }
}
