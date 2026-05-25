import { useApp } from '../state/store.js';

// Plain list of recently-visited URLs across all tabs. De-duped on push by
// the store, capped at 500 entries. Click to navigate the active tab.

export function HistoryDialog(): JSX.Element | null {
  const open = useApp((s) => s.historyOpen);
  const history = useApp((s) => s.history);
  const newTab = useApp((s) => s.newTab);
  const setOpen = useApp((s) => s.setHistoryOpen);

  if (!open) return null;

  // Show newest first.
  const items = [...history].reverse();

  const fmt = (ms: number): string => {
    const d = new Date(ms);
    return d.toLocaleString();
  };

  return (
    <div className="dlg-backdrop" onClick={() => setOpen(false)}>
      <div className="dlg" onClick={(e) => e.stopPropagation()} style={{ width: 720 }}>
        <div className="dlg__header">Browsing History</div>
        <div className="dlg__body" style={{ paddingTop: 0 }}>
          {items.length === 0 ? (
            <div className="dlg__hint">No history yet — open a tab and visit a few pages first.</div>
          ) : (
            <div className="history__list">
              {items.map((h, i) => (
                <button
                  key={`${h.url}-${h.at}-${i}`}
                  className="history__item"
                  onClick={() => {
                    // Open in a new tab and close the dialog; preserves
                    // whatever the user had loaded in the current tab.
                    newTab(h.url);
                    setOpen(false);
                  }}
                  title={h.url}
                >
                  <div className="history__item__title">
                    {h.title || h.url}
                  </div>
                  <div className="history__item__url">{h.url}</div>
                  <div className="history__item__time">{fmt(h.at)}</div>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="dlg__bar">
          <button className="dlg__btn" onClick={() => setOpen(false)}>Close</button>
        </div>
      </div>
    </div>
  );
}
