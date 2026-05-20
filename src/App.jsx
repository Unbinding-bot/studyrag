import { useState, useEffect, useRef, useCallback } from "react";
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

// ── Document processing ───────────────────────────────────────────────────────
export async function processDocuments(files, subjectId, settings, onProgress) {
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    onProgress?.(`Extracting text: ${file.name}…`, i, files.length);
    const docId = crypto.randomUUID();
    // Store file as base64 for later viewing
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

export function keywordSearch(query, chunks, k = 5) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  return chunks
    .map((c) => {
      const t = c.text.toLowerCase();
      const score = words.reduce((a, w) => a + (t.split(w).length - 1), 0);
      return { ...c, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
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
};

// ── Reusable UI primitives ────────────────────────────────────────────────────
export function LoadingSpinner({ size = 20 }) {
  return <div style={{ width: size, height: size, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--accent)", animation: "spin .7s linear infinite", flexShrink: 0 }} />;
}

export function Toggle({ value, onChange, label }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      {label && <span style={{ fontSize: 13, color: "var(--text)" }}>{label}</span>}
      <button className={`toggle ${value ? "on" : "off"}`} onClick={() => onChange(!value)} aria-label={label} />
    </div>
  );
}

export function DocTypeIcon({ type, size = 14 }) {
  const colors = { pdf:"#f87171", docx:"#60a5fa", doc:"#60a5fa", txt:"#9ca3af", md:"#9ca3af", pptx:"#fb923c", png:"#4ade80", jpg:"#4ade80", jpeg:"#4ade80", webp:"#34d399", default:"#9ca3af" };
  const c = colors[(type||"").toLowerCase()] || colors.default;
  return <div style={{ width:size, height:size, borderRadius:3, background:c, display:"flex", alignItems:"center", justifyContent:"center", fontSize:6, fontWeight:900, color:"#fff", flexShrink:0, letterSpacing:-.5 }}>{(type||"?").toUpperCase().slice(0,3)}</div>;
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
    @keyframes spin{to{transform:rotate(360deg)}}
    .fade-in{animation:fadeIn .18s ease both}

    .sidebar { width:238px; background:var(--surface); border-right:1px solid var(--border); display:flex; flex-direction:column; flex-shrink:0; overflow:hidden; transition:width .2s; }
    .sidebar.closed { width:0; }

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

  useEffect(() => {
    const mq = window.matchMedia("(max-width:768px)");
    const update = (e) => { setIsMobile(e.matches); if (e.matches) setSidebarOpen(false); };
    update(mq);
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const refreshSubjects = useCallback(async () => {
    const list = await getSubjects();
    // Attach doc counts
    const withCounts = await Promise.all(list.map(async (s) => {
      const docs = await getDocsBySubject(s.id);
      return { ...s, docCount: docs.length };
    }));
    setSubjects(withCounts.sort((a, b) => b.updatedAt - a.updatedAt));
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

  const css = {
    "--accent": theme.accent, "--accent-fg": theme.accentFg,
    "--bg": theme.bg, "--surface": theme.surface, "--surface2": theme.surface2,
    "--border": theme.border, "--text": theme.text, "--muted": theme.muted,
    "--font": `'${settings.font||"Outfit"}', sans-serif`,
    "--radius": "9px", "--radius-lg": "14px",
  };

  const selectSubject = (s) => { setActiveSubject(s); setMode("home"); if (isMobile) setSidebarOpen(false); };

  if (!loaded) return (
    <div style={{ height:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#0d0c17", color:"#e2e1f0" }}>
      <LoadingSpinner size={32} />
    </div>
  );

  return (
    <div style={{ ...css, background:"var(--bg)", color:"var(--text)", fontFamily:"var(--font)", height:"100vh", display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <GlobalStyles />

      <TopBar
        sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen}
        showSettings={() => setShowSettings(true)}
        activeSubject={activeSubject} mode={mode} setMode={setMode}
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
        />

        <main style={{ flex:1, overflowY:"auto", display:"flex", flexDirection:"column" }}>
          {!activeSubject ? (
            <HomeScreen subjects={subjects} selectSubject={selectSubject} setShowNewSubject={() => setShowNewSubject(true)} />
          ) : mode === "home" ? (
            <SubjectHome
              subject={activeSubject} setMode={setMode} settings={settings}
              onSubjectUpdate={(s) => { setActiveSubject(s); refreshSubjects(); }}
              onSubjectDelete={() => { setActiveSubject(null); setMode("home"); refreshSubjects(); }}
            />
          ) : mode === "qa" ? (
            <QAMode subject={activeSubject} settings={settings} />
          ) : mode === "quiz" ? (
            <QuizMode subject={activeSubject} settings={settings} />
          ) : (
            <StudyMode subject={activeSubject} settings={settings} />
          )}
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
function TopBar({ sidebarOpen, setSidebarOpen, showSettings, activeSubject, mode, setMode }) {
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
          <button className="btn ghost" style={{ fontSize:13, color:"var(--muted)", padding:"4px 8px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:180 }} onClick={() => setMode("home")}>
            {activeSubject.name}
          </button>
          {mode !== "home" && <>
            <Icon.ChevronRight color="var(--muted)" />
            <span style={{ fontSize:13, color:"var(--accent)", fontWeight:600 }}>{{ qa:"Q&A", quiz:"Quiz", study:"Study" }[mode]}</span>
          </>}
        </div>
      )}
      <div style={{ marginLeft:"auto" }}>
        <button className="btn ghost" style={{ padding:"6px 8px" }} onClick={showSettings} title="Settings"><Icon.Settings /></button>
      </div>
    </header>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function Sidebar({ open, isMobile, subjects, activeSubject, selectSubject, mode, setMode, setShowNewSubject }) {
  const cls = isMobile ? `sidebar ${open ? "open" : ""}` : `sidebar ${open ? "" : "closed"}`;
  return (
    <aside className={cls}>
      <div style={{ padding:"12px 10px 6px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span className="section-label">Subjects</span>
        <button className="btn ghost" style={{ padding:"3px 8px", fontSize:18, lineHeight:1 }} onClick={setShowNewSubject} title="New subject">+</button>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"2px 8px 8px" }}>
        {subjects.length === 0 && <p style={{ fontSize:12, color:"var(--muted)", padding:"10px 10px" }}>No subjects yet.</p>}
        {subjects.map(s => (
          <button key={s.id} className={`nav-item ${activeSubject?.id === s.id && mode === "home" ? "active" : ""}`} onClick={() => selectSubject(s)}>
            <div style={{ width:28, height:28, borderRadius:7, background: activeSubject?.id === s.id ? "var(--accent)" : "var(--surface2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color: activeSubject?.id === s.id ? "var(--accent-fg)" : "var(--muted)", flexShrink:0 }}>
              {s.name.slice(0,2).toUpperCase()}
            </div>
            <div style={{ flex:1, overflow:"hidden" }}>
              <div style={{ fontSize:13, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.name}</div>
              <div style={{ fontSize:11, color:"var(--muted)" }}>{s.docCount || 0} doc{s.docCount !== 1 ? "s" : ""}</div>
            </div>
          </button>
        ))}
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
function HomeScreen({ subjects, selectSubject, setShowNewSubject }) {
  return (
    <div style={{ padding:"40px 36px", maxWidth:820, margin:"0 auto", width:"100%" }}>
      <h1 style={{ fontSize:28, fontWeight:700, letterSpacing:-.5, marginBottom:6 }}>Welcome back.</h1>
      <p style={{ color:"var(--muted)", fontSize:14, marginBottom:32 }}>Pick a subject to continue, or create a new one.</p>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(190px,1fr))", gap:12 }}>
        {subjects.map(s => (
          <button key={s.id} className="card" style={{ textAlign:"left", cursor:"pointer", transition:"border-color .15s" }}
            onClick={() => selectSubject(s)}
            onMouseEnter={e => e.currentTarget.style.borderColor = "var(--accent)"}
            onMouseLeave={e => e.currentTarget.style.borderColor = "var(--border)"}
          >
            <div style={{ width:42, height:42, borderRadius:10, background:"var(--surface2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, fontWeight:700, color:"var(--accent)", marginBottom:14 }}>
              {s.name.slice(0,2).toUpperCase()}
            </div>
            <div style={{ fontWeight:600, fontSize:14, marginBottom:4 }}>{s.name}</div>
            <div style={{ fontSize:12, color:"var(--muted)" }}>{s.docCount || 0} document{s.docCount !== 1 ? "s" : ""}</div>
          </button>
        ))}
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
  const fileRef = useRef();

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
    } catch (e) { alert("Error: " + e.message); setLoading(false); }
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
        <div style={{ marginBottom:20 }}>
          <label style={{ fontSize:12, color:"var(--muted)", display:"block", marginBottom:6 }}>Documents <span style={{ color:"var(--muted)" }}>(optional — add more later)</span></label>
          <button className="btn" onClick={() => fileRef.current?.click()} style={{ width:"100%", justifyContent:"center", borderStyle:"dashed", padding:"16px" }}>
            <Icon.Upload /> Add files (PDF, DOCX, TXT, images, PPTX)
          </button>
          <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.doc,.txt,.md,.png,.jpg,.jpeg,.webp,.pptx" style={{ display:"none" }}
            onChange={e => setFiles(p => [...p, ...Array.from(e.target.files)])} />
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
  const [visible,  setVisible]  = useState({});   // id → bool

  const add = () => {
    const k = newKey.trim();
    if (!k) return;
    const id  = crypto.randomUUID();
    const lbl = newLabel.trim() || `Key ${keys.length + 1}`;
    const next = [...keys, { id, key:k, label:lbl }];
    onChange(next, activeIdx);
    setNewKey("");
    setNewLabel("");
  };

  const remove = (id) => {
    const next = keys.filter(k => k.id !== id);
    const newActive = Math.min(activeIdx, Math.max(0, next.length - 1));
    onChange(next, newActive);
    setVisible(p => { const v = {...p}; delete v[id]; return v; });
  };

  const moveUp   = (i) => { if (i===0) return; const a=[...keys]; [a[i-1],a[i]]=[a[i],a[i-1]]; onChange(a, activeIdx); };
  const moveDown = (i) => { if (i===keys.length-1) return; const a=[...keys]; [a[i],a[i+1]]=[a[i+1],a[i]]; onChange(a, activeIdx); };
  const setActive = (i) => onChange(keys, i);

  const toggleVisible = (id) => setVisible(p => ({ ...p, [id]: !p[id] }));

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
        <label style={{ fontSize:12, color:"var(--muted)", fontWeight:600, textTransform:"uppercase", letterSpacing:".06em" }}>
          API Keys
        </label>
        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style={{ fontSize:11, color:"var(--accent)" }}>
          Get a free key ↗
        </a>
      </div>

      {/* Key list */}
      {keys.length === 0 && (
        <p style={{ fontSize:12, color:"var(--muted)", padding:"10px 0" }}>No keys yet. Add one below.</p>
      )}
      <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:12 }}>
        {keys.map((k, i) => (
          <div key={k.id} style={{
            display:"flex", alignItems:"center", gap:6,
            padding:"9px 12px",
            background: i === activeIdx ? "var(--surface2)" : "var(--surface2)",
            border: `1.5px solid ${i === activeIdx ? "var(--accent)" : "var(--border)"}`,
            borderRadius:9,
          }}>
            {/* Active indicator */}
            <button
              title={i === activeIdx ? "Active key" : "Set as active"}
              onClick={() => setActive(i)}
              style={{ width:10, height:10, borderRadius:"50%", border:`2px solid ${i===activeIdx?"var(--accent)":"var(--border)"}`, background:i===activeIdx?"var(--accent)":"transparent", flexShrink:0, cursor:"pointer", padding:0 }}
            />

            {/* Label + masked key */}
            <div style={{ flex:1, overflow:"hidden" }}>
              <div style={{ fontSize:12, fontWeight:600, color:"var(--text)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                {k.label}
                {i === activeIdx && <span style={{ marginLeft:6, fontSize:10, color:"var(--accent)", fontWeight:400 }}>active</span>}
              </div>
              <div style={{ fontSize:11, color:"var(--muted)", fontFamily:"monospace", marginTop:1 }}>
                {visible[k.id] ? k.key : k.key.slice(0,8) + "••••••••" + k.key.slice(-4)}
              </div>
            </div>

            {/* Show/hide toggle */}
            <button className="btn ghost" style={{ padding:"3px 7px", fontSize:11, flexShrink:0 }} onClick={() => toggleVisible(k.id)}>
              {visible[k.id] ? "Hide" : "Show"}
            </button>

            {/* Reorder */}
            <button className="btn ghost" style={{ padding:"3px 6px", fontSize:13, flexShrink:0 }} onClick={() => moveUp(i)} disabled={i===0} title="Move up">↑</button>
            <button className="btn ghost" style={{ padding:"3px 6px", fontSize:13, flexShrink:0 }} onClick={() => moveDown(i)} disabled={i===keys.length-1} title="Move down">↓</button>

            {/* Remove */}
            <button className="btn ghost" style={{ padding:"3px 6px", color:"#f87171", flexShrink:0 }} onClick={() => remove(k.id)} title="Remove key">×</button>
          </div>
        ))}
      </div>

      {/* Add new key */}
      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
        <input
          className="input"
          type="password"
          value={newKey}
          onChange={e => setNewKey(e.target.value)}
          onKeyDown={e => e.key === "Enter" && add()}
          placeholder="Paste API key: AIzaSy…"
        />
        <div style={{ display:"flex", gap:6 }}>
          <input
            className="input"
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => e.key === "Enter" && add()}
            placeholder="Label (optional, e.g. Personal, Backup)"
          />
          <button className="btn primary" onClick={add} disabled={!newKey.trim()} style={{ flexShrink:0, padding:"8px 16px" }}>
            Add
          </button>
        </div>
      </div>

      <p style={{ fontSize:11, color:"var(--muted)", marginTop:8, lineHeight:1.6 }}>
        Keys are tried in order — if the active key hits a rate limit or fails, the next one is used automatically.
        Stored only in your browser. Never sent anywhere but Google.
      </p>
    </div>
  );
}

// ── Settings Modal ────────────────────────────────────────────────────────────
function SettingsModal({ settings, saveSettings, onClose, fonts, darkThemes, lightThemes }) {
  const [tab, setTab] = useState("general");
  const [local, setLocal] = useState({ ...settings });
  const L = patch => setLocal(p => ({ ...p, ...patch }));

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal fade-in">
        <div style={{ padding:"22px 24px 0" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
            <h2 style={{ fontSize:18, fontWeight:700 }}>Settings</h2>
            <button className="btn ghost" style={{ padding:"4px 8px" }} onClick={onClose}>×</button>
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
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(88px,1fr))", gap:8 }}>
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
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(88px,1fr))", gap:8 }}>
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
                <label style={{ fontSize:12, color:"var(--muted)", display:"block", marginBottom:8 }}>Font — affects all text in the app</label>
                <select className="select" style={{ width:"100%" }} value={local.font||"Outfit"} onChange={e => L({ font:e.target.value })}>
                  {fonts.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <p style={{ fontSize:15, marginTop:10, fontFamily:`'${local.font||"Outfit"}', sans-serif`, color:"var(--muted)", fontStyle:"italic", lineHeight:1.6 }}>
                  The quick brown fox jumps over the lazy dog. 0123456789 — ABCDEFG
                </p>
              </div>
            </div>
          )}
          {tab === "rag" && (
            <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
              <SettingRow label="Chunk size (words)" hint="Words per document chunk. Smaller = more precise retrieval. Larger = richer context per chunk.">
                <input type="number" className="input" style={{ width:110 }} value={local.chunkSize||512} min={64} max={2048} step={32} onChange={e => L({ chunkSize:+e.target.value })} />
              </SettingRow>
              <SettingRow label="Chunk overlap (words)" hint="Words shared between adjacent chunks to avoid cutting off context at boundaries.">
                <input type="number" className="input" style={{ width:110 }} value={local.chunkOverlap||64} min={0} max={256} step={16} onChange={e => L({ chunkOverlap:+e.target.value })} />
              </SettingRow>
              <SettingRow label="Top-K chunks retrieved" hint="How many chunks are fed to Gemini per query. More = richer context, more tokens used.">
                <input type="number" className="input" style={{ width:90 }} value={local.topK||5} min={1} max={20} onChange={e => L({ topK:+e.target.value })} />
              </SettingRow>
              <SettingRow label={`Temperature: ${(local.temperature??0.2).toFixed(2)}`} hint="0 = very factual/deterministic. 1 = more creative/varied.">
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
                ⚠ Changing chunk or embed settings only affects newly added documents. To re-process existing documents, remove and re-add them.
              </div>
            </div>
          )}
        </div>
        <div style={{ padding:"0 24px 22px", display:"flex", justifyContent:"flex-end", gap:8 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => { saveSettings(local); onClose(); }}>Save Settings</button>
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
