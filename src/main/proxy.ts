// Optional outbound proxy, auto-detected from the environment.
//
// The app's traffic is split across two network stacks that DON'T share proxy
// settings, so each has to be routed explicitly:
//
//   • Node global fetch (undici) — auth, the coding agent, the interview
//     answer engine, and the push-to-talk goal transcription. Routed by
//     installing a global undici dispatcher (covers every fetch() in the app
//     at once, no per-call changes).
//   • The realtime transcription WebSockets (the `ws` library) — routed by
//     handing each socket an http(s) CONNECT-tunnelling agent.
//   • The embedded Chromium <webview> — routed with the --proxy-server switch
//     (must be set before app `ready`, hence applyProxyFromEnv runs at module
//     load in index.ts).
//
// Detection follows the de-facto convention: HTTPS_PROXY / HTTP_PROXY /
// ALL_PROXY, upper- or lower-case. ONLY http:// and https:// proxies are
// honoured — they cover corporate forward proxies and the common debugging
// proxies (mitmproxy / Burp / Charles). A socks:// URL is logged and ignored
// for the API traffic rather than silently half-working. When no proxy var is
// set this module is a complete no-op and the app connects directly.
//
// Basic-auth credentials embedded in the URL (http://user:pass@host:port) are
// honoured on all three stacks.

import type { App } from 'electron';
import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { log } from './log.js';

// Precedence order: an explicit HTTPS_PROXY wins over the catch-all ALL_PROXY,
// which wins over HTTP_PROXY. Lower-case variants (curl convention) are
// checked right after their upper-case form.
const ENV_KEYS = [
  'HTTPS_PROXY', 'https_proxy',
  'ALL_PROXY', 'all_proxy',
  'HTTP_PROXY', 'http_proxy',
] as const;

// undefined = not resolved yet; null = resolved to "no usable proxy".
let resolved: string | null | undefined;
let creds: { user: string; pass: string } | null = null;
let wsAgent: HttpsProxyAgent<string> | undefined;
// Set if applyProxyFromEnv hit an error: we then refuse to hand out a ws agent
// too, so the whole app stays consistently un-proxied rather than half-on.
let proxyFailed = false;

function readEnvProxy(): string | null {
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Resolve (once, then cache) the http(s) proxy URL from the environment.
 * Returns null when nothing usable is configured. Also extracts embedded
 * basic-auth credentials into `creds` as a side effect.
 */
function resolve(): string | null {
  if (resolved !== undefined) return resolved;

  const raw = readEnvProxy();
  if (!raw) {
    resolved = null;
    return null;
  }

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    log('proxy', `ignoring malformed proxy URL ${redact(raw)}`);
    resolved = null;
    return null;
  }

  const scheme = u.protocol.replace(':', '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    log('proxy', `proxy scheme "${scheme}" is not supported (need http/https) — proxy DISABLED`);
    resolved = null;
    return null;
  }

  if (u.username || u.password) {
    creds = { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
  }

  resolved = raw;
  return raw;
}

/** The configured http(s) proxy URL, or null. Cached after the first call. */
export function proxyUrl(): string | null {
  return resolve();
}

/**
 * Agent for `ws` WebSocket connections. Returns undefined when no proxy is
 * configured (ws treats `agent: undefined` as "connect directly").
 */
export function proxyAgentForWs(): HttpsProxyAgent<string> | undefined {
  const url = resolve();
  if (!url || proxyFailed) return undefined;
  // https-proxy-agent reads any embedded user:pass@ from the URL itself, so we
  // hand it the full credentialed form.
  if (!wsAgent) wsAgent = new HttpsProxyAgent(url);
  return wsAgent;
}

/** Strip embedded credentials — `http://user:pass@host:port` → `http://host:port`. */
function stripCredentials(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`; // host includes the port
}

/**
 * Detect a proxy from the environment and, if present, route ALL of the app's
 * traffic through it (fetch + realtime WebSockets + the embedded browser).
 * No-op when no proxy var is set. Call exactly once, at module load, BEFORE
 * app `ready` — the Chromium --proxy-server switch is read during network
 * stack init and is ignored if applied after the app is ready.
 */
export function applyProxyFromEnv(app: App): void {
  const url = resolve();
  if (!url) {
    log('proxy', 'no proxy env var set — direct connections');
    return;
  }

  // This runs at module load, BEFORE the uncaughtException handler is in place.
  // A throw here would take the whole app down with no window and no log line,
  // so proxy setup must NEVER be fatal: on any failure we log and fall back to
  // direct connections instead of crashing.
  try {
    // Both undici's `uri` and Chromium's --proxy-server must be
    // credential-FREE: undici takes auth via the `token` option, and Chromium
    // rejects user:pass@ in the switch (auth goes through the 'login' event).
    const clean = stripCredentials(url);
    const token = creds
      ? `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString('base64')}`
      : undefined;

    // 1) Node global fetch — one dispatcher covers every fetch() in the app.
    setGlobalDispatcher(token ? new ProxyAgent({ uri: clean, token }) : new ProxyAgent(clean));

    // 2) Chromium / <webview>.
    app.commandLine.appendSwitch('proxy-server', clean);

    // Answer the proxy auth challenge when credentials were supplied — Chromium
    // can't read them from the switch.
    if (creds) {
      app.on('login', (event, _webContents, _request, authInfo, callback) => {
        if (authInfo.isProxy) {
          event.preventDefault();
          callback(creds!.user, creds!.pass);
        } else {
          callback(); // not ours — let the default handler run
        }
      });
    }

    // 3) The ws agent is built lazily on first proxyAgentForWs() call.

    log('proxy', `ENABLED via env → routing all traffic through ${redact(url)}`);
  } catch (err) {
    proxyFailed = true;
    log('proxy', `setup FAILED (${(err as Error).message}) — continuing WITHOUT proxy`);
    // Undo any partially-applied dispatcher so global fetch still works direct.
    try { setGlobalDispatcher(new Agent()); } catch { /* ignore */ }
  }
}

/** Hide any embedded credentials before a proxy URL hits the log. */
function redact(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//***@');
}
