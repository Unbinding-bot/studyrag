import { useState, useEffect, useRef, useCallback } from "react";
import { getDocsBySubject, getChunksBySubject } from "../lib/db.js";
import { studyChat, parseSourcesFromReply, stripSourcesJson, embedQuery, topK } from "../lib/gemini.js";
import { keywordSearch, LoadingSpinner, DocTypeIcon, Icon } from "../App.jsx";

// ── helpers: base64 → Uint8Array → Blob URL ──────────────────────────────────
function b64ToUrl(b64, mime) {
  try {
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch { return null; }
}

// ── Continuous-scroll PDF Viewer ──────────────────────────────────────────────
// Renders ALL pages stacked vertically — just scroll through like a real doc.
function PDFViewer({ fileData, mimeType, highlightPage }) {
  const [pdfDoc,    setPdfDoc]   = useState(null);
  const [totalPages,setTotal]    = useState(0);
  const [zoom,      setZoom]     = useState(1.3);
  const [visiblePage, setVisible]= useState(1);
  const containerRef             = useRef();
  const pageRefs                 = useRef([]);   // array of canvas refs per page
  const renderTasks              = useRef([]);   // cancel pending renders on zoom change
  const urlRef                   = useRef(null);

  // Load PDF
  useEffect(() => {
    if (!fileData) return;
    const url = b64ToUrl(fileData, mimeType || "application/pdf");
    if (!url) return;
    urlRef.current = url;

    const lib = window["pdfjs-dist/build/pdf"];
    if (!lib) { console.warn("pdf.js not loaded"); return; }
    lib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

    lib.getDocument(url).promise.then(doc => {
      setPdfDoc(doc);
      setTotal(doc.numPages);
      pageRefs.current = new Array(doc.numPages).fill(null);
    }).catch(e => console.warn("PDF:", e));

    return () => { URL.revokeObjectURL(url); };
  }, [fileData]);

  // Render all pages whenever pdfDoc or zoom changes
  useEffect(() => {
    if (!pdfDoc || !totalPages) return;

    // Cancel previous render tasks
    renderTasks.current.forEach(t => { try { t.cancel(); } catch {} });
    renderTasks.current = [];

    for (let i = 1; i <= totalPages; i++) {
      const canvas = pageRefs.current[i - 1];
      if (!canvas) continue;
      pdfDoc.getPage(i).then(pg => {
        const vp = pg.getViewport({ scale: zoom });
        canvas.width  = vp.width;
        canvas.height = vp.height;
        const task = pg.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
        renderTasks.current.push(task);
      });
    }
  }, [pdfDoc, zoom, totalPages]);

  // Jump to highlighted page by scrolling to it
  useEffect(() => {
    if (!highlightPage || !containerRef.current) return;
    const pageEl = containerRef.current.querySelector(`[data-page="${highlightPage}"]`);
    if (pageEl) pageEl.scrollIntoView({ behavior:"smooth", block:"start" });
  }, [highlightPage]);

  // Track visible page via IntersectionObserver
  useEffect(() => {
    if (!containerRef.current || !totalPages) return;
    const obs = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          const p = parseInt(e.target.getAttribute("data-page"));
          if (p) setVisible(p);
        }
      });
    }, { root: containerRef.current, threshold: 0.3 });

    const pages = containerRef.current.querySelectorAll("[data-page]");
    pages.forEach(p => obs.observe(p));
    return () => obs.disconnect();
  }, [totalPages]);

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      {/* Toolbar */}
      <div style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 10px", borderBottom:"1px solid var(--border)", background:"var(--surface2)", flexShrink:0 }}>
        <span style={{ fontSize:12, color:"var(--muted)", minWidth:60 }}>p.{visiblePage}/{totalPages}</span>
        <div style={{ width:1, height:16, background:"var(--border)", margin:"0 2px" }}/>
        <button className="btn ghost" style={{ padding:"3px 8px" }} onClick={() => setZoom(z => Math.max(.5, +(z - .25).toFixed(2)))}>−</button>
        <span style={{ fontSize:12, color:"var(--muted)", minWidth:38, textAlign:"center" }}>{Math.round(zoom * 100)}%</span>
        <button className="btn ghost" style={{ padding:"3px 8px" }} onClick={() => setZoom(z => Math.min(3, +(z + .25).toFixed(2)))}>+</button>
        <button className="btn ghost" style={{ padding:"3px 8px", fontSize:11, color:"var(--muted)" }} onClick={() => setZoom(1.3)}>Reset</button>
      </div>

      {/* Scrollable page stack */}
      <div ref={containerRef} style={{ flex:1, overflowY:"auto", padding:"16px 12px", display:"flex", flexDirection:"column", alignItems:"center", gap:16, background:"var(--bg)" }}>
        {!pdfDoc && <LoadingSpinner size={28} />}
        {Array.from({ length: totalPages }, (_, i) => i + 1).map(pageNum => (
          <div key={pageNum} data-page={pageNum} style={{ position:"relative" }}>
            <canvas
              ref={el => { pageRefs.current[pageNum - 1] = el; }}
              style={{ display:"block", maxWidth:"100%", boxShadow:"0 4px 20px rgba(0,0,0,.35)", borderRadius:3, background:"#fff" }}
            />
            {/* Page number badge */}
            <div style={{ position:"absolute", bottom:8, right:8, background:"rgba(0,0,0,.5)", color:"#fff", fontSize:10, padding:"2px 7px", borderRadius:99 }}>
              {pageNum}
            </div>
            {/* Highlight flash overlay */}
            {highlightPage === pageNum && (
              <div style={{ position:"absolute", inset:0, border:"3px solid #4ade80", borderRadius:3, pointerEvents:"none", animation:"fadeOut 3s forwards" }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Image Viewer ──────────────────────────────────────────────────────────────
function ImageViewer({ fileData, mimeType, name }) {
  const [zoom, setZoom] = useState(1);
  const [url,  setUrl]  = useState(null);

  useEffect(() => {
    if (!fileData) return;
    const u = b64ToUrl(fileData, mimeType || "image/png");
    setUrl(u);
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [fileData]);

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 10px", borderBottom:"1px solid var(--border)", background:"var(--surface2)", flexShrink:0 }}>
        <button className="btn ghost" style={{ padding:"3px 8px" }} onClick={() => setZoom(z => Math.max(.25, +(z - .25).toFixed(2)))}>−</button>
        <span style={{ fontSize:12, color:"var(--muted)" }}>{Math.round(zoom * 100)}%</span>
        <button className="btn ghost" style={{ padding:"3px 8px" }} onClick={() => setZoom(z => Math.min(4, +(z + .25).toFixed(2)))}>+</button>
        <button className="btn ghost" style={{ padding:"3px 8px", fontSize:11, color:"var(--muted)" }} onClick={() => setZoom(1)}>Reset</button>
      </div>
      <div style={{ flex:1, overflow:"auto", padding:16, display:"flex", justifyContent:"center", alignItems:"flex-start", background:"var(--bg)" }}>
        {url && <img src={url} alt={name} style={{ transform:`scale(${zoom})`, transformOrigin:"top center", maxWidth:"100%", borderRadius:4, boxShadow:"0 4px 20px rgba(0,0,0,.25)" }} />}
      </div>
    </div>
  );
}

// ── Text / DOCX Viewer — continuous scroll with highlight ─────────────────────
function TextViewer({ fileData, mimeType, name, highlightSnippet }) {
  const [paragraphs, setParagraphs] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const highlightRef                = useRef();

  useEffect(() => {
    if (!fileData) return;
    setLoading(true);

    const isDocx = /\.(docx|doc)$/i.test(name || "");
    if (isDocx && window.mammoth) {
      try {
        const binary = atob(fileData);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        window.mammoth.extractRawText({ arrayBuffer: bytes.buffer })
          .then(r => { setParagraphs(splitParas(r.value)); setLoading(false); })
          .catch(() => { decodePlain(); });
        return;
      } catch {}
    }
    decodePlain();

    function decodePlain() {
      try {
        const binary = atob(fileData);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const text = new TextDecoder("utf-8", { fatal:false }).decode(bytes);
        setParagraphs(splitParas(text));
      } catch { setParagraphs(["[Could not decode file content]"]); }
      setLoading(false);
    }

    function splitParas(text) {
      return text.split(/\n{2,}|\n(?=\s*\n)/).map(p => p.trim()).filter(p => p.length > 0);
    }
  }, [fileData, name]);

  // Scroll to highlight
  useEffect(() => {
    if (highlightSnippet && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior:"smooth", block:"center" });
    }
  }, [highlightSnippet, paragraphs]);

  if (loading) return <div style={{ padding:32, display:"flex", justifyContent:"center" }}><LoadingSpinner /></div>;

  const snipKey = highlightSnippet?.slice(0, 50) || "";

  return (
    <div style={{ flex:1, overflowY:"auto", padding:"20px 28px", background:"var(--bg)" }}>
      {paragraphs.map((para, i) => {
        const hasSnip = snipKey && para.includes(snipKey);
        if (hasSnip) {
          const idx = para.indexOf(snipKey);
          return (
            <p key={i} ref={highlightRef} style={{ fontSize:14, lineHeight:1.85, color:"var(--text)", marginBottom:14 }}>
              {para.slice(0, idx)}
              <mark style={{ background:"#4ade8044", color:"var(--text)", padding:"1px 3px", borderRadius:3, animation:"fadeOut 3.5s forwards" }}>
                {para.slice(idx, idx + (highlightSnippet?.length || 80))}
              </mark>
              {para.slice(idx + (highlightSnippet?.length || 80))}
            </p>
          );
        }
        return (
          <p key={i} style={{ fontSize:14, lineHeight:1.85, color:"var(--text)", marginBottom:14 }}>
            {para}
          </p>
        );
      })}
    </div>
  );
}

// ── Doc Viewer shell ──────────────────────────────────────────────────────────
function DocViewer({ doc, highlightPage, highlightSnippet, onHighlightDone }) {
  if (!doc) return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:"var(--muted)", gap:12 }}>
      <Icon.Study size={44}/>
      <p style={{ fontSize:14 }}>Select a document above to read it here.</p>
    </div>
  );

  const t = doc.type?.toLowerCase();
  if (t === "pdf") return <PDFViewer fileData={doc.fileData} mimeType={doc.mimeType} highlightPage={highlightPage} onHighlightDone={onHighlightDone}/>;
  if (["png","jpg","jpeg","webp","gif"].includes(t)) return <ImageViewer fileData={doc.fileData} mimeType={doc.mimeType} name={doc.name}/>;
  return <TextViewer fileData={doc.fileData} mimeType={doc.mimeType} name={doc.name} highlightSnippet={highlightSnippet}/>;
}

// ── Study Chat ────────────────────────────────────────────────────────────────
function StudyChat({ chunks, settings, onViewSource }) {
  const [messages, setMessages] = useState([{
    role:"assistant",
    content:"Ask me anything about your documents. After I answer, click **View Source** to jump to the relevant page or passage.",
  }]);
  const [input,   setInput]   = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef             = useRef();

  const scroll = () => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior:"smooth" }), 50);

  const send = async () => {
    const q = input.trim();
    if (!q || loading) return;
    if (!(settings.apiKeys||[]).some(k=>k.key)) { alert("Add at least one Gemini API key in Settings."); return; }

    const history = [...messages, { role:"user", content:q }];
    setMessages(history);
    setInput("");
    setLoading(true);
    scroll();

    let relevant = [];
    try {
      const qVec = await embedQuery(q, settings);
      const withEmbed = chunks.filter(c=>c.embedding);
      relevant = withEmbed.length ? topK(qVec, withEmbed, settings.topK||5) : keywordSearch(q, chunks, settings.topK||5);
    } catch { relevant = keywordSearch(q, chunks, settings.topK||5); }

    const msgId = crypto.randomUUID();
    setMessages(p => [...p, { role:"assistant", content:"", id:msgId, streaming:true }]);

    try {
      let full = "";
      await studyChat({
        messages: history.map(m => ({ role:m.role, content:m.content })),
        chunks:   relevant,
        settings: settings,
        model:    settings.model || "gemini-2.5-flash-lite",
        onChunk: (_, f) => {
          full = f;
          setMessages(p => p.map(m => m.id===msgId ? { ...m, content:f } : m));
          scroll();
        },
      });
      const sourceRef    = parseSourcesFromReply(full);
      const cleanContent = stripSourcesJson(full);
      setMessages(p => p.map(m => m.id===msgId ? { ...m, content:cleanContent, streaming:false, sourceRef } : m));
    } catch(e) {
      setMessages(p => p.map(m => m.id===msgId ? { ...m, content:`Error: ${e.message}`, streaming:false } : m));
    } finally { setLoading(false); scroll(); }
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{ padding:"10px 14px", borderBottom:"1px solid var(--border)", flexShrink:0 }}>
        <span style={{ fontSize:13, fontWeight:600 }}>Chat with your documents</span>
      </div>

      <div style={{ flex:1, overflowY:"auto", padding:"14px", display:"flex", flexDirection:"column", gap:14 }}>
        {messages.map((m, i) => (
          <div key={i} className="fade-in">
            <div style={{ display:"flex", gap:8, flexDirection:m.role==="user"?"row-reverse":"row" }}>
              <div style={{ width:28, height:28, borderRadius:"50%", background:m.role==="user"?"var(--accent)":"var(--surface2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:m.role==="user"?"var(--accent-fg)":"var(--muted)", flexShrink:0 }}>
                {m.role==="user"?"U":"AI"}
              </div>
              <div style={{ maxWidth:"85%", background:m.role==="user"?"var(--accent)":"var(--surface2)", border:"1px solid var(--border)", borderRadius:m.role==="user"?"13px 4px 13px 13px":"4px 13px 13px 13px", padding:"9px 13px", fontSize:13, lineHeight:1.65, color:m.role==="user"?"var(--accent-fg)":"var(--text)", whiteSpace:"pre-wrap", wordBreak:"break-word" }}>
                {m.content.replace(/\*\*(.+?)\*\*/g,"$1")}
                {m.streaming && <span style={{ display:"inline-block", width:7, height:13, background:"var(--accent)", borderRadius:2, marginLeft:4, animation:"blink .8s infinite", verticalAlign:"middle" }}/>}
              </div>
            </div>
            {m.sourceRef && !m.streaming && (
              <div style={{ marginLeft:36, marginTop:5, display:"flex", flexWrap:"wrap", gap:4 }}>
                {m.sourceRef.map((src, si) => (
                  <button
                    key={si}
                    className="btn ghost"
                    style={{ fontSize:11, padding:"3px 9px", color:"var(--accent)" }}
                    onClick={() => onViewSource(src)}
                  >
                    📍 {src.docName}{src.page ? ` p.${src.page}` : ""}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {loading && !messages.find(m=>m.streaming) && (
          <div style={{ display:"flex", gap:8 }}>
            <div style={{ width:28, height:28, borderRadius:"50%", background:"var(--surface2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:"var(--muted)" }}>AI</div>
            <div style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:"4px 13px 13px 13px", padding:"12px 14px" }}>
              <div className="dots"><span/><span/><span/></div>
            </div>
          </div>
        )}
        <div ref={bottomRef}/>
      </div>

      <div style={{ padding:"10px 12px", borderTop:"1px solid var(--border)", display:"flex", gap:8, flexShrink:0 }}>
        <input
          className="input"
          value={input}
          onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&send()}
          placeholder="Ask about your documents…"
        />
        <button className="btn primary" onClick={send} disabled={!input.trim()||loading} style={{ padding:"8px 14px", flexShrink:0 }}>↑</button>
      </div>
    </div>
  );
}

// ── Main StudyMode ────────────────────────────────────────────────────────────
export default function StudyMode({ subject, settings }) {
  const [docs,      setDocs]     = useState([]);
  const [chunks,    setChunks]   = useState([]);
  const [activeDoc, setActiveDoc]= useState(null);
  const [history,   setHistory]  = useState([]);
  const [histIdx,   setHistIdx]  = useState(-1);
  const [highlight, setHighlight]= useState(null);  // { page, snippet, docName }
  const [loading,   setLoading]  = useState(true);

  useEffect(() => {
    Promise.all([getDocsBySubject(subject.id), getChunksBySubject(subject.id)]).then(([d, c]) => {
      const sorted = d.sort((a,b)=>b.addedAt-a.addedAt);
      setDocs(sorted);
      setChunks(c);
      if (sorted.length) navTo(sorted[0], [], -1);
      setLoading(false);
    });
  }, [subject.id]);

  const navTo = (doc, hist=history, idx=histIdx) => {
    const newHist = [...hist.slice(0, idx+1), doc];
    setHistory(newHist);
    setHistIdx(newHist.length-1);
    setActiveDoc(doc);
    setHighlight(null);
  };

  const back    = () => { if (histIdx>0) { const i=histIdx-1; setHistIdx(i); setActiveDoc(history[i]); setHighlight(null); } };
  const forward = () => { if (histIdx<history.length-1) { const i=histIdx+1; setHistIdx(i); setActiveDoc(history[i]); setHighlight(null); } };

  const handleViewSource = useCallback((ref) => {
    const doc = docs.find(d=>d.name===ref.docName) || docs[0];
    if (!doc) return;
    navTo(doc, history, histIdx);
    // Give time for the viewer to mount before setting highlight
    setTimeout(() => {
      setHighlight({ page: ref.page || null, snippet: ref.snippet || null });
      // Auto-clear highlight after 3.5 seconds
      setTimeout(() => setHighlight(null), 3500);
    }, 300);
  }, [docs, history, histIdx]);

  if (loading) return <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center" }}><LoadingSpinner size={28}/></div>;

  if (!docs.length) return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", color:"var(--muted)", gap:12 }}>
      <Icon.Study size={44}/>
      <p style={{ fontSize:14 }}>No documents in this subject yet.</p>
      <p style={{ fontSize:13 }}>Add documents from the Subject Home page.</p>
    </div>
  );

  return (
    <div style={{ display:"flex", flex:1, overflow:"hidden", height:"calc(100vh - 52px)" }}>
      {/* ── LEFT: Document viewer ── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", borderRight:"1px solid var(--border)", overflow:"hidden", minWidth:0 }}>
        {/* Browser nav bar */}
        <div style={{ display:"flex", alignItems:"center", gap:6, padding:"7px 10px", borderBottom:"1px solid var(--border)", background:"var(--surface)", flexShrink:0 }}>
          <button className="btn ghost" style={{ padding:"4px 8px" }} onClick={back}    disabled={histIdx<=0}                title="Back">    ←</button>
          <button className="btn ghost" style={{ padding:"4px 8px" }} onClick={forward} disabled={histIdx>=history.length-1} title="Forward"> →</button>
          <div style={{ flex:1, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:7, padding:"4px 10px", fontSize:12, color:"var(--muted)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {activeDoc ? `📄 ${activeDoc.name}` : "No document"}
          </div>
          {/* Highlight flash bar */}
          {highlight && (
            <div style={{ position:"absolute", top:52, left:0, right:0, height:3, background:"#4ade80", animation:"fadeOut 3s forwards", pointerEvents:"none", zIndex:20 }}/>
          )}
        </div>

        {/* Document tabs */}
        <div style={{ display:"flex", gap:4, padding:"5px 8px", borderBottom:"1px solid var(--border)", background:"var(--surface)", flexShrink:0, overflowX:"auto" }}>
          {docs.map(d => (
            <button
              key={d.id}
              className="btn sm"
              onClick={() => navTo(d)}
              style={{ flexShrink:0, fontSize:11, borderColor:activeDoc?.id===d.id?"var(--accent)":"var(--border)", color:activeDoc?.id===d.id?"var(--accent)":"var(--muted)" }}
            >
              <DocTypeIcon type={d.type} size={11}/>
              {d.name.length>24 ? d.name.slice(0,22)+"…" : d.name}
            </button>
          ))}
        </div>

        <DocViewer
          doc={activeDoc}
          highlightPage={highlight?.page}
          highlightSnippet={highlight?.snippet}
          onHighlightDone={() => {}}
        />
      </div>

      {/* ── RIGHT: Chat ── */}
      <div style={{ width:358, flexShrink:0, display:"flex", flexDirection:"column", overflow:"hidden" }}>
        <StudyChat chunks={chunks} settings={settings} onViewSource={handleViewSource}/>
      </div>
    </div>
  );
}
