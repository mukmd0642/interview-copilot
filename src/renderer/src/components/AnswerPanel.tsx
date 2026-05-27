import { useApp } from '../state/store.js';

export function AnswerPanel(): JSX.Element {
  const answersEnabled = useApp((s) => s.answersEnabled);
  const answerBox = useApp((s) => s.answerBox);
  const streaming = useApp((s) => s.answerStreaming);
  const pendingReady = useApp((s) => s.pendingReady);
  const pendingAnswer = useApp((s) => s.pendingAnswer);
  const flushPending = useApp((s) => s.flushPendingAnswer);

  // Coarse but useful: line-count of the buffered answer so the candidate
  // can decide whether it's worth interrupting their current read. Falls
  // back to character count if the buffered answer has no line breaks.
  const pendingLines = pendingAnswer.length === 0
    ? 0
    : pendingAnswer.split('\n').filter((l) => l.trim().length > 0).length;

  const headerText = !answersEnabled
    ? 'SUGGESTED ANSWER  ·  disabled'
    : streaming
      ? 'SUGGESTED ANSWER  (generating…)'
      : pendingReady
        ? `SUGGESTED ANSWER  ·  ${pendingLines || '~'} new line${pendingLines === 1 ? '' : 's'} ready`
        : 'SUGGESTED ANSWER';

  // Header class swaps to a pulsing accent when a new answer is buffered.
  // Designed to be noticeable in peripheral vision while reading the
  // current answer aloud — without being so loud that it pulls focus.
  const headerCls = pendingReady
    ? 'panel__header panel__header--answer panel__header--pending'
    : 'panel__header panel__header--answer';

  return (
    <div className="panel">
      <div className={headerCls}>
        <span className="panel__header__title">{headerText}</span>
        {pendingReady && (
          <button
            className="panel__header__btn panel__header__btn--pending"
            onClick={flushPending}
            title="Show the new answer (Space when not typing also flushes; mic silence auto-flushes)"
          >
            Next ▼
          </button>
        )}
        <button
          className="panel__header__btn"
          onClick={() => {
            if (answerBox) navigator.clipboard.writeText(answerBox);
          }}
          title="Copy current answer (Ctrl+Shift+C)"
        >
          Copy
        </button>
      </div>
      <div className="panel__body panel__body--answer">{answerBox}</div>
    </div>
  );
}
