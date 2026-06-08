import { useEffect, useState, useRef, useCallback } from 'react';
import { useApp } from '../state/store.js';
import { Toolbar } from './Toolbar.js';
import { CaptionPanel } from './CaptionPanel.js';
import { AnswerPanel } from './AnswerPanel.js';
import { SummaryPanel } from './SummaryPanel.js';
import { SetupDialog } from './SetupDialog.js';
import { BrowserView } from './BrowserView.js';
import { HistoryDialog } from './HistoryDialog.js';
import { CodingView } from './CodingView.js';
import { startCapture } from '../lib/audio-capture.js';
import { prettyLabel } from '../lib/shortcut-capture.js';
import {
  DEFAULT_PIN_SHORTCUT,
  DEFAULT_PRIVACY_SHORTCUT,
  DEFAULT_HIDE_SHORTCUT,
  DEFAULT_CODING_CAPTURE_SHORTCUT,
  type SystemAudioMode,
  type AnswerStyle,
  type AnswerLength,
} from '../../../shared/ipc';

export function InterviewView(): JSX.Element {
  const setLanguage = useApp((s) => s.setLanguage);
  const applyFastDelta = useApp((s) => s.applyFastDelta);
  const applyFastFinal = useApp((s) => s.applyFastFinal);
  const applyAccurateFinal = useApp((s) => s.applyAccurateFinal);
  const applyAnswerChunk = useApp((s) => s.applyAnswerChunk);
  const applySummary = useApp((s) => s.applySummary);
  const applyStatus = useApp((s) => s.applyStatus);
  const status = useApp((s) => s.status);
  const resetSessionUi = useApp((s) => s.resetSessionUi);
  const setCcActive = useApp((s) => s.setCcActive);
  const setCcBusy = useApp((s) => s.setCcBusy);
  const ccActive = useApp((s) => s.ccActive);
  const language = useApp((s) => s.language);

  // Browser visibility now lives in the Zustand store so the keyboard
  // hook (Ctrl+T, Ctrl+Shift+B) can toggle it from anywhere.
  const showBrowser = useApp((s) => s.browserVisible);
  const toggleBrowser = useApp((s) => s.toggleBrowser);
  const layoutMode = useApp((s) => s.layoutMode);
  const compactExtrasOpen = useApp((s) => s.compactExtrasOpen);
  const toggleCompactExtras = useApp((s) => s.toggleCompactExtras);
  const appMode = useApp((s) => s.appMode);

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
    answerLength: AnswerLength;
    pinShortcut: string;
    privacyShortcut: string;
    hideShortcut: string;
    codingCaptureShortcut: string;
  }>({
    jd: '',
    resume: '',
    // Will be replaced once settings load. 'off' is safe as a sentinel
    // because it means "don't try to open anything" — we never start CC
    // before settings.get() resolves.
    systemAudio: { kind: 'off' },
    answerStyle: 'informal',
    answerLength: 'standard',
    pinShortcut: DEFAULT_PIN_SHORTCUT,
    privacyShortcut: DEFAULT_PRIVACY_SHORTCUT,
    hideShortcut: DEFAULT_HIDE_SHORTCUT,
    codingCaptureShortcut: DEFAULT_CODING_CAPTURE_SHORTCUT,
  });

  // Capture handle held in a ref so the cleanup effect can reach it
  // without re-subscribing every render.
  const captureRef = useRef<{ stop: () => Promise<void> } | null>(null);
  // Separate capture handle for coding-mode interviewer listening.
  const codingAudioRef = useRef<{ stop: () => Promise<void> } | null>(null);

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
      // Sync the renderer's layout mode with what main restored the window
      // to. Main already sized the window from settings; here we just match
      // the render. We do NOT call window.setLayout — that would re-resize.
      useApp.getState().setLayoutMode(s.layoutMode);
      setSetupValues({
        jd: s.jobDescription,
        resume: s.resume,
        systemAudio: s.systemAudio,
        answerStyle: s.answerStyle,
        answerLength: s.answerLength,
        pinShortcut: s.pinShortcut,
        privacyShortcut: s.privacyShortcut,
        hideShortcut: s.hideShortcut,
        codingCaptureShortcut: s.codingCaptureShortcut,
      });
      // Seed the store so Toolbar tooltips + pin/unpin status messages can
      // reference the actual configured chord rather than the hardcoded
      // "Ctrl+\" placeholder.
      useApp.getState().setShortcuts(s.pinShortcut, s.privacyShortcut, s.hideShortcut);
      applyStatus({
        message: !s.jobDescription && !s.resume
          ? 'Click Setup to enter job details & resume, then Start'
          : 'Job context loaded  ·  Click Start',
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

    // Coding-agent subscriptions live HERE (the always-mounted shell), not in
    // CodingView — so a session started by the global capture hotkey from
    // interview mode isn't missed, and no early steps race the view mount.
    const offCodingStep = window.api.coding.onStep((step) => {
      useApp.getState().applyCodingStep(step);
    });
    const offCodingHotkey = window.api.coding.onCaptureHotkey(() => {
      const st = useApp.getState();
      // A language suggestion is on screen — the hotkey is the one-tap
      // "Switch & solve": adopt the proposed language and continue.
      if (st.codingPhase === 'suggest' && st.codingSuggestLanguage) {
        const lang = st.codingSuggestLanguage;
        st.setCodingLanguage(lang);
        void window.api.coding.resolveLanguage(true, lang);
        return;
      }
      // Guided-apply: the hotkey checks the current step, then advances once
      // it's verified — so the candidate drives the walkthrough without
      // leaving their editor.
      if (st.guidedActive) {
        const steps = st.codingSolution?.steps ?? [];
        const total = steps.length;
        const idx = st.guidedIndex;
        const v = st.guidedVerify;
        if (v && v.index === idx && v.ok) {
          if (idx >= total - 1) st.exitGuided();
          else st.guidedNext();
          return;
        }
        if (!st.guidedBusy) {
          const step = steps[idx];
          if (step) {
            st.setGuidedBusy(true);
            void window.api.coding.verifyStep({ index: idx, total, file: step.file, instruction: step.instruction, code: step.code ?? '' });
          }
        }
        return;
      }
      if (st.codingActive) {
        // Mid-session: feed the next screenshot. AFTER a solution this also
        // works — it re-opens the agent to refine with the added context
        // (e.g. the candidate captures the remaining levels of the problem).
        void window.api.coding.capture();
        return;
      }
      // No session: jump into coding mode and solve what's on screen now.
      // Goal is whatever's persisted/empty — "solve what's visible".
      if (st.appMode !== 'coding') st.setAppMode('coding');
      st.beginCodingSession();
      void window.api.coding
        .start({ goal: '', language: st.codingLanguage, effort: st.codingEffort, taskType: st.codingTaskType })
        .then((res) => {
          if (!res.ok) {
            useApp.getState().applyCodingStep({ kind: 'error', message: res.message ?? 'Failed to start' });
          }
        });
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
      offCodingStep();
      offCodingHotkey();
    };
  }, [setLanguage, applyFastDelta, applyFastFinal, applyAccurateFinal, applyAnswerChunk, applySummary, applyStatus]);

  // ── Code mode auto-listening ─────────────────────────────────────────────
  // Entering Code mode starts interviewer-audio capture + transcription so
  // the agent has spoken context (problem framing, rules, follow-ups).
  // Leaving Code mode tears it down. Mutually exclusive with interview CC —
  // the transcription pipeline is a singleton, so we stop CC first.
  useEffect(() => {
    let cancelled = false;
    if (appMode === 'coding') {
      void (async () => {
        // If interview CC was running, stop it — one transcription session
        // at a time.
        if (useApp.getState().ccActive) {
          try { await window.api.transcript.stop(); } catch { /* ignore */ }
          const h = captureRef.current; captureRef.current = null;
          if (h) await h.stop();
          setCcActive(false);
        }
        const res = await window.api.coding.startListening();
        if (!res.ok) {
          applyStatus({ message: `Interviewer audio off: ${res.message ?? 'unavailable'}`, level: 'warn' });
          return;
        }
        const handle = await startCapture({
          systemAudio: setupValues.systemAudio,
          // Code mode only listens to the interviewer — don't open the
          // candidate's mic (no transcription consumes it, and it would light
          // the OS mic-in-use indicator).
          captureMic: false,
          onError: (src, message) =>
            applyStatus({ message: `Could not start ${src === 'mic' ? 'mic' : 'interviewer audio'}: ${message}`, level: 'warn' }),
          onWarn: (_src, message) => applyStatus({ message, level: 'warn' }),
        });
        if (cancelled) { void handle.stop(); return; }
        codingAudioRef.current = handle;
      })();
    }
    return () => {
      cancelled = true;
      // On leaving coding mode, stop coding audio + listening.
      if (appMode === 'coding') {
        const h = codingAudioRef.current; codingAudioRef.current = null;
        if (h) void h.stop();
        void window.api.coding.stopListening();
      }
    };
  }, [appMode, setupValues.systemAudio, applyStatus, setCcActive]);

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
    answerLength: AnswerLength,
    pinShortcut: string,
    privacyShortcut: string,
    hideShortcut: string,
    codingCaptureShortcut: string
  ): Promise<void> => {
    setSetupValues({
      jd,
      resume,
      systemAudio,
      answerStyle,
      answerLength,
      pinShortcut,
      privacyShortcut,
      hideShortcut,
      codingCaptureShortcut,
    });
    // setContext persists JD+resume to the engine immediately; we also
    // persist the audio source choice independently. answerStyle goes
    // through its own setStyle so the engine picks it up mid-session
    // without restarting the realtime websockets.
    await window.api.engine.setContext({ jobDescription: jd, resume });
    await window.api.engine.setStyle(answerStyle);
    await window.api.engine.setLength(answerLength);
    await window.api.settings.set({ systemAudio });
    // Only re-register hotkeys when they actually changed — globalShortcut
    // unregisterAll/register is cheap but logs noisily, so skipping the
    // no-op keeps app.log readable.
    let hotkeyMsg = '';
    if (
      pinShortcut !== setupValues.pinShortcut ||
      privacyShortcut !== setupValues.privacyShortcut ||
      hideShortcut !== setupValues.hideShortcut ||
      codingCaptureShortcut !== setupValues.codingCaptureShortcut
    ) {
      const result = await window.api.window.setShortcuts(pinShortcut, privacyShortcut, hideShortcut, codingCaptureShortcut);
      useApp.getState().setShortcuts(pinShortcut, privacyShortcut, hideShortcut);
      if (!result.pinOk || !result.privacyOk || !result.hideOk || !result.codingOk) {
        const failures: string[] = [];
        if (!result.pinOk) failures.push('Pin');
        if (!result.privacyOk) failures.push('Stealth');
        if (!result.hideOk) failures.push('Hide');
        if (!result.codingOk) failures.push('Code capture');
        hotkeyMsg = `  ·  Hotkey rejected (${failures.join(', ')}) — already in use by another app`;
      }
    }
    applyStatus({
      message: !jd && !resume
        ? `No context set  ·  Click Start${hotkeyMsg}`
        : `Job context updated  ·  ${answerStyle === 'formal' ? 'Formal' : 'Informal'} style  ·  Click Start${hotkeyMsg}`,
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

      {/* Status on its own line — full text readable, and it frees the
          toolbar to fit more buttons. */}
      <div className={`statusbar statusbar--${status.level}`} title={status.message}>
        {status.message}
      </div>

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
      <div
        className={`interview interview--${layoutMode}`}
        style={{ display: showBrowser || appMode === 'coding' ? 'none' : undefined }}
      >
        {layoutMode === 'compact' ? (
          // Compact overlay: thin interviewer strip → big answer → a
          // collapsible drawer holding YOU + KEY POINTS. The answer is the
          // only thing that needs to be big; everything else is glance-and-
          // confirm context, so it's minimized.
          <>
            <CaptionPanel source="system" label="INTERVIEWER" toneClass="them" maxLines={2} />
            <AnswerPanel />
            <div className="compact-extras">
              <button
                className="compact-extras__toggle"
                onClick={() => toggleCompactExtras()}
                title="Show your transcript and key points"
              >
                {compactExtrasOpen ? '▾  You / Key points' : '▸  You / Key points'}
              </button>
              {compactExtrasOpen && (
                <div className="compact-extras__body">
                  <CaptionPanel source="mic" label="YOU" toneClass="you" maxLines={3} />
                  <SummaryPanel />
                </div>
              )}
            </div>
          </>
        ) : (
          // Full: narrow left column (THEM / YOU / KEY stacked, compact) and
          // a dominant answer on the right. For a second monitor / prep.
          <>
            <div className="interview__left">
              <CaptionPanel source="system" label="INTERVIEWER" toneClass="them" maxLines={4} />
              <CaptionPanel source="mic" label="YOU" toneClass="you" maxLines={3} />
              <SummaryPanel />
            </div>
            <div className="interview__right">
              <AnswerPanel />
            </div>
          </>
        )}
      </div>
      {appMode === 'coding' && !showBrowser && (
        <div className="coding-host">
          <CodingView />
        </div>
      )}

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
        initialAnswerLength={setupValues.answerLength}
        initialPinShortcut={setupValues.pinShortcut}
        initialPrivacyShortcut={setupValues.privacyShortcut}
        initialHideShortcut={setupValues.hideShortcut}
        initialCodingCaptureShortcut={setupValues.codingCaptureShortcut}
        onClose={() => setSetupOpen(false)}
        onSave={handleSetupSave}
      />
      <HistoryDialog />
    </div>
  );
}
