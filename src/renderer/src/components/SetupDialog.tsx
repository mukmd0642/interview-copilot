import { useState, useEffect } from 'react';
import { listAudioInputs, type AudioInputDevice } from '../lib/audio-devices.js';
import type { SystemAudioMode } from '../../../shared/ipc';

interface Props {
  initialJd: string;
  initialResume: string;
  initialSystemAudio: SystemAudioMode;
  open: boolean;
  onClose: () => void;
  onSave: (jd: string, resume: string, systemAudio: SystemAudioMode) => void;
}

const isMac = navigator.platform.toLowerCase().includes('mac');

export function SetupDialog({
  initialJd,
  initialResume,
  initialSystemAudio,
  open,
  onClose,
  onSave,
}: Props): JSX.Element | null {
  const [jd, setJd] = useState(initialJd);
  const [resume, setResume] = useState(initialResume);
  const [audio, setAudio] = useState<SystemAudioMode>(initialSystemAudio);
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);

  useEffect(() => {
    if (open) {
      setJd(initialJd);
      setResume(initialResume);
      setAudio(initialSystemAudio);
    }
  }, [open, initialJd, initialResume, initialSystemAudio]);

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
        </div>
        <div className="dlg__bar">
          <button className="dlg__btn" onClick={onClose}>Cancel</button>
          <button
            className="dlg__btn dlg__btn--primary"
            onClick={() => {
              onSave(jd.trim(), resume.trim(), audio);
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
