import { useState, useCallback, type FormEvent } from 'react';

interface Props {
  onSignedIn: (email: string) => void;
}

export function LoginForm({ onSignedIn }: Props): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; isError: boolean }>({ text: '', isError: false });

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!email.trim() || !password) {
        setStatus({ text: 'Enter your email and password.', isError: true });
        return;
      }
      setBusy(true);
      setStatus({ text: 'Signing in…', isError: false });

      try {
        const result = await window.api.auth.login({ email: email.trim(), password });
        if (result.ok) {
          onSignedIn(result.email);
        } else {
          setStatus({ text: result.message, isError: true });
          setBusy(false);
        }
      } catch (err) {
        // The preload bridge should turn all errors into typed responses, so
        // this branch only fires if IPC itself fails — surface it instead of
        // silently leaving the user stuck on "Signing in…".
        setStatus({ text: `Unexpected error: ${(err as Error).message}`, isError: true });
        setBusy(false);
      }
    },
    [email, password, onSignedIn]
  );

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <h1 className="login__title">Interview Copilot</h1>
        <p className="login__subtitle">Sign in to your account</p>

        <div className="login__field">
          <label className="login__label" htmlFor="email">Email</label>
          <input
            id="email"
            className="login__input"
            type="email"
            autoComplete="username"
            value={email}
            disabled={busy}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </div>

        <div className="login__field">
          <label className="login__label" htmlFor="password">Password</label>
          <input
            id="password"
            className="login__input"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <div className={`login__status login__status--${status.isError ? 'error' : 'info'}`}>
          {status.text}
        </div>

        <button className="login__button" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
