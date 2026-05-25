import { create } from 'zustand';
import type { Language, Theme, CaptionStatus, AnswerChunk } from '../../../shared/ipc';

// Zustand store holds the rolling UI state. Kept intentionally flat — we
// don't want a complex selector hierarchy for what is really a streaming
// caption pipeline.

interface TranscriptLine {
  source: 'mic' | 'system';
  text: string;
  // Wall clock so we can render timestamps. Filled in when an accurate-final
  // arrives (canonical transcript) — fast deltas don't add lines, they
  // populate `livePreview` instead.
  at: number;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
}

export interface HistoryEntry {
  url: string;
  title: string;
  at: number;
}

const HOMEPAGE = 'https://www.google.com';
const newTabId = (): string => Math.random().toString(36).slice(2, 10);

export interface AppState {
  // Persistent / config
  language: Language;
  theme: Theme;
  privacy: boolean;
  topMost: boolean;
  opacity: number;
  answersEnabled: boolean;

  // Session lifecycle
  ccActive: boolean;
  ccBusy: boolean; // Start/Stop in progress; debounces button mashing.

  // Caption state per source. liveMic / liveSystem are the streaming
  // preview from the fast (whisper) pipeline; entries arrive from the
  // accurate (gpt-4o-transcribe) pipeline.
  entries: TranscriptLine[];
  liveMic: string;
  liveMicKey: string;     // itemId/contentIndex — tells us when to clear vs append
  liveSystem: string;
  liveSystemKey: string;

  // Answer pane
  answerBox: string;
  answerStreaming: boolean;
  pendingAnswer: string; // buffered "next" answer when one is already displayed
  pendingReady: boolean;

  // Summary pane
  summary: string;

  // Toolbar status line
  status: CaptionStatus;

  // Browser tabs (embedded <webview>). Lifted out of BrowserView local
  // state so global keyboard shortcuts (Ctrl+T, Ctrl+W) can dispatch into
  // them from anywhere in the app, not only from the browser view itself.
  browserVisible: boolean;
  tabs: BrowserTab[];
  activeTabId: string;
  history: HistoryEntry[];
  historyOpen: boolean;

  // ── Actions ─────────────────────────────────────────────────────────────
  setLanguage: (lang: Language) => void;
  setTheme: (theme: Theme) => void;
  setPrivacy: (b: boolean) => void;
  setTopMost: (b: boolean) => void;
  setOpacity: (n: number) => void;
  setAnswersEnabled: (b: boolean) => void;

  setCcBusy: (b: boolean) => void;
  setCcActive: (b: boolean) => void;

  applyFastDelta: (source: 'mic' | 'system', key: string, text: string) => void;
  applyFastFinal: (source: 'mic' | 'system', key: string, text: string) => void;
  applyAccurateFinal: (source: 'mic' | 'system', text: string) => void;
  applyAnswerChunk: (chunk: AnswerChunk) => void;
  flushPendingAnswer: () => void;
  applySummary: (text: string) => void;
  applyStatus: (s: CaptionStatus) => void;

  resetSessionUi: () => void;

  // Browser actions
  setBrowserVisible: (visible: boolean) => void;
  toggleBrowser: () => void;
  newTab: (url?: string) => void;
  closeTab: (id?: string) => void;        // id omitted = close active
  selectTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<Pick<BrowserTab, 'title' | 'url'>>) => void;
  pushHistory: (url: string, title: string) => void;
  setHistoryOpen: (open: boolean) => void;
  toggleHistory: () => void;
}

