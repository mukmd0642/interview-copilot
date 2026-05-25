import { useApp } from '../state/store.js';

interface Props {
  source: 'mic' | 'system';
  label: string;
  toneClass: 'them' | 'you';
  maxLines?: number;
}

export function CaptionPanel({ source, label, toneClass, maxLines = 6 }: Props): JSX.Element {
  const entries = useApp((s) => s.entries);
  const live = useApp((s) => (source === 'mic' ? s.liveMic : s.liveSystem));

  const recent = entries.filter((e) => e.source === source).slice(-maxLines);

  return (
    <div className="panel">
      <div className={`panel__header panel__header--${toneClass}`}>{label}</div>
      <div className="panel__body">
        {recent.map((line, i) => (
          <div key={`${line.at}-${i}`}>{line.text}</div>
        ))}
        {live.trim() && (
          <div className="panel__body--live">{live.trim()}</div>
        )}
      </div>
    </div>
  );
}
