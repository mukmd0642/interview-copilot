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
import { prettyLabel } from '../lib/shortcut-capture.js';
import {
  DEFAULT_PIN_SHORTCUT,
  DEFAULT_PRIVACY_SHORTCUT,
  type SystemAudioMode,
  type AnswerStyle,
} from '../../../shared/ipc';

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

  // Sticky flag: once the user opens the browser even once, keep the
  // BrowserView mounted for the rest of the session so subsequent
  // toggles just flip CSS visibility instead of recreating webviews.
  const [browserMounted, setBrowserMounted] = useState(false);
  useEffect(() => {
    if (showBrowser && !browserMounted) setBrowserMounted(true);
  }, [showBrowser, browserMounted]);

  const [setupOpen, setSetupOpen] = useState(false);
  const [setupValues, setSetupValues] = useState<{
    jd: string;
    resume: string;
    systemAudio: SystemAudioMode;
    answerStyle: AnswerStyle;
    pinShortcut: string;
    privacyShortcut: string;
  }>({
    jd: '',
    resume: '',
    // Will be replaced once settings load. 'off' is safe as a sentinel
    // because it means "don't try to open anything" — we never start CC
    // before settings.get() resolves.
    systemAudio: { kind: 'off' },
    answerStyle: 'informal',
    pinShortcut: DEFAULT_PIN_SHORTCUT,
    privacyShortcut: DEFAULT_PRIVACY_SHORTCUT,
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
        answerStyle: s.answerStyle,
        pinShortcut: s.pinShortcut,
        privacyShortcut: s.privacyShortcut,
      });
      // Seed the store so Toolbar tooltips + pin/unpin status messages can
      // reference the actual configured chord rather than the hardcoded
      // "Ctrl+\" placeholder.
      useApp.getState().setShortcuts(s.pinShortcut, s.privacyShortcut);
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
      const pin = prettyLabel(useApp.getState().pinShortcut);
      applyStatus({
        message: enabled
          ? `Pinned (${pin} to unpin)`
          : `Unpinned (${pin} to pin and bring back)`,
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

    // Mic silence = candidate paused. If a new answer has been buffered
    // (e.g. interviewer asked a follow-up while the candidate was still
    // reading the previous suggestion), flush it now — the candidate is
    // ready for the next thing without having to look up and click.
    // Pulling state via getState() inside the handler avoids stale-closure
    // hazards; otherwise the subscription would lock in pendingReady from
    // the moment of mount.
    const offMicSilence = window.api.onMicSilence(() => {
      const st = useApp.getState();
      if (st.pendingReady) {
        window.api.log('cc', 'mic silence → auto-flushing pending answer');
        st.flushPendingAnswer();
      }
    });

    return () => {
      mounted = false;
      offTopMost();
      offPrivacy();
      offTranscript();
      offAnswer();
      offSummary();
      offStatus();
      offMicSilence();
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
    systemAudio: SystemAudioMode,
    answerStyle: AnswerStyle,
    pinShortcut: string,
    privacyShortcut: string
  ): Promise<void> => {
    setSetupValues({ jd, resume, systemAudio, answerStyle, pinShortcut, privacyShortcut });
    // setContext persists JD+resume to the engine immediately; we also
    // persist the audio source choice independently. answerStyle goes
    // through its own setStyle so the engine picks it up mid-session
    // without restarting the realtime websockets.
    await window.api.engine.setContext({ jobDescription: jd, resume });
    await window.api.engine.setStyle(answerStyle);
    await window.api.settings.set({ systemAudio });
    // Only re-register hotkeys when they actually changed — globalShortcut
    // unregisterAll/register is cheap but logs noisily, so skipping the
    // no-op keeps app.log readable.
    let hotkeyMsg = '';
    if (
      pinShortcut !== setupValues.pinShortcut ||
      privacyShortcut !== setupValues.privacyShortcut
    ) {
      const result = await window.api.window.setShortcuts(pinShortcut, privacyShortcut);
      useApp.getState().setShortcuts(pinShortcut, privacyShortcut);
      if (!result.pinOk || !result.privacyOk) {
        const failures: string[] = [];
        if (!result.pinOk) failures.push('Pin');
        if (!result.privacyOk) failures.push('Privacy');
        hotkeyMsg = `  ·  Hotkey rejected (${failures.join(', ')}) — already in use by another app`;
      }
    }
    applyStatus({
      message: !jd && !resume
        ? `No context set  ·  Click CC to start${hotkeyMsg}`
        : `Job context updated  ·  ${answerStyle === 'formal' ? 'Formal' : 'Informal'} style  ·  Click CC to start${hotkeyMsg}`,
      level: hotkeyMsg ? 'warn' : 'info',
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

      {/*
        Render BOTH panes once the browser has ever been opened, then
        toggle visibility with display:none. Unmounting BrowserView would
        destroy the <webview> Chromium processes, costing a fresh page
        load + tab state every time the user switches back — that's both
        "browser feels heavy" and "tabs are gone." Keeping it mounted
        means the cost is paid once and switches become instant.

        We still lazy-mount until first open so users who never touch the
        browser don't spawn any Chromium renderers at startup.
      */}
      <div className="interview" style={{ display: showBrowser ? 'none' : undefined }}>
        <div className="interview__left">
          <CaptionPanel source="system" label="INTERVIEWER" toneClass="them" />
          <CaptionPanel source="mic" label="YOU" toneClass="you" />
        </div>
        <div className="interview__right">
          <AnswerPanel />
          <SummaryPanel />
        </div>
      </div>
      {browserMounted && (
        <div className="browser-host" style={{ display: showBrowser ? undefined : 'none' }}>
          <BrowserView />
        </div>
      )}

      <SetupDialog
        open={setupOpen}
        initialJd={setupValues.jd}
        initialResume={setupValues.resume}
        initialSystemAudio={setupValues.systemAudio}
        initialAnswerStyle={setupValues.answerStyle}
        initialPinShortcut={setupValues.pinShortcut}
        initialPrivacyShortcut={setupValues.privacyShortcut}
        onClose={() => setSetupOpen(false)}
        onSave={handleSetupSave}
      />
      <HistoryDialog />
    </div>
  );
}
