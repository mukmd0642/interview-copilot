import { useState } from 'react';
import { useApp } from '../state/store.js';
import { prettyLabel } from '../lib/shortcut-capture.js';
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
  const ccActive = useApp((s) => s.ccActive);
  const ccBusy = useApp((s) => s.ccBusy);
  const layoutMode = useApp((s) => s.layoutMode);
  const setLayoutMode = useApp((s) => s.setLayoutMode);
  const appMode = useApp((s) => s.appMode);
  const setAppMode = useApp((s) => s.setAppMode);
  const pinShortcut = useApp((s) => s.pinShortcut);
  const pinLabel = prettyLabel(pinShortcut);

  const [overflowOpen, setOverflowOpen] = useState(false);
  const compact = layoutMode === 'compact';

  const togglePrivacy = async () => {
    const next = !privacy;
    if (privacy && !confirm('Turn stealth OFF? The window will become visible to screen capture / screen-share.')) return;
    await window.api.window.setPrivacy(next);
    setPrivacy(next);
  };
  const toggleTopMost = async () => {
    const next = !topMost;
    await window.api.window.setTopMost(next);
    setTopMost(next);
  };
  const toggleLanguage = async () => {
    const next = nextLanguage(language);
    setLanguage(next);
    await window.api.engine.setLanguage(next);
  };
  const toggleTheme = async () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    void window.api.settings.set({ theme: next });
  };
  const toggleLayout = async () => {
    const next = layoutMode === 'compact' ? 'full' : 'compact';
    setLayoutMode(next);
    await window.api.window.setLayout(next);
  };
  // Fluid opacity — fires on every slider tick. setOpacity is a cheap native
  // call (win.setOpacity) so there's no need to debounce.
  const onOpacityInput = async (value: number) => {
    const applied = await window.api.window.setOpacity(value);
    setOpacity(applied);
  };

  const runAndClose = (fn: () => void | Promise<void>) => () => {
    void fn();
    setOverflowOpen(false);
  };

  const opacityPct = Math.round(opacity * 100);

  // The opacity control: a labelled slider. Rendered inline in full mode and
  // as a menu row in compact's overflow.
  const opacitySlider = (menu: boolean) => (
    <div className={menu ? 'toolbar__menuitem toolbar__opacity' : 'toolbar__opacity'} title="Window opacity">
      {menu && <span className="toolbar__opacity__label">Opacity</span>}
      <input
        type="range"
        min={20}
        max={100}
        step={1}
        value={opacityPct}
        onChange={(e) => void onOpacityInput(Number(e.target.value) / 100)}
        className="toolbar__slider"
        aria-label="Window opacity"
      />
      <span className="toolbar__opacity__val">{opacityPct}%</span>
    </div>
  );

  // Secondary controls that fold into the ⋯ overflow in compact mode.
  const secondary = (menu: boolean) => {
    const cls = menu ? 'toolbar__menuitem' : 'toolbar__btn toolbar__btn--ghost';
    return (
      <>
        <button
          className={menu ? cls : `toolbar__btn${showingBrowser ? ' toolbar__btn--active' : ' toolbar__btn--ghost'}`}
          onClick={runAndClose(onToggleBrowser)}
        >
          {showingBrowser ? '◀ Back' : 'Browser'}
        </button>
        <button className={cls} onClick={runAndClose(onClearTranscript)}>Clear</button>
        <button className={cls} onClick={runAndClose(toggleLanguage)} title="Cycle interview language (next Start)">
          {menu ? `Language · ${languageShortLabel(language)}` : languageShortLabel(language)}
        </button>
        <button className={cls} onClick={runAndClose(toggleTheme)} title="Toggle dark/light theme">
          {menu ? `Theme · ${theme === 'dark' ? 'Dark' : 'Light'}` : theme === 'dark' ? 'Dark' : 'Light'}
        </button>
        <button
          className={cls}
          onClick={runAndClose(toggleTopMost)}
          title={topMost ? `Unpin (${pinLabel} to repin & summon)` : `Pin (${pinLabel} also works)`}
        >
          {menu ? (topMost ? 'Unpin window' : 'Pin on top') : topMost ? 'Unpin' : 'Pin'}
        </button>
        {opacitySlider(menu)}
      </>
    );
  };

  return (
    <div className="toolbar">
      {/* Interview ⇄ Code mode toggle */}
      <div className="toolbar__modeseg" role="tablist" aria-label="Mode">
        <button
          className={appMode === 'interview' ? 'on' : ''}
          onClick={() => setAppMode('interview')}
        >Interview</button>
        <button
          className={appMode === 'coding' ? 'on' : ''}
          onClick={() => setAppMode('coding')}
        >Code</button>
      </div>

      <button className="toolbar__btn toolbar__btn--primary" onClick={onSetup}>Setup</button>

      {/* Start (live captions) is interview-only. */}
      {appMode === 'interview' && (
        <button
          className={`toolbar__btn toolbar__btn--cc${ccActive ? ' toolbar__btn--cc-active' : ''}`}
          disabled={ccBusy}
          onClick={onToggleCc}
          title={ccActive ? 'Stop live captions' : 'Start live captions + answers'}
        >
          {ccActive ? '● Stop' : 'Start'}
        </button>
      )}

      {/* Full mode shows the secondary controls inline; compact folds them. */}
      {!compact && secondary(false)}

      <div className="toolbar__spacer" />

      {/* Always-reachable: layout + stealth. */}
      <button
        className="toolbar__btn toolbar__btn--ghost"
        onClick={toggleLayout}
        title={compact ? 'Switch to full multi-panel view (Ctrl+Shift+L)' : 'Switch to compact overlay (Ctrl+Shift+L)'}
      >
        {compact ? '⤢ Full' : '⤡ Compact'}
      </button>
      <button
        className={`toolbar__btn ${privacy ? 'toolbar__btn--stealth-on' : 'toolbar__btn--stealth-off'}`}
        onClick={togglePrivacy}
        title={privacy ? 'Stealth ON — hidden from screen capture / screen-share' : 'Stealth OFF — window is visible to capture'}
      >
        {privacy ? 'Stealth ON' : 'Stealth OFF'}
      </button>

      {compact && (
        <div className="toolbar__overflow">
          <button
            className="toolbar__btn toolbar__btn--ghost"
            onClick={() => setOverflowOpen((o) => !o)}
            title="More controls"
          >
            ⋯
          </button>
          {overflowOpen && (
            <>
              <div className="toolbar__backdrop" onClick={() => setOverflowOpen(false)} />
              <div className="toolbar__menu">{secondary(true)}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
