import { useState, useEffect, useRef, useCallback, Component } from "react";
import { useApp } from "./lib/context.jsx";
import { FONTS, ALL_THEMES, DARK_THEMES, LIGHT_THEMES } from "./lib/themes.js";
import {
  getSubjects, putSubject, deleteSubject,
  getDocsBySubject, putDoc, deleteDoc, putChunks, getChunksBySubject,
} from "./lib/db.js";
import { extractText, chunkText, embedTexts, nameSubject } from "./lib/gemini.js";
import SubjectHome from "./pages/SubjectHome.jsx";
import QAMode from "./pages/QAMode.jsx";
import QuizMode from "./pages/QuizMode.jsx";
import StudyMode from "./pages/StudyMode.jsx";

// ── Toast system ──────────────────────────────────────────────────────────────
let _addToast = null;
export function toast(msg, type = "info", duration = 3500) {
  _addToast?.({ msg, type, duration, id: crypto.randomUUID() });
}

function ToastContainer() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    _addToast = (t) => {
      setToasts(p => [...p, t]);
      setTimeout(() => setToasts(p => p.filter(x => x.id !== t.id)), t.duration);
    };
    return () => { _addToast = null; };
  }, []);
  if (!toasts.length) return null;
  return (
    <div style={{ position:"fixed", bottom:24, right:24, zIndex:999, display:"flex", flexDirection:"column", gap:8, pointerEvents:"none" }}>
      {toasts.map(t => (
        <div key={t.id} className="toast fade-in" data-type={t.type}>
          {t.type === "error" && "✗ "}{t.type === "success" && "✓ "}{t.msg}
        </div>
      ))}
    </div>
  );
}

// ── Error Boundary ────────────────────────────────────────────────────────────
export class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  componentDidCatch(e, info) { console.error("ErrorBoundary:", e, info); }
  render() {
    if (this.state.error) return (
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16, padding:40 }}>
        <div style={{ fontSize:40 }}>💥</div>
        <h2 style={{ fontSize:18, fontWeight:700 }}>Something went wrong</h2>
        <p style={{ fontSize:13, color:"var(--muted)", maxWidth:400, textAlign:"center", lineHeight:1.7 }}>
          {this.state.error?.message || "An unexpected error occurred."}
        </p>
        <button className="btn primary" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
    return this.props.children;
  }
}

// ── Document processing ───────────────────────────────────────────────────────
export async function processDocuments(files, subjectId, settings, onProgress) {
  const existingDocs = await getDocsBySubject(subjectId);
  const existingNames = new Set(existingDocs.map(d => d.name));

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    // #11 Duplicate detection
    if (existingNames.has(file.name)) {
      toast(`"${file.name}" already exists in this subject — skipped.`, "info");
      continue;
    }
    onProgress?.(`Extracting text: ${file.name}…`, i, files.length);
    const docId = crypto.randomUUID();
    const ab = await file.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let binary = "";
    const chunk = 8192;
    for (let b = 0; b < bytes.length; b += chunk) {
      binary += String.fromCharCode(...bytes.subarray(b, b + chunk));
    }
    const b64 = btoa(binary);

    await putDoc({
      id: docId, subjectId,
      name: file.name,
      type: file.name.split(".").pop().toLowerCase(),
      size: file.size,
      addedAt: Date.now(),
      fileData: b64,
      mimeType: file.type,
    });

    let text = "";
    try { text = await extractText(file); } catch (e) { console.warn("Extract:", e); }

    if (!text || text.startsWith("[IMAGE") || text.startsWith("[Unsupported")) continue;

    const rawChunks = chunkText(text, {
      chunkSize: settings.chunkSize || 512,
      overlap: settings.chunkOverlap || 64,
      strategy: settings.embedStrategy || "semantic",
    });

    const hasKeys = (settings.apiKeys||[]).some(k=>k.key);
    if (hasKeys && rawChunks.length) {
      onProgress?.(`Embedding ${rawChunks.length} chunks: ${file.name}…`, i, files.length);
      try {
        const embeddings = await embedTexts(rawChunks.map((c) => c.text), settings);
        await putChunks(rawChunks.map((c, j) => ({
          subjectId, docId, docName: file.name,
          text: c.text, page: c.page || null,
          embedding: embeddings[j],
        })));
      } catch (e) {
        console.warn("Embedding failed, storing without vectors:", e);
        await putChunks(rawChunks.map((c) => ({
          subjectId, docId, docName: file.name,
          text: c.text, page: c.page || null, embedding: null,
        })));
      }
    } else if (rawChunks.length) {
      await putChunks(rawChunks.map((c) => ({
        subjectId, docId, docName: file.name,
        text: c.text, page: c.page || null, embedding: null,
      })));
    }
  }
}

