import { log, q } from './log.js';
import type { LoginRequest, LoginError, LoginResult } from '../shared/ipc.js';

// The backend that issues bearer tokens and hands out the OpenAI API key.
// Set INTERVIEW_COPILOT_AUTH_URL in dev to point at a local instance.
const BASE_URL = process.env.INTERVIEW_COPILOT_AUTH_URL ?? 'https://resume-tailor-webapp.vercel.app';

const TIMEOUT_MS = 15_000;

interface Session {
  token: string;
  apiKey: string;
  email: string;
}

let session: Session | null = null;

export function currentSession(): Session | null {
  return session;
}

export function apiKey(): string | null {
  return session?.apiKey ?? null;
}

export function clearSession(): void {
  session = null;
}

function classify(err: unknown): LoginError {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return { ok: false, code: 'timeout', message: 'Connection timed out.' };
    return { ok: false, code: 'network', message: err.message };
  }
  return { ok: false, code: 'unknown', message: String(err) };
}

export async function login(req: LoginRequest): Promise<LoginResult | LoginError> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const loginResp = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: req.email, password: req.password }),
      signal: ctrl.signal,
    });

    if (loginResp.status === 401 || loginResp.status === 400) {
      return { ok: false, code: 'invalid', message: 'Invalid email or password.' };
    }
    if (loginResp.status === 403) {
      return { ok: false, code: 'forbidden', message: 'Account is disabled. Contact your administrator.' };
    }
    if (!loginResp.ok) {
      return { ok: false, code: 'network', message: `HTTP ${loginResp.status}` };
    }

    const loginJson = (await loginResp.json()) as { token?: string; user?: { email?: string } };
    const token = loginJson.token;
    if (!token) return { ok: false, code: 'unknown', message: 'Server returned no token.' };
    const email = loginJson.user?.email ?? req.email;

    const keyResp = await fetch(`${BASE_URL}/api/user/api-key`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (keyResp.status === 403) {
      return {
        ok: false,
        code: 'forbidden',
        message: 'Your account is not authorized to use this app. Contact your administrator.',
      };
    }
    if (!keyResp.ok) {
      return { ok: false, code: 'network', message: `HTTP ${keyResp.status} fetching API key` };
    }

    const keyJson = (await keyResp.json()) as { api_key?: string };
    const key = keyJson.api_key;
    if (!key) return { ok: false, code: 'unknown', message: 'Server returned no API key.' };

    session = { token, apiKey: key, email };
    log('auth', `login ok email=${q(email, 60)}`);
    return { ok: true, email };
  } catch (err) {
    log('auth', `login error: ${(err as Error).message ?? String(err)}`);
    return classify(err);
  } finally {
    clearTimeout(timer);
  }
}
