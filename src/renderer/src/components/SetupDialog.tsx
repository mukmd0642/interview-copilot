import { useState, useEffect } from 'react';
import { listAudioInputs, type AudioInputDevice } from '../lib/audio-devices.js';
import { captureShortcut, prettyLabel } from '../lib/shortcut-capture.js';
import {
  DEFAULT_PIN_SHORTCUT,
  DEFAULT_PRIVACY_SHORTCUT,
  type SystemAudioMode,
  type AnswerStyle,
} from '../../../shared/ipc';

interface Props {
  initialJd: string;
  initialResume: string;
  initialSystemAudio: SystemAudioMode;
  initialAnswerStyle: AnswerStyle;
  initialPinShortcut: string;
  initialPrivacyShortcut: string;
  open: boolean;
  onClose: () => void;
  onSave: (
    jd: string,
    resume: string,
    systemAudio: SystemAudioMode,
    answerStyle: AnswerStyle,
    pinShortcut: string,
    privacyShortcut: string
  ) => void;
}

const isMac = navigator.platform.toLowerCase().includes('mac');

export function SetupDialog({
  initialJd,
  initialResume,
  initialSystemAudio,
  initialAnswerStyle,
  initialPinShortcut,
  initialPrivacyShortcut,
  open,
  onClose,
  onSave,
}: Props): JSX.Element | null {
  const [jd, setJd] = useState(initialJd);
  const [resume, setResume] = useState(initialResume);
  const [audio, setAudio] = useState<SystemAudioMode>(initialSystemAudio);
  const [style, setStyle] = useState<AnswerStyle>(initialAnswerStyle);
  const [pinAccel, setPinAccel] = useState(initialPinShortcut);
  const [privacyAccel, setPrivacyAccel] = useState(initialPrivacyShortcut);
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);

  useEffect(() => {
    if (open) {
      setJd(initialJd);
      setResume(initialResume);
      setAudio(initialSystemAudio);
      setStyle(initialAnswerStyle);
      setPinAccel(initialPinShortcut);
      setPrivacyAccel(initialPrivacyShortcut);
    }
  }, [
    open,
    initialJd,
    initialResume,
    initialSystemAudio,
    initialAnswerStyle,
    initialPinShortcut,
    initialPrivacyShortcut,
  ]);

  // Refresh device list whenever the dialog opens. Browsers also fire a
  // `devicechange` event we could subscribe to, but a refresh on open
  // covers the "I just plugged in BlackHole and clicked Setup" path
  // without extra wiring.
  useEffect(() => {
    if (!open) return;
    setLoadingDevices(true);
    void listAudioInputs()
      .then(setDevices)
      .catch(() => setDevices([]))
      .finally(() => setLoadingDevices(false));
  }, [open]);

  if (!open) return null;

  // The picker value is a single string so the <select> stays simple:
  //   'desktop' → desktopCapturer mode
  //   'off'     → no system capture
  //   '<id>'    → specific device id
  const currentValue =
    audio.kind === 'desktop' ? 'desktop'
    : audio.kind === 'off' ? 'off'
    : audio.deviceId;

  const handleAudioChange = (value: string): void => {
    if (value === 'desktop') setAudio({ kind: 'desktop' });
    else if (value === 'off') setAudio({ kind: 'off' });
    else {
      const dev = devices.find((d) => d.deviceId === value);
      setAudio({ kind: 'device', deviceId: value, label: dev?.label });
    }
  };

  const loopbackDevices = devices.filter((d) => d.isLikelyLoopback);
  const otherDevices = devices.filter((d) => !d.isLikelyLoopback);

  return (
    <div className="dlg-backdrop" onClick={onClose}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <div className="dlg__header">Interview Setup</div>
        <div className="dlg__body">
          <label className="dlg__label">JOB DESCRIPTION</label>
          <textarea
            className="dlg__textarea"
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            placeholder="Paste the job description here…"
          />
          <label className="dlg__label">YOUR RESUME / KEY POINTS  (paste or summarise)</label>
          <textarea
            className="dlg__textarea"
            value={resume}
            onChange={(e) => setResume(e.target.value)}
            placeholder="Paste resume bullets or write a few sentences about your experience…"
          />

          <label className="dlg__label">INTERVIEWER AUDIO SOURCE</label>
          <select
            className="dlg__select"
            value={currentValue}
            onChange={(e) => handleAudioChange(e.target.value)}
            disabled={loadingDevices}
          >
            {/* desktopCapturer mode — works on Windows + Linux, silent on
                Mac. Always render the option so the <select> can display a
                persisted value of 'desktop' that the user hasn't migrated
                yet; just disable it on Mac so they can't re-pick it. */}
            <option value="desktop" disabled={isMac}>
              Desktop audio (system mix){isMac ? ' — not supported on macOS' : ''}
            </option>

            {loopbackDevices.length > 0 && (
              <optgroup label="Virtual audio devices (recommended)">
                {loopbackDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </optgroup>
            )}

            {otherDevices.length > 0 && (
              <optgroup label="Other audio inputs">
                {otherDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </optgroup>
            )}

            <option value="off">Off — only transcribe my mic</option>
          </select>

          {/* Platform-specific guidance */}
          {isMac && loopbackDevices.length === 0 && (
            <div className="dlg__hint">
              <strong>macOS:</strong> System audio is sandboxed by Apple, so the copilot
              can't capture the interviewer's voice directly. Install{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  // Open in default browser (not our window) so the URL is
                  // visible to the user and we don't have to host a webview.
                  // The host page handles real navigation safely.
                  window.open('https://existential.audio/blackhole/', '_blank');
                }}
              >
                BlackHole
              </a>{' '}
              (free, ~2 min), route system output to it via a Multi-Output Device, then
              come back here and pick it from this list.
            </div>
          )}
          {audio.kind === 'desktop' && isMac && (
            <div className="dlg__hint dlg__hint--warn">
              Desktop audio doesn't work on macOS. Pick a virtual input device (BlackHole / Loopback) or this side will be silent.
            </div>
          )}
          {audio.kind === 'off' && (
            <div className="dlg__hint">
              Mic-only mode. The interviewer side will not be captioned and no answer suggestions will be generated.
            </div>
          )}

          <label className="dlg__label">ANSWER STYLE</label>
          <div className="dlg__style-row">
            <button
              type="button"
              className={`dlg__style-card${style === 'informal' ? ' dlg__style-card--active' : ''}`}
              onClick={() => setStyle('informal')}
            >
              <div className="dlg__style-card__title">Informal</div>
              <div className="dlg__style-card__desc">
                Natural, speaking-ready prose. Conversational tone, contractions, flowing
                paragraphs. Bullets only for genuine lists. Best for behavioural / experience
                / culture questions you read aloud.
              </div>
            </button>
            <button
              type="button"
              className={`dlg__style-card${style === 'formal' ? ' dlg__style-card--active' : ''}`}
              onClick={() => setStyle('formal')}
            >
              <div className="dlg__style-card__title">Formal</div>
              <div className="dlg__style-card__desc">
                Structured with bullets. One-line opening answer, then bulleted details,
                trade-offs and steps. Section labels (Background, What I did, Result) for
                deep-dives. Useful for technical / panel / take-home contexts.
              </div>
            </button>
          </div>

          <label className="dlg__label">GLOBAL HOTKEYS</label>
          <div className="dlg__hint">
            Pin/summon and a privacy panic key — they work even when the app
            doesn't have focus. Click a field and press your chord. If your
            layout doesn't have <code>\</code>, pick anything else (e.g.{' '}
            <code>{isMac ? 'Cmd' : 'Ctrl'}+;</code>).
          </div>
          <div className="dlg__hotkey-row">
            <span className="dlg__hotkey-name">Pin / Summon</span>
            <ShortcutInput
              value={pinAccel}
              onChange={setPinAccel}
              defaultValue={DEFAULT_PIN_SHORTCUT}
            />
          </div>
          <div className="dlg__hotkey-row">
            <span className="dlg__hotkey-name">Privacy Panic</span>
            <ShortcutInput
              value={privacyAccel}
              onChange={setPrivacyAccel}
              defaultValue={DEFAULT_PRIVACY_SHORTCUT}
            />
          </div>
        </div>
        <div className="dlg__bar">
          <button className="dlg__btn" onClick={onClose}>Cancel</button>
          <button
            className="dlg__btn dlg__btn--primary"
            onClick={() => {
              onSave(jd.trim(), resume.trim(), audio, style, pinAccel, privacyAccel);
              onClose();
            }}
          >
            Save &amp; Apply
          </button>
        </div>
      </div>
    </div>
  );
}

