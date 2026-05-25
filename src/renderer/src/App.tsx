import { useState, useEffect } from 'react';
import { LoginForm } from './components/LoginForm.js';

type View = 'loading' | 'login' | 'interview';

export function App(): JSX.Element {
  const [view, setView] = useState<View>('loading');
  const [, setEmail] = useState<string | null>(null);

  // On boot, ask main if we already have a session (e.g. dev reload).
  useEffect(() => {
    let cancelled = false;
    void window.api.auth.status().then((s) => {
      if (cancelled) return;
      if (s.authenticated) {
        setEmail(s.email);
        setView('interview');
      } else {
        setView('login');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (view === 'loading') {
    return <div className="login"><div className="login__card"><p className="login__subtitle">Starting…</p></div></div>;
  }

  if (view === 'login') {
    return (
      <LoginForm
        onSignedIn={(e) => {
          setEmail(e);
          setView('interview');
        }}
      />
    );
  }

  return <InterviewPlaceholder />;
}

// Placeholder until the next turn wires up the full panel layout, audio
// capture, and transcription. Keeps the login → main app flow demoable.
function InterviewPlaceholder(): JSX.Element {
  return (
    <div className="app-shell">
      <div className="toolbar">
        <button className="toolbar__btn toolbar__btn--primary">Setup</button>
        <button className="toolbar__btn">Browser</button>
        <button className="toolbar__btn">CC</button>
        <div className="toolbar__status">
          Signed in. The interview panels, audio capture, and transcription wire up in the next pass.
        </div>
        <button className="toolbar__btn toolbar__btn--privacy-on">Priv ON</button>
      </div>
      <div className="interview">
        <div className="interview__left">
          <div className="panel">
            <div className="panel__header panel__header--them">INTERVIEWER</div>
            <div className="panel__body">Waiting for transcription pipeline…</div>
          </div>
          <div className="panel">
            <div className="panel__header panel__header--you">YOU</div>
            <div className="panel__body" />
          </div>
        </div>
        <div className="interview__right">
          <div className="panel">
            <div className="panel__header panel__header--answer">
              <span className="panel__header__title">SUGGESTED ANSWER</span>
            </div>
            <div className="panel__body panel__body--answer">
              Start CC to enable live answer suggestions.
            </div>
          </div>
          <div className="panel">
            <div className="panel__header panel__header--summary">KEY POINTS</div>
            <div className="panel__body panel__body--summary" />
          </div>
        </div>
      </div>
    </div>
  );
}