// ── #17 Improved keyword search with IDF weighting ────────────────────────────
export function keywordSearch(query, chunks, k = 5) {
  // #9 keep tokens length > 1 (catches "pH", "AI", "UV" etc)
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  // compute IDF: log(N / df) for each word
  const N = chunks.length;
  const df = {};
  words.forEach(w => {
    df[w] = chunks.filter(c => c.text.toLowerCase().includes(w)).length || 1;
  });
  return chunks
    .map((c) => {
      const t = c.text.toLowerCase();
      const score = words.reduce((a, w) => {
        const tf = t.split(w).length - 1;
        const idf = Math.log((N + 1) / df[w]);
        return a + tf * idf;
      }, 0);
      return { ...c, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ── Subject color palette (deterministic from ID) ────────────────────────────
const SUBJECT_COLORS = [
  "#a5b4fc","#6ee7b7","#fda4af","#fcd34d","#93c5fd","#c4b5fd",
  "#5eead4","#94a3b8","#67e8f9","#39ff14","#fb923c","#f9a8d4",
];
export function subjectColor(id = "") {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return SUBJECT_COLORS[h % SUBJECT_COLORS.length];
}

// ── #26 Better subject initials ───────────────────────────────────────────────
export function subjectInitials(name = "") {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// ── Icons ────────────────────────────────────────────────────────────────────
export const Icon = {
  Menu: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>,
  Settings: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  Upload: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg>,
  QA: ({ size = 16 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  Quiz: ({ size = 16 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="2"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="12" y2="16"/></svg>,
  Study: ({ size = 16 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>,
  Trash: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>,
  ChevronRight: ({ size = 14, color = "currentColor" }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>,
  Logo: () => <div style={{ width:26, height:26, borderRadius:7, background:"var(--accent)", display:"flex", alignItems:"center", justifyContent:"center" }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-fg)" strokeWidth="2.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></div>,
  Pin: ({ filled = false, size = 14 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2"><path d="M12 2L8 8H3l4 4-2 8 7-4 7 4-2-8 4-4h-5z"/></svg>,
  Sun: ({ size = 16 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>,
  Moon: ({ size = 16 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>,
  Search: ({ size = 14 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
};

// ── Reusable UI primitives ────────────────────────────────────────────────────
export function LoadingSpinner({ size = 20 }) {
  return <div style={{ width: size, height: size, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin .7s linear infinite", flexShrink: 0 }} />;
}

// #14 Accessible toggle
export function Toggle({ value, onChange, label }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      {label && <span style={{ fontSize: 13, color: "var(--text)" }}>{label}</span>}
      <button
        role="switch"
        aria-checked={value}
        aria-label={label}
        className={`toggle ${value ? "on" : "off"}`}
        onClick={() => onChange(!value)}
      />
    </div>
  );
}

export function DocTypeIcon({ type, size = 14 }) {
  const colors = { pdf:"#f87171", docx:"#60a5fa", doc:"#60a5fa", txt:"#9ca3af", md:"#9ca3af", pptx:"#fb923c", png:"#4ade80", jpg:"#4ade80", jpeg:"#4ade80", webp:"#34d399", default:"#9ca3af" };
  const c = colors[(type||"").toLowerCase()] || colors.default;
  return <div style={{ width:size, height:size, borderRadius:3, background:c, display:"flex", alignItems:"center", justifyContent:"center", fontSize:6, fontWeight:900, color:"#fff", flexShrink:0, letterSpacing:-.5 }}>{(type||"?").toUpperCase().slice(0,3)}</div>;
}

// ── Skeleton loader ───────────────────────────────────────────────────────────
export function Skeleton({ width = "100%", height = 16, style = {} }) {
  return <div style={{ width, height, borderRadius: 6, background: "var(--surface2)", animation: "shimmer 1.4s infinite linear", backgroundSize: "200% 100%", ...style }} />;
}

// ── Global CSS ───────────────────────────────────────────────────────────────
function GlobalStyles() {
  return <style>{`
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { -webkit-text-size-adjust: 100%; }
    body { background: var(--bg); color: var(--text); font-family: var(--font); line-height: 1.5; }
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 99px; }
    button, input, select, textarea { font-family: var(--font); }
    button { cursor: pointer; }
    a { color: var(--accent); text-decoration: none; }

    .btn { display:inline-flex; align-items:center; gap:6px; padding:7px 15px; border-radius:var(--radius); border:1px solid var(--border); background:transparent; color:var(--text); font-size:13px; font-weight:500; transition:all .15s; white-space:nowrap; line-height:1; }
    .btn:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
    .btn:active:not(:disabled) { opacity:.8; transform:scale(.98); }
    .btn.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
    .btn.primary:hover:not(:disabled) { opacity:.88; color:var(--accent-fg); }
    .btn.ghost { border-color:transparent; }
    .btn.ghost:hover:not(:disabled) { background:var(--surface2); border-color:transparent; color:var(--text); }
    .btn.danger { border-color:#ef4444; color:#ef4444; }
    .btn.danger:hover:not(:disabled) { background:#ef444415; }
    .btn.sm { padding:5px 11px; font-size:12px; }
    .btn:disabled { opacity:.38; cursor:not-allowed; }

    .input { width:100%; padding:8px 12px; background:var(--surface2); border:1px solid var(--border); border-radius:var(--radius); color:var(--text); font-size:13px; outline:none; transition:border-color .15s; }
    .input:focus { border-color:var(--accent); }
    .input::placeholder { color:var(--muted); }

    .select { padding:8px 12px; background:var(--surface2); border:1px solid var(--border); border-radius:var(--radius); color:var(--text); font-size:13px; outline:none; appearance:none; cursor:pointer; transition:border-color .15s; }
    .select:focus { border-color:var(--accent); }

    .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg); padding:20px; }

    .nav-item { display:flex; align-items:center; gap:9px; padding:7px 10px; border-radius:8px; cursor:pointer; font-size:13px; color:var(--muted); transition:all .15s; border:none; background:transparent; width:100%; text-align:left; }
    .nav-item:hover { background:var(--surface2); color:var(--text); }
    .nav-item.active { background:var(--surface2); color:var(--accent); }

    .badge { display:inline-flex; align-items:center; gap:4px; padding:2px 9px; border-radius:99px; font-size:11px; font-weight:600; letter-spacing:.04em; }

    .toggle { position:relative; width:36px; height:20px; border-radius:99px; border:none; flex-shrink:0; transition:background .2s; }
    .toggle.on { background:var(--accent); }
    .toggle.off { background:var(--border); }
    .toggle::after { content:''; position:absolute; top:2px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .2s; }
    .toggle.on::after { left:18px; }
    .toggle.off::after { left:2px; }

    .tab { padding:7px 16px; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; border:none; background:transparent; color:var(--muted); transition:all .15s; }
    .tab:hover:not(.active) { color:var(--text); }
    .tab.active { background:var(--surface2); color:var(--accent); }

    .section-label { font-size:10px; font-weight:700; letter-spacing:.1em; color:var(--muted); text-transform:uppercase; }

    .modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.72); display:flex; align-items:center; justify-content:center; z-index:200; backdrop-filter:blur(6px); padding:16px; }
    .modal { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg); width:min(560px,100%); max-height:92vh; overflow-y:auto; }

    .dots span { animation:blink 1.2s infinite; display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--muted); }
    .dots span:nth-child(2){animation-delay:.2s}
    .dots span:nth-child(3){animation-delay:.4s}

    @keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}
    @keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
    @keyframes fadeOut{from{opacity:1}to{opacity:0}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes shimmer{0%{background-color:var(--surface2)}50%{background-color:var(--border)}100%{background-color:var(--surface2)}}
    .fade-in{animation:fadeIn .18s ease both}

    .sidebar { width:238px; background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column; flex-shrink:0; overflow:hidden; transition:width .2s; }
    .sidebar.closed { width:0; }

    .toast { padding:11px 16px; border-radius:10px; font-size:13px; font-weight:500; background:var(--surface); border:1px solid var(--border); color:var(--text); box-shadow:0 4px 20px rgba(0,0,0,.35); max-width:320px; pointer-events:auto; }
    .toast[data-type="success"] { border-color:#34d399; color:#34d399; }
    .toast[data-type="error"] { border-color:#f87171; color:#f87171; }
    .toast[data-type="info"] { border-color:var(--accent); color:var(--accent); }

    @media(max-width:768px){
      .sidebar { position:fixed; top:0; left:0; height:100vh; z-index:40; width:238px; transform:translateX(-100%); transition:transform .25s; }
      .sidebar.open { transform:none; }
      .hide-mobile { display:none !important; }
    }
    @media(min-width:769px){
      .sidebar { transform:none !important; }
      .sidebar.closed { width:0; overflow:hidden; }
    }
  `}</style>;
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const { settings, saveSettings, theme, loaded } = useApp();
  const [subjects, setSubjects] = useState([]);
  const [activeSubject, setActiveSubject] = useState(null);
  const [mode, setMode] = useState("home");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showNewSubject, setShowNewSubject] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  // #15 chat history keyed by subjectId+mode
  const [chatHistories, setChatHistories] = useState({});

  const getChatHistory = useCallback((subjectId, m) => chatHistories[`${subjectId}:${m}`] || [], [chatHistories]);
  const setChatHistory = useCallback((subjectId, m, msgs) => {
    setChatHistories(p => ({ ...p, [`${subjectId}:${m}`]: msgs }));
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width:768px)");
    const update = (e) => { setIsMobile(e.matches); if (e.matches) setSidebarOpen(false); };
    update(mq);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const refreshSubjects = useCallback(async () => {
    const list = await getSubjects();
    const withCounts = await Promise.all(list.map(async (s) => {
      const docs = await getDocsBySubject(s.id);
      return { ...s, docCount: docs.length };
    }));
    // pinned first, then by updatedAt
    setSubjects(withCounts.sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.updatedAt - a.updatedAt;
    }));
  }, []);

  useEffect(() => { if (loaded) refreshSubjects(); }, [loaded, refreshSubjects]);

  // Dynamic font loading
  useEffect(() => {
    const f = settings.font || "Outfit";
    const id = "dyn-font";
    let el = document.getElementById(id);
    if (!el) { el = document.createElement("link"); el.id = id; el.rel = "stylesheet"; document.head.appendChild(el); }
    el.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f)}:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap`;
  }, [settings.font]);

  // #40 dark/light quick toggle
  const toggleDarkLight = useCallback(() => {
    const isDark = DARK_THEMES.some(t => t.id === settings.colorTheme);
    const target = isDark
      ? (LIGHT_THEMES.find(t => t.id === settings.lastLightTheme) || LIGHT_THEMES[0])
      : (DARK_THEMES.find(t => t.id === settings.lastDarkTheme) || DARK_THEMES[0]);
    saveSettings({
      colorTheme: target.id,
      [isDark ? "lastDarkTheme" : "lastLightTheme"]: settings.colorTheme,
    });
  }, [settings, saveSettings]);

  const css = {
    "--accent": theme.accent, "--accent-fg": theme.accentFg,
    "--bg": theme.bg, "--surface": theme.surface, "--surface2": theme.surface2,
    "--border": theme.border, "--text": theme.text, "--muted": theme.muted,
    "--font": `'${settings.font||"Outfit"}', sans-serif`,
    "--radius": "9px", "--radius-lg": "14px",
  };

  const selectSubject = (s) => { setActiveSubject(s); setMode("home"); if (isMobile) setSidebarOpen(false); };
  const isDark = DARK_THEMES.some(t => t.id === settings.colorTheme);

  if (!loaded) return (
    <div style={{ height:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#0d0c17", color:"#e2e1f0" }}>
      <LoadingSpinner size={32} />
    </div>
  );

  return (
    <div style={{ ...css, background:"var(--bg)", color:"var(--text)", fontFamily:"var(--font)", height:"100vh", display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <GlobalStyles />
      <ToastContainer />

      <TopBar
        sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen}
        showSettings={() => setShowSettings(true)}
        activeSubject={activeSubject} mode={mode} setMode={setMode}
        isDark={isDark} toggleDarkLight={toggleDarkLight}
      />

      <div style={{ display:"flex", flex:1, overflow:"hidden", position:"relative" }}>
        {isMobile && sidebarOpen && (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.6)", zIndex:39 }} onClick={() => setSidebarOpen(false)} />
        )}

        <Sidebar
          open={sidebarOpen} isMobile={isMobile}
          subjects={subjects} activeSubject={activeSubject}
          selectSubject={selectSubject} mode={mode} setMode={setMode}
          setShowNewSubject={() => setShowNewSubject(true)}
          onTogglePin={async (s) => {
            const updated = { ...s, pinned: !s.pinned };
            await putSubject(updated);
            if (activeSubject?.id === s.id) setActiveSubject(updated);
            refreshSubjects();
          }}
        />

        <main style={{ flex:1, overflowY:"auto", display:"flex", flexDirection:"column" }}>
          <ErrorBoundary>
            {!activeSubject ? (
              <HomeScreen subjects={subjects} selectSubject={selectSubject} setShowNewSubject={() => setShowNewSubject(true)} />
            ) : mode === "home" ? (
              <SubjectHome
                subject={activeSubject} setMode={setMode} settings={settings}
                onSubjectUpdate={(s) => { setActiveSubject(s); refreshSubjects(); }}
                onSubjectDelete={() => { setActiveSubject(null); setMode("home"); refreshSubjects(); }}
              />
            ) : mode === "qa" ? (
              <QAMode
                subject={activeSubject} settings={settings}
                chatHistory={getChatHistory(activeSubject.id, "qa")}
                onChatHistoryChange={(msgs) => setChatHistory(activeSubject.id, "qa", msgs)}
              />
            ) : mode === "quiz" ? (
              <QuizMode subject={activeSubject} settings={settings} />
            ) : (
              <StudyMode
                subject={activeSubject} settings={settings}
                chatHistory={getChatHistory(activeSubject.id, "study")}
                onChatHistoryChange={(msgs) => setChatHistory(activeSubject.id, "study", msgs)}
              />
            )}
          </ErrorBoundary>
        </main>
      </div>

      {showSettings && (
        <SettingsModal
          settings={settings} saveSettings={saveSettings}
          onClose={() => setShowSettings(false)}
          fonts={FONTS} darkThemes={DARK_THEMES} lightThemes={LIGHT_THEMES}
        />
      )}
      {showNewSubject && (
        <NewSubjectModal
          settings={settings}
          onClose={() => setShowNewSubject(false)}
          onCreate={async ({ name, files }) => {
            const id = crypto.randomUUID();
            const now = Date.now();
            const s = { id, name, createdAt: now, updatedAt: now, docCount: files.length };
            await putSubject(s);
            if (files.length) await processDocuments(files, id, settings);
            await refreshSubjects();
            setActiveSubject(s);
            setMode("home");
            setShowNewSubject(false);
          }}
        />
      )}
    </div>
  );
}

// ── TopBar ────────────────────────────────────────────────────────────────────
// #29 title attr, #33 mode tabs in topbar, #40 dark/light toggle
function TopBar({ sidebarOpen, setSidebarOpen, showSettings, activeSubject, mode, setMode, isDark, toggleDarkLight }) {
  const MODES = [
    { id:"qa", icon:<Icon.QA size={14}/> },
    { id:"quiz", icon:<Icon.Quiz size={14}/> },
    { id:"study", icon:<Icon.Study size={14}/> },
  ];
  return (
    <header style={{ height:52, display:"flex", alignItems:"center", gap:10, padding:"0 14px", borderBottom:"1px solid var(--border)", background:"var(--surface)", flexShrink:0, zIndex:30 }}>
      <button className="btn ghost" style={{ padding:"6px 8px" }} onClick={() => setSidebarOpen(p => !p)}><Icon.Menu /></button>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <Icon.Logo />
        <span style={{ fontSize:15, fontWeight:700, letterSpacing:-.3 }}>StudyRAG</span>
      </div>
      {activeSubject && (
        <div style={{ display:"flex", alignItems:"center", gap:6, marginLeft:6, overflow:"hidden", flex:1 }}>
          <Icon.ChevronRight color="var(--muted)" />
          {/* #29 title on truncated subject name */}
          <button
            className="btn ghost"
            style={{ fontSize:13, color:"var(--muted)", padding:"4px 8px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:180 }}
            title={activeSubject.name}
            onClick={() => setMode("home")}
          >
            {activeSubject.name}
          </button>
          {/* #33 quick mode tabs in topbar */}
          {mode !== "home" && (
            <div style={{ display:"flex", gap:2, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:3 }}>
              {MODES.map(m => (
                <button
                  key={m.id}
                  title={{ qa:"Q&A", quiz:"Quiz / Test", study:"Study" }[m.id]}
                  onClick={() => setMode(m.id)}
                  style={{
                    display:"flex", alignItems:"center", justifyContent:"center",
                    width:28, height:24, border:"none", borderRadius:6,
                    background: mode === m.id ? "var(--accent)" : "transparent",
                    color: mode === m.id ? "var(--accent-fg)" : "var(--muted)",
                    cursor:"pointer", transition:"all .15s",
                  }}
                >
                  {m.icon}
                </button>
              ))}
            </div>
          )}
          {mode !== "home" && (
            <>
              <Icon.ChevronRight color="var(--muted)" />
              <span style={{ fontSize:13, color:"var(--accent)", fontWeight:600 }}>
                {{ qa:"Q&A", quiz:"Quiz", study:"Study" }[mode]}
              </span>
            </>
          )}
        </div>
      )}
      <div style={{ marginLeft:"auto", display:"flex", gap:4, alignItems:"center" }}>
        {/* #40 dark/light toggle */}
        <button className="btn ghost" style={{ padding:"6px 8px" }} onClick={toggleDarkLight} title={isDark ? "Switch to light mode" : "Switch to dark mode"}>
          {isDark ? <Icon.Sun size={16}/> : <Icon.Moon size={16}/>}
        </button>
        <button className="btn ghost" style={{ padding:"6px 8px" }} onClick={showSettings} title="Settings"><Icon.Settings /></button>
      </div>
    </header>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
// #28 search, #38 pin subjects
function Sidebar({ open, isMobile, subjects, activeSubject, selectSubject, mode, setMode, setShowNewSubject, onTogglePin }) {
  const [search, setSearch] = useState("");
  const cls = isMobile ? `sidebar ${open ? "open" : ""}` : `sidebar ${open ? "" : "closed"}`;
  const filtered = subjects.filter(s => s.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <aside className={cls}>
      <div style={{ padding:"12px 10px 6px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span className="section-label">Subjects</span>
        <button className="btn ghost" style={{ padding:"3px 8px", fontSize:18, lineHeight:1 }} onClick={setShowNewSubject} title="New subject">+</button>
      </div>
      {/* #28 search box */}
      <div style={{ padding:"0 10px 6px" }}>
        <div style={{ position:"relative" }}>
          <Icon.Search size={12} />
          <input
            className="input"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search subjects…"
            style={{ paddingLeft:28, fontSize:12, height:30 }}
          />
          <span style={{ position:"absolute", left:9, top:"50%", transform:"translateY(-50%)", color:"var(--muted)", pointerEvents:"none" }}>
            <Icon.Search size={12}/>
          </span>
        </div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"2px 8px 8px" }}>
        {filtered.length === 0 && <p style={{ fontSize:12, color:"var(--muted)", padding:"10px 10px" }}>{search ? "No matches." : "No subjects yet."}</p>}
        {filtered.map(s => {
          const color = subjectColor(s.id);
          const initials = subjectInitials(s.name);
          return (
            <div key={s.id} style={{ display:"flex", alignItems:"center", gap:4 }}>
              <button className={`nav-item ${activeSubject?.id === s.id && mode === "home" ? "active" : ""}`} style={{ flex:1 }} onClick={() => selectSubject(s)}>
                <div style={{ width:28, height:28, borderRadius:7, background: activeSubject?.id === s.id ? color : "var(--surface2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color: activeSubject?.id === s.id ? "#000" : color, flexShrink:0, border:`1.5px solid ${color}33` }}>
                  {initials}
                </div>
                <div style={{ flex:1, overflow:"hidden" }}>
                  <div style={{ fontSize:13, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.name}</div>
                  <div style={{ fontSize:11, color:"var(--muted)" }}>{s.docCount || 0} doc{s.docCount !== 1 ? "s" : ""}</div>
                </div>
              </button>
              {/* #38 pin button */}
              <button
                className="btn ghost"
                style={{ padding:"4px 5px", color: s.pinned ? "var(--accent)" : "var(--muted)", flexShrink:0 }}
                title={s.pinned ? "Unpin" : "Pin to top"}
                onClick={() => onTogglePin(s)}
              >
                <Icon.Pin filled={!!s.pinned} size={12}/>
              </button>
            </div>
          );
        })}
      </div>
      {activeSubject && (
        <div style={{ borderTop:"1px solid var(--border)", padding:"8px" }}>
          <div className="section-label" style={{ padding:"4px 10px 8px" }}>Modes</div>
          {[
            { id:"qa", label:"Q&A", icon:<Icon.QA /> },
            { id:"quiz", label:"Quiz / Test", icon:<Icon.Quiz /> },
            { id:"study", label:"Study", icon:<Icon.Study /> },
          ].map(m => (
            <button key={m.id} className={`nav-item ${mode === m.id ? "active" : ""}`} onClick={() => setMode(m.id)}>
              {m.icon}<span>{m.label}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

// ── Home Screen ───────────────────────────────────────────────────────────────
// #20 empty state, #21 last updated on cards
function HomeScreen({ subjects, selectSubject, setShowNewSubject }) {
  const timeAgo = (ts) => {
    if (!ts) return "";
    const diff = Date.now() - ts;
    const d = Math.floor(diff / 86400000);
    if (d === 0) return "today";
    if (d === 1) return "yesterday";
    if (d < 30) return `${d}d ago`;
    const m = Math.floor(d / 30);
    return `${m}mo ago`;
  };

  if (subjects.length === 0) {
    return (
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:20, padding:40 }}>
        <div style={{ fontSize:64 }}>📚</div>
        <div style={{ textAlign:"center" }}>
          <h2 style={{ fontSize:22, fontWeight:700, marginBottom:8 }}>Welcome to StudyRAG</h2>
          <p style={{ fontSize:14, color:"var(--muted)", marginBottom:24, maxWidth:380, lineHeight:1.7 }}>
            Upload your study materials and chat with them, take AI-generated quizzes, and read side-by-side with an AI tutor.
          </p>
          <button className="btn primary" style={{ padding:"12px 28px", fontSize:15 }} onClick={setShowNewSubject}>
            + Create your first subject
          </button>
        </div>
        <div style={{ display:"flex", gap:24, marginTop:8, flexWrap:"wrap", justifyContent:"center" }}>
          {[["🔍","Q&A Mode","Ask anything from your docs"],["📝","Quiz Mode","Auto-generated tests"],["📖","Study Mode","Read + chat side by side"]].map(([icon, title, desc]) => (
            <div key={title} style={{ textAlign:"center", maxWidth:140 }}>
              <div style={{ fontSize:28, marginBottom:6 }}>{icon}</div>
              <div style={{ fontSize:13, fontWeight:600, marginBottom:3 }}>{title}</div>
              <div style={{ fontSize:12, color:"var(--muted)" }}>{desc}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding:"40px 36px", maxWidth:820, margin:"0 auto", width:"100%" }}>
      <h1 style={{ fontSize:28, fontWeight:700, letterSpacing:-.5, marginBottom:6 }}>Welcome back.</h1>
      <p style={{ color:"var(--muted)", fontSize:14, marginBottom:32 }}>Pick a subject to continue, or create a new one.</p>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(190px,1fr))", gap:12 }}>
        {subjects.map(s => {
          const color = subjectColor(s.id);
          const initials = subjectInitials(s.name);
          return (
            <button key={s.id} className="card" style={{ textAlign:"left", cursor:"pointer", transition:"border-color .15s" }}
              onClick={() => selectSubject(s)}
              onMouseEnter={e => e.currentTarget.style.borderColor = color}
              onMouseLeave={e => e.currentTarget.style.borderColor = "var(--border)"}
            >
              <div style={{ width:42, height:42, borderRadius:10, background:`${color}22`, border:`1.5px solid ${color}44`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, fontWeight:700, color, marginBottom:14 }}>
                {initials}
              </div>
              <div style={{ fontWeight:600, fontSize:14, marginBottom:3, display:"flex", alignItems:"center", gap:6 }}>
                {s.name}
                {s.pinned && <Icon.Pin filled size={11} style={{ color:"var(--accent)" }}/>}
              </div>
              <div style={{ fontSize:12, color:"var(--muted)" }}>{s.docCount || 0} doc{s.docCount !== 1 ? "s" : ""}</div>
              {/* #21 last updated */}
              {s.updatedAt && <div style={{ fontSize:11, color:"var(--muted)", marginTop:4 }}>{timeAgo(s.updatedAt)}</div>}
            </button>
          );
        })}
        <button className="card" style={{ cursor:"pointer", display:"flex", alignItems:"center", gap:10, border:"1.5px dashed var(--border)", background:"transparent", color:"var(--muted)", transition:"all .15s" }}
          onClick={setShowNewSubject}
          onMouseEnter={e => { e.currentTarget.style.borderColor="var(--accent)"; e.currentTarget.style.color="var(--accent)"; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor="var(--border)"; e.currentTarget.style.color="var(--muted)"; }}
        >
          <span style={{ fontSize:22, lineHeight:1 }}>+</span>
          <span style={{ fontSize:14 }}>New subject</span>
        </button>
      </div>
    </div>
  );
}

// ── New Subject Modal ─────────────────────────────────────────────────────────
function NewSubjectModal({ onClose, onCreate, settings }) {
  const [name, setName] = useState("");
  const [files, setFiles] = useState([]);
  const [namingMode, setNamingMode] = useState("ai");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef();

  const addFiles = (fileList) => setFiles(p => [...p, ...Array.from(fileList)]);

  const handleCreate = async () => {
    setLoading(true);
    try {
      let finalName = name.trim();
      if (!finalName && files.length && (settings.apiKeys||[]).some(k=>k.key) && namingMode === "ai") {
        setProgress("Asking Gemini to name your subject…");
        try { finalName = await nameSubject(files.map(f => f.name), settings); }
        catch { finalName = files[0].name.replace(/\.[^.]+$/, ""); }
      }
      if (!finalName) finalName = "Untitled Subject";
      setProgress("Creating subject…");
      await onCreate({ name: finalName, files });
    } catch (e) { toast("Error: " + e.message, "error"); setLoading(false); }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal fade-in" style={{ padding:28 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <h2 style={{ fontSize:18, fontWeight:700 }}>New Subject</h2>
          <button className="btn ghost" style={{ padding:"4px 8px" }} onClick={onClose}>×</button>
        </div>
        <div style={{ marginBottom:16 }}>
          <label style={{ fontSize:12, color:"var(--muted)", display:"block", marginBottom:6 }}>Subject name</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder={(settings.apiKeys||[]).some(k=>k.key) ? "Leave blank to let Gemini name it from files…" : "e.g. Organic Chemistry"} autoFocus onKeyDown={e => e.key === "Enter" && !loading && handleCreate()} />
          {(settings.apiKeys||[]).some(k=>k.key) && (
            <div style={{ display:"flex", gap:16, marginTop:8 }}>
              {["ai","manual"].map(m => (
                <label key={m} style={{ display:"flex", alignItems:"center", gap:6, fontSize:12, color:"var(--muted)", cursor:"pointer" }}>
                  <input type="radio" name="naming" checked={namingMode===m} onChange={() => setNamingMode(m)} style={{ accentColor:"var(--accent)" }} />
                  {m === "ai" ? "Auto-name with Gemini" : "Name manually"}
                </label>
              ))}
            </div>
          )}
        </div>
        {/* #27 drag-and-drop in modal */}
        <div style={{ marginBottom:20 }}>
          <label style={{ fontSize:12, color:"var(--muted)", display:"block", marginBottom:6 }}>Documents <span style={{ color:"var(--muted)" }}>(optional — add more later)</span></label>
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
            style={{ border:`1.5px dashed ${dragging ? "var(--accent)" : "var(--border)"}`, borderRadius:10, padding:20, textAlign:"center", background: dragging ? "var(--surface2)" : "transparent", transition:"all .15s", cursor:"pointer" }}
            onClick={() => fileRef.current?.click()}
          >
            <Icon.Upload />
            <p style={{ fontSize:13, color:"var(--muted)", marginTop:8 }}>Drop files here or click to browse</p>
            <p style={{ fontSize:11, color:"var(--muted)", marginTop:4 }}>PDF, DOCX, TXT, images (no PPTX)</p>
          </div>
          <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.doc,.txt,.md,.png,.jpg,.jpeg,.webp" style={{ display:"none" }}
            onChange={e => { addFiles(e.target.files); e.target.value = ""; }} />
          {files.length > 0 && (
            <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:4, maxHeight:200, overflowY:"auto" }}>
              {files.map((f, i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px", background:"var(--surface2)", borderRadius:8, fontSize:13 }}>
                  <DocTypeIcon type={f.name.split(".").pop()} />
                  <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.name}</span>
                  <span style={{ fontSize:11, color:"var(--muted)", flexShrink:0 }}>{(f.size/1024).toFixed(0)} KB</span>
                  <button className="btn ghost" style={{ padding:"2px 6px", color:"var(--muted)", fontSize:14 }} onClick={() => setFiles(p => p.filter((_,j) => j!==i))}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
        {progress && <p style={{ fontSize:12, color:"var(--accent)", marginBottom:12, display:"flex", alignItems:"center", gap:8 }}><LoadingSpinner size={12} />{progress}</p>}
        <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
          <button className="btn" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn primary" onClick={handleCreate} disabled={loading}>
            {loading ? <><LoadingSpinner size={13} />Creating…</> : "Create Subject"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── API Key Manager ───────────────────────────────────────────────────────────
function ApiKeyManager({ keys, activeIdx, onChange }) {
  const [newKey,   setNewKey]   = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [visible,  setVisible]  = useState({});

  const add = () => {
    const k = newKey.trim();
    if (!k) return;
    const id  = crypto.randomUUID();
    const lbl = newLabel.trim() || `Key ${keys.length + 1}`;
    onChange([...keys, { id, key:k, label:lbl }], activeIdx);
    setNewKey(""); setNewLabel("");
  };
  const remove = (id) => {
    const next = keys.filter(k => k.id !== id);
    onChange(next, Math.min(activeIdx, Math.max(0, next.length - 1)));
    setVisible(p => { const v={...p}; delete v[id]; return v; });
  };
  const moveUp   = (i) => { if (i===0) return; const a=[...keys]; [a[i-1],a[i]]=[a[i],a[i-1]]; onChange(a, activeIdx); };
  const moveDown = (i) => { if (i===keys.length-1) return; const a=[...keys]; [a[i],a[i+1]]=[a[i+1],a[i]]; onChange(a, activeIdx); };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <label style={{ fontSize:12, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:".06em" }}>API Keys</label>
        {/* #37 proper rel */}
        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style={{ fontSize:11, color:"var(--accent)" }}>Get a free key ↗</a>
      </div>
      {keys.length === 0 && <p style={{ fontSize:12, color:"var(--muted)", padding:"10px 0" }}>No keys yet. Add one below.</p>}
      <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:12 }}>
        {keys.map((k, i) => (
          <div key={k.id} style={{ display:"flex", alignItems:"center", gap:6, padding:"9px 12px", background:"var(--surface2)", border:`1.5px solid ${i === activeIdx ? "var(--accent)" : "var(--border)"}`, borderRadius:9 }}>
            <button title={i === activeIdx ? "Active key" : "Set as active"} onClick={() => onChange(keys, i)} style={{ width:10, height:10, borderRadius:"50%", border:`2px solid ${i===activeIdx?"var(--accent)":"var(--border)"}`, background:i===activeIdx?"var(--accent)":"transparent", flexShrink:0, cursor:"pointer", padding:0 }} />
            <div style={{ flex:1, overflow:"hidden" }}>
              <div style={{ fontSize:12, fontWeight:600, color:"var(--text)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {k.label}{i === activeIdx && <span style={{ marginLeft:6, fontSize:10, color:"var(--accent)", fontWeight:400 }}>active</span>}
              </div>
              <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"monospace", marginTop:1 }}>
                {visible[k.id] ? k.key : k.key.slice(0,8) + "••••••••" + k.key.slice(-4)}
              </div>
            </div>
            <button className="btn ghost" style={{ padding:"3px 7px", fontSize:11, flexShrink:0 }} onClick={() => setVisible(p => ({ ...p, [k.id]: !p[k.id] }))}>{visible[k.id] ? "Hide" : "Show"}</button>
            <button className="btn ghost" style={{ padding:"3px 6px", fontSize:13, flexShrink:0 }} onClick={() => moveUp(i)} disabled={i===0}>↑</button>
            <button className="btn ghost" style={{ padding:"3px 6px", fontSize:13, flexShrink:0 }} onClick={() => moveDown(i)} disabled={i===keys.length-1}>↓</button>
            <button className="btn ghost" style={{ padding:"3px 6px", color:"#f87171", flexShrink:0 }} onClick={() => remove(k.id)}>×</button>
          </div>
        ))}
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        <input className="input" type="password" value={newKey} onChange={e => setNewKey(e.target.value)} onKeyDown={e => e.key==="Enter"&&add()} placeholder="Paste API key: AIzaSy…" />
        <div style={{ display:"flex", gap:6 }}>
          <input className="input" value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={e => e.key==="Enter"&&add()} placeholder="Label (optional)" />
          <button className="btn primary" onClick={add} disabled={!newKey.trim()} style={{ flexShrink:0, padding:"8px 16px" }}>Add</button>
        </div>
      </div>
      <p style={{ fontSize:11, color:"var(--muted)", marginTop:8, lineHeight:1.6 }}>
        Keys are tried in order — if the active key hits a rate limit or fails, the next one is used automatically. Stored only in your browser.
      </p>
    </div>
  );
}

// ── Settings Modal ────────────────────────────────────────────────────────────
// #10 validation, #30 unsaved changes warning
function SettingsModal({ settings, saveSettings, onClose, fonts, darkThemes, lightThemes }) {
  const [tab, setTab] = useState("general");
  const [local, setLocal] = useState({ ...settings });
  const [dirty, setDirty] = useState(false);
  const L = patch => { setLocal(p => ({ ...p, ...patch })); setDirty(true); };

  const handleClose = () => {
    if (dirty) {
      if (!window.confirm("You have unsaved changes. Discard them?")) return;
    }
    onClose();
  };

  const handleSave = () => {
    // #10 validate
    const validated = {
      ...local,
      chunkSize:    Math.max(64, Math.min(2048, local.chunkSize || 512)),
      chunkOverlap: Math.max(0,  Math.min(256,  local.chunkOverlap || 64)),
      topK:         Math.max(1,  Math.min(20,   local.topK || 5)),
      temperature:  Math.max(0,  Math.min(1,    local.temperature ?? 0.2)),
    };
    saveSettings(validated);
    setDirty(false);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && handleClose()}>
      <div className="modal fade-in">
        <div style={{ padding:"22px 24px 0" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <h2 style={{ fontSize:18, fontWeight:700 }}>Settings {dirty && <span style={{ fontSize:12, color:"#fb923c", fontWeight:400, marginLeft:8 }}>● unsaved</span>}</h2>
            <button className="btn ghost" style={{ padding:"4px 8px" }} onClick={handleClose}>×</button>
          </div>
          <div style={{ display:"flex", gap:2, borderBottom:"1px solid var(--border)" }}>
            {["general","appearance","rag"].map(t => (
              <button key={t} className={`tab ${tab===t?"active":""}`} style={{ borderRadius:"8px 8px 0 0" }} onClick={() => setTab(t)}>
                {{ general:"General", appearance:"Appearance", rag:"RAG / AI" }[t]}
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding:"22px 24px" }}>
          {tab === "general" && (
            <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
              <ApiKeyManager keys={local.apiKeys||[]} activeIdx={local.activeKeyIndex||0}
                onChange={(keys,idx) => L({ apiKeys:keys, activeKeyIndex:idx })} />
              <div>
                <label style={{ fontSize:12, color:"var(--muted)", display:"block", marginBottom:6 }}>Gemini Model</label>
                <select className="select" style={{ width:"100%" }} value={local.model||"gemini-2.5-flash-lite"} onChange={e => L({ model:e.target.value })}>
                  <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite — fastest, free-tier friendly ✓ recommended</option>
                  <option value="gemini-2.5-flash">gemini-2.5-flash — smarter, slightly slower</option>
                  <option value="gemini-2.5-pro">gemini-2.5-pro — most capable, daily limit applies</option>
                </select>
              </div>
            </div>
          )}
          {tab === "appearance" && (
            <div style={{ display:"flex", flexDirection:"column", gap:22 }}>
              <div>
                <div className="section-label" style={{ marginBottom:10 }}>Dark Themes</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(80px,1fr))", gap:8 }}>
                  {darkThemes.map(t => (
                    <button key={t.id} onClick={() => L({ colorTheme:t.id })} style={{ padding:"10px 6px", background:t.bg, border:`2px solid ${local.colorTheme===t.id ? t.accent : t.border}`, borderRadius:10, cursor:"pointer", display:"flex", flexDirection:"column", gap:5, alignItems:"center" }}>
                      <div style={{ display:"flex", gap:3 }}>
                        <div style={{ width:12, height:12, borderRadius:"50%", background:t.accent }} />
                        <div style={{ width:12, height:12, borderRadius:"50%", background:t.surface2 }} />
                      </div>
                      <span style={{ fontSize:10, color:t.accent, fontWeight:local.colorTheme===t.id?700:400 }}>{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="section-label" style={{ marginBottom:10 }}>Light Themes</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(80px,1fr))", gap:8 }}>
                  {lightThemes.map(t => (
                    <button key={t.id} onClick={() => L({ colorTheme:t.id })} style={{ padding:"10px 6px", background:t.surface, border:`2px solid ${local.colorTheme===t.id ? t.accent : t.border}`, borderRadius:10, cursor:"pointer", display:"flex", flexDirection:"column", gap:5, alignItems:"center" }}>
                      <div style={{ display:"flex", gap:3 }}>
                        <div style={{ width:12, height:12, borderRadius:"50%", background:t.accent }} />
                        <div style={{ width:12, height:12, borderRadius:"50%", background:t.surface2 }} />
                      </div>
                      <span style={{ fontSize:10, color:t.accent, fontWeight:local.colorTheme===t.id?700:400 }}>{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label style={{ fontSize:12, color:"var(--muted)", display:"block", marginBottom:8 }}>Font</label>
                <select className="select" style={{ width:"100%" }} value={local.font||"Outfit"} onChange={e => L({ font:e.target.value })}>
                  {fonts.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <p style={{ fontSize:15, marginTop:10, fontFamily:`'${local.font||"Outfit"}', sans-serif`, color:"var(--muted)", fontStyle:"italic", lineHeight:1.6 }}>
                  The quick brown fox jumps over the lazy dog. 0123456789
                </p>
              </div>
            </div>
          )}
          {tab === "rag" && (
            <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
              <SettingRow label="Chunk size (words)" hint="Words per document chunk. Smaller = more precise retrieval.">
                <input type="number" className="input" style={{ width:110 }} value={local.chunkSize||512} min={64} max={2048} step={32} onChange={e => L({ chunkSize:+e.target.value })} />
              </SettingRow>
              <SettingRow label="Chunk overlap (words)" hint="Words shared between adjacent chunks to avoid cutting off context.">
                <input type="number" className="input" style={{ width:110 }} value={local.chunkOverlap||64} min={0} max={256} step={16} onChange={e => L({ chunkOverlap:+e.target.value })} />
              </SettingRow>
              <SettingRow label="Top-K chunks retrieved" hint="How many chunks are fed to Gemini per query.">
                <input type="number" className="input" style={{ width:90 }} value={local.topK||5} min={1} max={20} onChange={e => L({ topK:+e.target.value })} />
              </SettingRow>
              <SettingRow label={`Temperature: ${(local.temperature??0.2).toFixed(2)}`} hint="0 = factual. 1 = creative.">
                <input type="range" min={0} max={1} step={0.05} value={local.temperature??0.2} onChange={e => L({ temperature:+e.target.value })} style={{ width:160, accentColor:"var(--accent)" }} />
              </SettingRow>
              <SettingRow label="Embedding / chunking strategy">
                <select className="select" value={local.embedStrategy||"semantic"} onChange={e => L({ embedStrategy:e.target.value })}>
                  <option value="semantic">Semantic (paragraph-aware)</option>
                  <option value="fixed">Fixed-size (word count)</option>
                  <option value="page">Page-based (best for PDFs)</option>
                </select>
              </SettingRow>
              <div style={{ padding:"10px 14px", background:"var(--surface2)", borderRadius:8, fontSize:12, color:"var(--muted)", lineHeight:1.7 }}>
                ⚠ Changing chunk or embed settings only affects newly added documents. Use "Re-process" on the subject page to update existing docs.
              </div>
            </div>
          )}
        </div>
        <div style={{ padding:"0 24px 22px", display:"flex", justifyContent:"flex-end", gap:8 }}>
          <button className="btn" onClick={handleClose}>Cancel</button>
          <button className="btn primary" onClick={handleSave}>Save Settings</button>
        </div>
      </div>
    </div>
  );
}

function SettingRow({ label, hint, children }) {
  return (
    <div>
      <label style={{ fontSize:12, color:"var(--muted)", display:"block", marginBottom:6 }}>{label}</label>
      {children}
      {hint && <p style={{ fontSize:11, color:"var(--muted)", marginTop:5, lineHeight:1.6 }}>{hint}</p>}
    </div>
  );
}
