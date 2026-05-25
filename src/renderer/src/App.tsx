import { useState, useEffect } from 'react';
import { LoginForm } from './components/LoginForm.js';
import { InterviewView } from './components/InterviewView.js';
import { useShortcuts } from './lib/use-shortcuts.js';

type View = 'loading' | 'login' | 'interview';

export function App(): JSX.Element {
  // Register browser-style keyboard accelerators (Ctrl+T/W/H, Alt+arrows,
  // Ctrl+Shift+B). Installed at the App level so they work no matter
  // which view is mounted.
  useShortcuts();

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

  return <InterviewView />;
}