// Initial theme matches what main.tsx applied to <html> pre-render so the
// store and the DOM start in agreement. The real value loads from
// settings.json shortly after; if it differs we apply + persist.
const initialTheme: Theme =
  (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

// Seed one browser tab so the user has something to start with the first
// time they open the browser view.
const initialTab: BrowserTab = { id: newTabId(), title: 'New Tab', url: HOMEPAGE };

export const useApp = create<AppState>((set, get) => ({
  language: 'en',
  theme: initialTheme,
  privacy: true,
  topMost: false,
  opacity: 1,
  answersEnabled: true,

  ccActive: false,
  ccBusy: false,

  entries: [],
  liveMic: '',
  liveMicKey: '',
  liveSystem: '',
  liveSystemKey: '',

  answerBox: 'Start CC to enable live answer suggestions.\n\nThe AI will suggest responses as the interviewer speaks.',
  answerStreaming: false,
  pendingAnswer: '',
  pendingReady: false,

  summary: 'Key points from the interview will appear here after several exchanges.',

  status: { message: 'Click CC to start  ·  click Setup to enter your job details', level: 'info' },

  browserVisible: false,
  tabs: [initialTab],
  activeTabId: initialTab.id,
  history: [],
  historyOpen: false,

  setLanguage: (language) => set({ language }),
  setTheme: (theme) => {
    set({ theme });
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* ignore */ }
  },
  setPrivacy: (privacy) => set({ privacy }),
  setTopMost: (topMost) => set({ topMost }),
  setOpacity: (opacity) => set({ opacity }),
  setAnswersEnabled: (answersEnabled) => set({ answersEnabled }),

  setCcBusy: (ccBusy) => set({ ccBusy }),
  setCcActive: (ccActive) => set({ ccActive }),

  applyFastDelta: (source, key, text) => set((s) => {
    if (source === 'mic') {
      // New item → replace; same item → append. Matches OnFastTranscript
      // in the WinForms build.
      if (s.liveMicKey !== key) return { liveMic: text.trimStart(), liveMicKey: key };
      return { liveMic: s.liveMic + text };
    } else {
      if (s.liveSystemKey !== key) return { liveSystem: text.trimStart(), liveSystemKey: key };
      return { liveSystem: s.liveSystem + text };
    }
  }),

  applyFastFinal: (source, key, text) => set((s) => {
    // Whisper synthesised final: drop the live preview only if it was for
    // the same item — otherwise a new utterance has already started.
    const trimmed = text.trim();
    if (source === 'mic') {
      const clearedKey = s.liveMicKey === key ? '' : s.liveMicKey;
      const newLive = s.liveMicKey === key ? trimmed : s.liveMic;
      return { liveMicKey: clearedKey, liveMic: newLive };
    } else {
      const clearedKey = s.liveSystemKey === key ? '' : s.liveSystemKey;
      const newLive = s.liveSystemKey === key ? trimmed : s.liveSystem;
      return { liveSystemKey: clearedKey, liveSystem: newLive };
    }
  }),

  applyAccurateFinal: (source, text) => set((s) => {
    const trimmed = text.trim();
    if (!trimmed) return s;
    // Canonical transcript line.  Clearing the live preview because the
    // accurate text supersedes it.
    const next: Partial<AppState> = {
      entries: [...s.entries, { source, text: trimmed, at: Date.now() }],
    };
    if (source === 'mic') {
      next.liveMic = '';
      next.liveMicKey = '';
    } else {
      next.liveSystem = '';
      next.liveSystemKey = '';
    }
    return next;
  }),

  applyAnswerChunk: ({ text, done }) => {
    const s = get();
    if (!s.answersEnabled) return;
    // START signal
    if (!done && text.length === 0) {
      if (s.answerBox.length > 0 && !s.answerStreaming) {
        // We already have a displayed answer; buffer the new one and let
        // the user click "Next" or auto-advance on mic silence.
        set({ pendingAnswer: '', pendingReady: false, answerStreaming: false });
      } else {
        set({
          answerBox: '',
          pendingAnswer: '',
          pendingReady: false,
          answerStreaming: true,
        });
      }
      return;
    }
    // DONE signal
    if (done) {
      if (text.length > 0) {
        // Error message piggybacked on the DONE — append to whichever box
        // we're currently writing into.
        if (s.answerStreaming) {
          set({ answerBox: s.answerBox + text, answerStreaming: false });
        } else {
          set({ pendingAnswer: s.pendingAnswer + text, pendingReady: true });
        }
      } else if (!s.answerStreaming && s.pendingAnswer.length > 0) {
        set({ pendingReady: true });
      } else {
        set({ answerStreaming: false });
      }
      return;
    }
    // Content chunk
    if (s.answerStreaming) {
      set({ answerBox: s.answerBox + text });
    } else {
      set({ pendingAnswer: s.pendingAnswer + text });
    }
  },

  flushPendingAnswer: () => set((s) => {
    if (!s.pendingReady) return s;
    return {
      answerBox: s.pendingAnswer,
      pendingAnswer: '',
      pendingReady: false,
      answerStreaming: false,
    };
  }),

  applySummary: (text) => set({ summary: text }),
  applyStatus: (status) => set({ status }),

  resetSessionUi: () => set({
    entries: [],
    liveMic: '',
    liveMicKey: '',
    liveSystem: '',
    liveSystemKey: '',
    answerBox: '',
    pendingAnswer: '',
    pendingReady: false,
    answerStreaming: false,
    summary: '',
  }),

  // ── Browser actions ─────────────────────────────────────────────────────
  setBrowserVisible: (browserVisible) => set({ browserVisible }),
  toggleBrowser: () => set((s) => ({ browserVisible: !s.browserVisible })),

  newTab: (url = HOMEPAGE) => set((s) => {
    const tab: BrowserTab = { id: newTabId(), title: 'New Tab', url };
    return {
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
      // Auto-switch to browser view so Ctrl+T from the interview view
      // does the obvious thing: opens the browser and shows the new tab.
      browserVisible: true,
    };
  }),

  closeTab: (id) => set((s) => {
    const targetId = id ?? s.activeTabId;
    // Don't close the last tab — leave a single empty tab so the user
    // doesn't end up with an empty browser view.
    if (s.tabs.length <= 1) return s;
    const next = s.tabs.filter((t) => t.id !== targetId);
    const nextActive =
      targetId === s.activeTabId
        // After closing the active tab, fall back to the previous one
        // (more natural than jumping to the first).
        ? next[Math.max(0, s.tabs.findIndex((t) => t.id === targetId) - 1)]?.id ?? next[0]!.id
        : s.activeTabId;
    return { tabs: next, activeTabId: nextActive };
  }),

  selectTab: (id) => set({ activeTabId: id }),

  updateTab: (id, patch) => set((s) => ({
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  })),

  pushHistory: (url, title) => set((s) => {
    if (!url || url === 'about:blank') return s;
    // De-dup: if the previous entry is for the same URL, just update the
    // timestamp/title instead of growing the list with reload spam.
    const last = s.history[s.history.length - 1];
    if (last && last.url === url) {
      const updated = [...s.history];
      updated[updated.length - 1] = { url, title, at: Date.now() };
      return { history: updated };
    }
    const entry: HistoryEntry = { url, title, at: Date.now() };
    // Cap history at 500 entries — matches the WinForms 1000 budget halved
    // since we're keeping more metadata per entry.
    const next = [...s.history, entry];
    if (next.length > 500) next.shift();
    return { history: next };
  }),

  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  toggleHistory: () => set((s) => ({ historyOpen: !s.historyOpen })),
}));
