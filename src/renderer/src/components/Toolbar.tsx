import { useApp } from '../state/store.js';
import { languageShortLabel, nextLanguage } from '../../../shared/language';

interface Props {
  onSetup: () => void;
  onToggleBrowser: () => void;
  onToggleCc: () => void;
  onClearTranscript: () => void;
  showingBrowser: boolean;
}

export function Toolbar({ onSetup, onToggleBrowser, onToggleCc, onClearTranscript, showingBrowser }: Props): JSX.Element {
  const language = useApp((s) => s.language);
  const setLanguage = useApp((s) => s.setLanguage);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const privacy = useApp((s) => s.privacy);
  const setPrivacy = useApp((s) => s.setPrivacy);
  const topMost = useApp((s) => s.topMost);
  const setTopMost = useApp((s) => s.setTopMost);
  const opacity = useApp((s) => s.opacity);
  const setOpacity = useApp((s) => s.setOpacity);
  const answersEnabled = useApp((s) => s.answersEnabled);
  const setAnswersEnabled = useApp((s) => s.setAnswersEnabled);
  const ccActive = useApp((s) => s.ccActive);
  const ccBusy = useApp((s) => s.ccBusy);
  const status = useApp((s) => s.status);

  const togglePrivacy = async () => {
    const next = !privacy;
    if (privacy && !confirm('Disable screen-capture protection?')) return;
    await window.api.window.setPrivacy(next);
    setPrivacy(next);
  };

  const toggleTopMost = async () => {
    const next = !topMost;
    await window.api.window.setTopMost(next);
    setTopMost(next);
  };

  const toggleOpacity = async () => {
    const next = opacity >= 1 ? 0.5 : 1;
    const applied = await window.api.window.setOpacity(next);
    setOpacity(applied);
  };

  const toggleLanguage = async () => {
    const next = nextLanguage(language);
    setLanguage(next);
    await window.api.engine.setLanguage(next);
  };

  const toggleTheme = async () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next); // store action also sets data-theme + localStorage
    // Persist to settings.json so the choice survives a fresh install /
    // localStorage wipe. We don't await — it's fire-and-forget; the
    // visual change has already happened.
    void window.api.settings.set({ theme: next });
  };

  const toggleAnswers = async () => {
    const next = !answersEnabled;
    setAnswersEnabled(next);
    await window.api.engine.toggleAnswers(next);
  };

  return (
    <div className="toolbar">
      <button className="toolbar__btn toolbar__btn--primary" onClick={onSetup}>Setup</button>
      <button className={`toolbar__btn${showingBrowser ? ' toolbar__btn--active' : ''}`} onClick={onToggleBrowser}>
        {showingBrowser ? '◀ Back' : 'Browser'}
      </button>
      <button
        className={`toolbar__btn${ccActive ? ' toolbar__btn--cc-active' : ''}`}
        disabled={ccBusy}
        onClick={onToggleCc}
      >
        {ccActive ? 'CC*' : 'CC'}
      </button>
      <button className="toolbar__btn toolbar__btn--ghost" onClick={onClearTranscript}>Clear</button>
      <button
        className="toolbar__btn toolbar__btn--ghost"
        onClick={toggleLanguage}
        title="Cycle interview language (takes effect next CC start)"
      >
        {languageShortLabel(language)}
      </button>
      <button
        className="toolbar__btn toolbar__btn--ghost"
        onClick={toggleTheme}
        title="Toggle dark/light theme"
      >
        {theme === 'dark' ? 'Dark' : 'Light'}
      </button>

      <div className={`toolbar__status toolbar__status--${status.level}`}>{status.message}</div>

      <label className="toolbar__check">
        <input type="checkbox" checked={answersEnabled} onChange={toggleAnswers} /> Answers
      </label>
      <button
        className="toolbar__btn toolbar__btn--ghost"
        onClick={toggleTopMost}
        // The whole point of the shortcut: if you click "Unpin" you can't
        // find the window again through normal switching. The title is the
        // first place a user looks when something disappears.
        title={topMost ? 'Unpin (Ctrl+\\ to repin and summon)' : 'Pin (Ctrl+\\ also works)'}
      >
        {topMost ? 'Unpin' : 'Pin'}
      </button>
      <button className="toolbar__btn toolbar__btn--ghost" onClick={toggleOpacity}>
        {opacity >= 1 ? '100%' : '50%'}
      </button>
      <button
        className={`toolbar__btn ${privacy ? 'toolbar__btn--privacy-on' : 'toolbar__btn--privacy-off'}`}
        onClick={togglePrivacy}
      >
        {privacy ? 'Priv ON' : 'Priv OFF'}
      </button>
    </div>
  );
}