interface ShortcutInputProps {
  value: string;
  onChange: (next: string) => void;
  defaultValue: string;
}

// Click-to-record input. While "recording" we listen for the first
// complete chord (modifier + key, or function key on its own) and
// commit it. Pressing Escape cancels. A "Reset" button restores the
// shipped default so a misclick on AZERTY doesn't strand the user.
function ShortcutInput({ value, onChange, defaultValue }: ShortcutInputProps): JSX.Element {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent): void => {
      // preventDefault on every keystroke so app-level shortcuts (Ctrl+T
      // opening a tab, Esc closing the dialog) don't fire mid-capture.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }
      const result = captureShortcut(e);
      if (!result) return; // pure modifier or unsupported key — keep waiting
      onChange(result.accelerator);
      setRecording(false);
    };
    // Capture phase so we beat the app's own keydown listener
    // (use-shortcuts.ts) that would otherwise dispatch the chord as a
    // browser action before we see it.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, onChange]);

  return (
    <div className="dlg__hotkey-controls">
      <button
        type="button"
        className={`dlg__hotkey-btn${recording ? ' dlg__hotkey-btn--recording' : ''}`}
        onClick={() => setRecording((r) => !r)}
        title={recording ? 'Press your shortcut, or Esc to cancel' : 'Click and press a chord'}
      >
        {recording ? 'Press a key…' : prettyLabel(value)}
      </button>
      {value !== defaultValue && (
        <button
          type="button"
          className="dlg__hotkey-reset"
          onClick={() => onChange(defaultValue)}
          title="Restore default"
        >
          Reset
        </button>
      )}
    </div>
  );
}
