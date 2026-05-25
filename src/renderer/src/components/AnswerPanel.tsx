import { useApp } from '../state/store.js';

export function AnswerPanel(): JSX.Element {
  const answersEnabled = useApp((s) => s.answersEnabled);
  const answerBox = useApp((s) => s.answerBox);
  const streaming = useApp((s) => s.answerStreaming);
  const pendingReady = useApp((s) => s.pendingReady);
  const flushPending = useApp((s) => s.flushPendingAnswer);

  const headerText = !answersEnabled
    ? 'SUGGESTED ANSWER  ·  disabled'
    : streaming
      ? 'SUGGESTED ANSWER  (generating…)'
      : pendingReady
        ? 'SUGGESTED ANSWER  ·  [ Next ▼ ]'
        : 'SUGGESTED ANSWER';

  return (
    <div className="panel">
      <div className="panel__header panel__header--answer">
        <span className="panel__header__title">{headerText}</span>
        {pendingReady && (
          <button className="panel__header__btn" onClick={flushPending}>
            Next ▼
          </button>
        )}
        <button
          className="panel__header__btn"
          onClick={() => {
            if (answerBox) navigator.clipboard.writeText(answerBox);
          }}
        >
          Copy
        </button>
      </div>
      <div className="panel__body panel__body--answer">{answerBox}</div>
    </div>
  );
}
