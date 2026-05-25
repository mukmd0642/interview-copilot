import { useEffect, useRef, useState, useCallback } from 'react';
import { useApp } from '../state/store.js';
import { webviewRegistry, type WebviewElement } from '../lib/webview-registry.js';

// Embedded browser using Electron's <webview> tag.
//
// Purpose: a private utility browser that lives inside the
// screen-capture-protected window. Useful for looking things up during an
// interview (ChatGPT / Claude / docs / Stack Overflow / Google) without
// exposing the tab to the interviewer's screen share.
//
// NOT used for audio capture — interviewer audio comes from the OS-level
// system mix on Win/Linux and from a virtual input device (BlackHole) on
// Mac. The candidate joins the interview in their normal native client.

const HOMEPAGE = 'https://www.google.com';
const startUrl = (raw: string): string => {
  const v = raw.trim();
  if (!v) return HOMEPAGE;
  if (v.includes('://')) return v;
  if (!v.includes(' ') && v.includes('.') && !v.startsWith('.')) return `https://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
};

export function BrowserView(): JSX.Element {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const newTab = useApp((s) => s.newTab);
  const closeTab = useApp((s) => s.closeTab);
  const selectTab = useApp((s) => s.selectTab);
  const updateTab = useApp((s) => s.updateTab);
  const pushHistory = useApp((s) => s.pushHistory);

  const [address, setAddress] = useState<string>(() => {
    return tabs.find((t) => t.id === activeTabId)?.url ?? HOMEPAGE;
  });

  // Local map of tab id → live <webview> element. The shared registry
  // (webview-registry.ts) mirrors this so non-React modules (keyboard
  // hook) can reach the active webview without prop drilling.
  const webviewRefs = useRef<Map<string, WebviewElement>>(new Map());

  const activeWebview = (): WebviewElement | null => {
    return webviewRefs.current.get(activeTabId) ?? null;
  };

  const navigate = useCallback((raw?: string) => {
    const wv = activeWebview();
    if (!wv) return;
    const url = startUrl(raw ?? address);
    wv.loadURL(url).catch(() => {
      // Some URLs (chrome://, file://, javascript:) are blocked by Electron
      // for security. Silently failing is the right behaviour — the
      // address bar still reflects what the user typed.
    });
  }, [address]);

  // Sync the address bar with the active webview's URL.
  useEffect(() => {
    const wv = activeWebview();
    if (!wv) return;
    const handler = (): void => setAddress(wv.getURL());
    wv.addEventListener('did-navigate' as never, handler);
    wv.addEventListener('did-navigate-in-page' as never, handler);
    return () => {
      wv.removeEventListener('did-navigate' as never, handler);
      wv.removeEventListener('did-navigate-in-page' as never, handler);
    };
  }, [activeTabId]);

  return (
    <div className="browser">
      <div className="browser__navbar">
        <button className="browser__navbtn" onClick={() => activeWebview()?.goBack()}>◀</button>
        <button className="browser__navbtn" onClick={() => activeWebview()?.goForward()}>▶</button>
        <button className="browser__navbtn" onClick={() => activeWebview()?.reload()}>⟳</button>
        <input
          className="browser__address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate();
          }}
        />
        <button className="browser__navbtn" onClick={() => navigate()}>Go</button>
        <button className="browser__navbtn browser__navbtn--accent" onClick={() => newTab()}>+ Tab</button>
      </div>

      <div className="browser__tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`browser__tab${t.id === activeTabId ? ' browser__tab--active' : ''}`}
            onClick={() => {
              selectTab(t.id);
              const wv = webviewRefs.current.get(t.id);
              if (wv) setAddress(wv.getURL());
            }}
            onAuxClick={(e) => {
              // Middle-click closes tab — same as the WinForms behaviour.
              if (e.button === 1) closeTab(t.id);
            }}
          >
            <span className="browser__tab__title">{t.title.length > 25 ? t.title.slice(0, 25) + '…' : t.title}</span>
            {tabs.length > 1 && (
              <button
                className="browser__tab__close"
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
              >×</button>
            )}
          </div>
        ))}
      </div>

      <div className="browser__viewport">
        {tabs.map((t) => (
          // We render every webview but only show the active one. Hiding
          // via CSS rather than unmounting preserves browsing state when
          // switching tabs.
          <webview
            key={t.id}
            ref={(el: WebviewElement) => {
              if (el) {
                webviewRefs.current.set(t.id, el);
                // Update the shared registry whenever the active webview
                // changes so the keyboard hook (and any future module)
                // always finds the right element.
                if (t.id === activeTabId) webviewRegistry.setActive(el);
                if (!el.dataset['hooked']) {
                  el.dataset['hooked'] = '1';
                  el.addEventListener(
                    'page-title-updated',
                    ((evt: Event & { title?: string }) => {
                      const title = evt.title;
                      if (typeof title !== 'string') return;
                      updateTab(t.id, { title });
                    }) as unknown as EventListener
                  );
                  el.addEventListener('did-navigate' as never, () => {
                    const url = el.getURL();
                    updateTab(t.id, { url });
                    pushHistory(url, el.getTitle?.() ?? '');
                  });
                }
              } else {
                webviewRefs.current.delete(t.id);
              }
            }}
            src={t.url}
            style={{ display: t.id === activeTabId ? 'flex' : 'none', width: '100%', height: '100%' }}
            allowpopups={'true' as never}
          />
        ))}
      </div>
    </div>
  );
}
