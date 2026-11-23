import { log, q } from './log.js';
import type { LoginRequest, LoginError, LoginResult } from '../shared/ipc.js';

// The backend that issues bearer tokens and hands out the OpenAI API key.
// Set INTERVIEW_COPILOT_AUTH_URL in dev to point at a local instance.
const BASE_URL = process.env.INTERVIEW_COPILOT_AUTH_URL ?? 'https://career-forge-web.vercel.app';

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

/**
 * Masks secret VALUES (anything under a key/token/secret/password field, plus
 * any bare `sk-…` token) while leaving JSON STRUCTURE intact — so a log can
 * reveal that the key arrived under, say, `"apiKey"` instead of `"api_key"`,
 * without ever writing a live credential to disk.
 */
function redactSecrets(s: string): string {
  return s
    .replace(
      /("(?:[\w-]*(?:key|token|secret|password)[\w-]*)"\s*:\s*")([^"]*)(")/gi,
      (_m, field: string, value: string, close: string) =>
        `${field}***REDACTED(len=${value.length})***${close}`,
    )
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, (m) => `sk-***REDACTED(len=${m.length})***`);
}

/**
 * One-line diagnostic of a response for app.log: HTTP status, whether the
 * request was redirected (a cross-origin redirect silently strips the
 * Authorization header), the final resolved URL, the content-type, and the
 * body with secrets masked. This is what makes a backend-shape mismatch
 * visible instead of a generic "no API key".
 */
function diag(resp: Response, body: string): string {
  return (
    `status=${resp.status} redirected=${resp.redirected} ` +
    `finalUrl=${q(resp.url, 160)} ` +
    `ctype=${q(resp.headers.get('content-type'), 60)} ` +
    `body=${q(redactSecrets(body), 500)}`
  );
}

export async function login(req: LoginRequest): Promise<LoginResult | LoginError> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    log('auth', `login → POST ${BASE_URL}/api/auth/login email=${q(req.email, 60)}`);
    const loginResp = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: req.email, password: req.password }),
      signal: ctrl.signal,
    });
    // Read the body ONCE as text so we can both parse it and dump it verbatim
    // (redacted) on any failure path.
    const loginBody = await loginResp.text();

    if (loginResp.status === 401 || loginResp.status === 400) {
      log('auth', `login REJECTED ${diag(loginResp, loginBody)}`);
      return { ok: false, code: 'invalid', message: 'Invalid email or password.' };
    }
    if (loginResp.status === 403) {
      log('auth', `login FORBIDDEN ${diag(loginResp, loginBody)}`);
      return { ok: false, code: 'forbidden', message: 'Account is disabled. Contact your administrator.' };
    }
    if (!loginResp.ok) {
      log('auth', `login HTTP ERROR ${diag(loginResp, loginBody)}`);
      return { ok: false, code: 'network', message: `HTTP ${loginResp.status}` };
    }

    let loginJson: { token?: string; user?: { email?: string } };
    try {
      loginJson = JSON.parse(loginBody) as { token?: string; user?: { email?: string } };
    } catch {
      log('auth', `login BAD JSON ${diag(loginResp, loginBody)}`);
      return { ok: false, code: 'unknown', message: 'Login response was not valid JSON.' };
    }
    const token = loginJson.token;
    if (!token) {
      log('auth', `login NO TOKEN — expected top-level "token" ${diag(loginResp, loginBody)}`);
      return { ok: false, code: 'unknown', message: 'Server returned no token.' };
    }
    const email = loginJson.user?.email ?? req.email;

    log('auth', `api-key → GET ${BASE_URL}/api/user/api-key (Bearer present, tokenLen=${token.length})`);
    const keyResp = await fetch(`${BASE_URL}/api/user/api-key`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const keyBody = await keyResp.text();

    if (keyResp.status === 403) {
      log('auth', `api-key FORBIDDEN ${diag(keyResp, keyBody)}`);
      return {
        ok: false,
        code: 'forbidden',
        message: 'Your account is not authorized to use this app. Contact your administrator.',
      };
    }
    if (!keyResp.ok) {
      log('auth', `api-key HTTP ERROR ${diag(keyResp, keyBody)}`);
      return { ok: false, code: 'network', message: `HTTP ${keyResp.status} fetching API key` };
    }

    let key: string | undefined;
    try {
      key = (JSON.parse(keyBody) as { api_key?: string }).api_key;
    } catch {
      log('auth', `api-key BAD JSON ${diag(keyResp, keyBody)}`);
      return { ok: false, code: 'unknown', message: 'API key response was not valid JSON.' };
    }
    if (!key) {
      // The common setup failure: 200 OK but the key is missing / under a
      // different field name / nested. The redacted body shows exactly which.
      log('auth', `api-key MISSING — expected top-level "api_key" ${diag(keyResp, keyBody)}`);
      return { ok: false, code: 'unknown', message: 'Server returned no API key.' };
    }

    session = { token, apiKey: key, email };
    // Success: log only that a key arrived and its length — never the key.
    log('auth', `login ok email=${q(email, 60)} apiKeyLen=${key.length}`);
    return { ok: true, email };
  } catch (err) {
    log('auth', `login error: ${(err as Error).message ?? String(err)}`);
    return classify(err);
  } finally {
    clearTimeout(timer);
  }
}
