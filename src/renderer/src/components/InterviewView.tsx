import { useEffect, useState, useRef, useCallback } from 'react';
import { useApp } from '../state/store.js';
import { Toolbar } from './Toolbar.js';
import { CaptionPanel } from './CaptionPanel.js';
import { AnswerPanel } from './AnswerPanel.js';
import { SummaryPanel } from './SummaryPanel.js';
import { SetupDialog } from './SetupDialog.js';
import { BrowserView } from './BrowserView.js';
import { HistoryDialog } from './HistoryDialog.js';
import { startCapture } from '../lib/audio-capture.js';
import type { SystemAudioMode } from '../../../shared/ipc';

export function InterviewView(): JSX.Element {
  const setLanguage = useApp((s) => s.setLanguage);
  const applyFastDelta = useApp((s) => s.applyFastDelta);
  const applyFastFinal = useApp((s) => s.applyFastFinal);
  const applyAccurateFinal = useApp((s) => s.applyAccurateFinal);
  const applyAnswerChunk = useApp((s) => s.applyAnswerChunk);
  const applySummary = useApp((s) => s.applySummary);
  const applyStatus = useApp((s) => s.applyStatus);
  const resetSessionUi = useApp((s) => s.resetSessionUi);
  const setCcActive = useApp((s) => s.setCcActive);
  const setCcBusy = useApp((s) => s.setCcBusy);
  const ccActive = useApp((s) => s.ccActive);
  const language = useApp((s) => s.language);

  // Browser visibility now lives in the Zustand store so the keyboard
  // hook (Ctrl+T, Ctrl+Shift+B) can toggle it from anywhere.
  const showBrowser = useApp((s) => s.browserVisible);
  const toggleBrowser = useApp((s) => s.toggleBrowser);

  const [setupOpen, setSetupOpen] = useState(false);
  const [setupValues, setSetupValues] = useState<{
    jd: string;
    resume: string;
    systemAudio: SystemAudioMode;
  }>({
    jd: '',
    resume: '',
    // Will be replaced once settings load. 'off' is safe as a sentinel
    // because it means "don't try to open anything" — we never start CC
    // before settings.get() resolves.
    systemAudio: { kind: 'off' },
  });

  // Capture handle held in a ref so the cleanup effect can reach it
  // without re-subscribing every render.
  const captureRef = useRef<{ stop: () => Promise<void> } | null>(null);

  // ── On mount: load settings, subscribe to IPC events ────────────────────
  useEffect(() => {
    let mounted = true;

    void window.api.settings.get().then((s) => {
      if (!mounted) return;
      setLanguage(s.language);
      // Reconcile theme: if settings.json disagrees with what main.tsx
      // already applied from localStorage, settings wins (it's the durable
      // record). setTheme also updates data-theme + localStorage, so all
      // three sources end up in agreement.
      const currentTheme = useApp.getState().theme;
      if (s.theme !== currentTheme) {
        useApp.getState().setTheme(s.theme);
      }
      setSetupValues({
        jd: s.jobDescription,
        resume: s.resume,
        systemAudio: s.systemAudio,
      });
      applyStatus({
        message: !s.jobDescription && !s.resume
          ? 'Click Setup to enter job details & resume, then CC to start'
          : 'Job context loaded  ·  Click CC to start',
        level: 'info',
      });
    });

    // Window state pushed from the main process (e.g. via global hotkey).
    // Without these subscriptions the toolbar button shows the wrong state
    // after a hotkey press, which would be very confusing.
    const offTopMost = window.api.onTopMost((enabled) => {
      useApp.getState().setTopMost(enabled);
      applyStatus({
        message: enabled
          ? 'Pinned (Ctrl+\\ to unpin)'
          : 'Unpinned (Ctrl+\\ to pin and bring back)',
        level: 'info',
      });
    });
    const offPrivacy = window.api.onPrivacy((enabled) => {
      useApp.getState().setPrivacy(enabled);
    });

    const offTranscript = window.api.onTranscript((evt) => {
      // Fast pipeline → live preview; accurate → canonical transcript.
      if (evt.pipeline === 'fast') {
        const key = `${evt.itemId}:${evt.contentIndex}`;
        if (evt.isFinal) applyFastFinal(evt.source, key, evt.text);
        else if (evt.text) applyFastDelta(evt.source, key, evt.text);
      } else {
        if (evt.isFinal && evt.text.trim()) applyAccurateFinal(evt.source, evt.text);
      }
    });

    const offAnswer = window.api.onAnswer((chunk) => applyAnswerChunk(chunk));
    const offSummary = window.api.onSummary((text) => applySummary(text));
    const offStatus = window.api.onStatus((s) => applyStatus(s));

    return () => {
      mounted = false;
      offTopMost();
      offPrivacy();
      offTranscript();
      offAnswer();
      offSummary();
      offStatus();
    };
  }, [setLanguage, applyFastDelta, applyFastFinal, applyAccurateFinal, applyAnswerChunk, applySummary, applyStatus]);

  // ── CC start / stop ─────────────────────────────────────────────────────
  const startCc = useCallback(async () => {
    setCcBusy(true);
    resetSessionUi();
    applyStatus({ message: 'Connecting…', level: 'info' });
    window.api.log('cc', `startCc: systemAudio.kind=${setupValues.systemAudio.kind}`);
    try {
      // Spin up the audio capture in the renderer first — only after we
      // know the streams are alive do we tell the main process to start
      // the realtime websockets.
      const handle = await startCapture({
        systemAudio: setupValues.systemAudio,
        onError: (source, message) => {
          window.api.log('cc', `capture onError [${source}]: ${message}`);
          applyStatus({
            message: `Could not start ${source === 'mic' ? 'microphone' : 'interviewer audio'}: ${message}`,
            level: 'warn',
          });
        },
        onWarn: (_source, message) => {
          applyStatus({ message, level: 'warn' });
        },
      });
      captureRef.current = handle;
      window.api.log('cc', 'startCapture returned ok; calling transcript.start');

      const result = await window.api.transcript.start(language);
      window.api.log('cc', `transcript.start result: ${JSON.stringify(result)}`);
      if (!result.ok) {
        applyStatus({ message: result.message ?? 'Failed to start transcription.', level: 'error' });
        await handle.stop();
        captureRef.current = null;
        setCcActive(false);
        return;
      }
      setCcActive(true);
    } catch (err) {
      const e = err as Error;
      window.api.log('cc', `startCc THREW ${e.name}: ${e.message}`);
      applyStatus({ message: `Start failed: ${e.message}`, level: 'error' });
      setCcActive(false);
    } finally {
      setCcBusy(false);
    }
  }, [language, applyStatus, resetSessionUi, setCcActive, setCcBusy, setupValues.systemAudio]);

  const stopCc = useCallback(async () => {
    setCcBusy(true);
    try {
      await window.api.transcript.stop();
      const handle = captureRef.current;
      captureRef.current = null;
      if (handle) await handle.stop();
      setCcActive(false);
      applyStatus({ message: 'Stopped.', level: 'info' });
    } catch (err) {
      applyStatus({ message: `Stop failed: ${(err as Error).message}`, level: 'error' });
    } finally {
      setCcBusy(false);
    }
  }, [applyStatus, setCcActive, setCcBusy]);

  // Stop capture on unmount (e.g. window close path).
  useEffect(() => {
    return () => {
      const handle = captureRef.current;
      captureRef.current = null;
      if (handle) void handle.stop();
    };
  }, []);

  const handleToggleCc = (): void => {
    if (ccActive) void stopCc();
    else void startCc();
  };

  const handleSetupSave = async (
    jd: string,
    resume: string,
    systemAudio: SystemAudioMode
  ): Promise<void> => {
    setSetupValues({ jd, resume, systemAudio });
    // setContext persists JD+resume; we also need to persist the audio
    // source choice independently so it survives restarts even if the
    // user never touches Setup again.
    await window.api.engine.setContext({ jobDescription: jd, resume });
    await window.api.settings.set({ systemAudio });
    applyStatus({
      message: !jd && !resume
        ? 'No context set  ·  Click CC to start'
        : 'Job context updated  ·  Click CC to start',
      level: 'info',
    });
  };

  return (
    <div className="app-shell">
      <Toolbar
        onSetup={() => setSetupOpen(true)}
        onToggleBrowser={() => toggleBrowser()}
        onToggleCc={handleToggleCc}
        onClearTranscript={() => resetSessionUi()}
        showingBrowser={showBrowser}
      />

      {showBrowser ? (
        <BrowserView />
      ) : (
        <div className="interview">
          <div className="interview__left">
            <CaptionPanel source="system" label="INTERVIEWER" toneClass="them" />
            <CaptionPanel source="mic" label="YOU" toneClass="you" />
          </div>
          <div className="interview__right">
            <AnswerPanel />
            <SummaryPanel />
          </div>
        </div>
      )}

      <SetupDialog
        open={setupOpen}
        initialJd={setupValues.jd}
        initialResume={setupValues.resume}
        initialSystemAudio={setupValues.systemAudio}
        onClose={() => setSetupOpen(false)}
        onSave={handleSetupSave}
      />
      <HistoryDialog />
    </div>
  );
}
