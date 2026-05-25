import { useApp } from '../state/store.js';

export function SummaryPanel(): JSX.Element {
  const summary = useApp((s) => s.summary);
  return (
    <div className="panel">
      <div className="panel__header panel__header--summary">KEY POINTS</div>
      <div className="panel__body panel__body--summary">{summary}</div>
    </div>
  );
}
