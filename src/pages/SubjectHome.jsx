import { useState, useEffect, useRef } from "react";
import { getDocsBySubject, deleteDoc, putSubject, deleteSubject, getDoc,
         getUnembeddedChunks, updateChunk, replaceChunksForDoc, putChunks } from "../lib/db.js";
import { processDocuments } from "../App.jsx";
import { LoadingSpinner, DocTypeIcon, Icon, Skeleton, toast } from "../App.jsx";
import { embedTexts, extractText, chunkText } from "../lib/gemini.js";

// ── Doc skeleton rows ─────────────────────────────────────────────────────────
function DocSkeleton() {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
      {[1,2,3].map(i => (
        <div key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 18px", borderBottom:"1px solid var(--border)" }}>
          <Skeleton width={18} height={18} style={{ borderRadius:3, flexShrink:0 }}/>
          <div style={{ flex:1, display:"flex", flexDirection:"column", gap:5 }}>
            <Skeleton width="60%" height={13}/>
            <Skeleton width="35%" height={11}/>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SubjectHome({ subject, setMode, settings, onSubjectUpdate, onSubjectDelete }) {
  const [docs, setDocs]                     = useState([]);
  const [loading, setLoading]               = useState(true);
  const [processing, setProcessing]         = useState(false);
  const [progress, setProgress]             = useState("");
  const [editingName, setEditingName]       = useState(false);
  const [newName, setNewName]               = useState(subject.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // #18 track which docIds are currently being indexed
  const [indexingDocs, setIndexingDocs]     = useState(new Set());
  const [reembedding, setReembedding]       = useState(false);
  const [reprocessing, setReprocessing]     = useState(null); // docId being reprocessed
  const [dragging, setDragging]             = useState(false);
  const fileRef = useRef();

  const refreshDocs = async () => {
    const d = await getDocsBySubject(subject.id);
    setDocs(d.sort((a, b) => b.addedAt - a.addedAt));
    setLoading(false);
  };

  useEffect(() => {
    setLoading(true);
    refreshDocs();
  }, [subject.id]);

  // #5 correct docCount after refresh
  const syncSubjectCount = async () => {
    const fresh = await getDocsBySubject(subject.id);
    const updated = { ...subject, updatedAt: Date.now(), docCount: fresh.length };
    await putSubject(updated);
    onSubjectUpdate(updated);
  };

  const addFiles = async (fileList) => {
    const files = Array.from(fileList).filter(f => {
      const ext = f.name.split(".").pop().toLowerCase();
      // #7 silently skip and warn for pptx
      if (ext === "pptx") {
        toast(`"${f.name}" — PPTX is not supported. Convert to PDF for best results.`, "info");
        return false;
      }
      return true;
    });
    if (!files.length) return;
    setProcessing(true);
    // #18 mark all incoming docs as indexing
    const names = files.map(f => f.name);
    try {
      await processDocuments(files, subject.id, settings, (msg) => setProgress(msg));
      await syncSubjectCount();
      await refreshDocs();
      toast(`Added ${files.length} document${files.length !== 1 ? "s" : ""}.`, "success");
    } catch (e) {
      toast("Error processing files: " + e.message, "error");
    } finally {
      setProcessing(false);
      setProgress("");
    }
  };

  const removeDoc = async (doc) => {
    if (!window.confirm(`Remove "${doc.name}"? This also deletes its embeddings.`)) return;
    await deleteDoc(doc.id);
    await syncSubjectCount();
    await refreshDocs();
    toast(`"${doc.name}" removed.`, "success");
  };

  const saveName = async () => {
    const name = newName.trim();
    if (!name) return;
    const updated = { ...subject, name, updatedAt: Date.now() };
    await putSubject(updated);
    onSubjectUpdate(updated);
    setEditingName(false);
    toast("Subject renamed.", "success");
  };

  const handleDeleteSubject = async () => {
    for (const d of docs) await deleteDoc(d.id);
    await deleteSubject(subject.id);
    onSubjectDelete();
  };

  // #8 Re-embed: find chunks with null embeddings and embed them
  const handleReEmbed = async () => {
    if (!(settings.apiKeys||[]).some(k=>k.key)) {
      toast("Add a Gemini API key first.", "error"); return;
    }
    const unembedded = await getUnembeddedChunks(subject.id);
    if (!unembedded.length) { toast("All chunks are already embedded.", "info"); return; }
    setReembedding(true);
    setProgress(`Re-embedding ${unembedded.length} chunks…`);
    try {
      const BATCH = 100;
      for (let i = 0; i < unembedded.length; i += BATCH) {
        const batch = unembedded.slice(i, i + BATCH);
        const embeddings = await embedTexts(batch.map(c => c.text), settings);
        for (let j = 0; j < batch.length; j++) {
          await updateChunk({ ...batch[j], embedding: embeddings[j] });
        }
        setProgress(`Re-embedding… ${Math.min(i + BATCH, unembedded.length)}/${unembedded.length}`);
      }
      toast(`Re-embedded ${unembedded.length} chunks.`, "success");
    } catch (e) {
      toast("Re-embed failed: " + e.message, "error");
    } finally {
      setReembedding(false);
      setProgress("");
    }
  };

  // #16 Re-process: re-extract text, re-chunk, re-embed a single doc
  const handleReProcess = async (doc) => {
    if (!(settings.apiKeys||[]).some(k=>k.key)) {
      toast("Add a Gemini API key first.", "error"); return;
    }
    setReprocessing(doc.id);
    setProgress(`Re-processing "${doc.name}"…`);
    try {
      // reconstruct File-like object from stored base64
      const binary = atob(doc.fileData);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: doc.mimeType || "application/octet-stream" });
      const file = new File([blob], doc.name, { type: doc.mimeType || "" });

      let text = "";
      try { text = await extractText(file); } catch (e) { console.warn("Extract:", e); }

      if (!text || text.startsWith("[IMAGE") || text.startsWith("[Unsupported")) {
        toast("Cannot extract text from this file type.", "error");
        return;
      }

      const rawChunks = chunkText(text, {
        chunkSize:  settings.chunkSize  || 512,
        overlap:    settings.chunkOverlap || 64,
        strategy:   settings.embedStrategy || "semantic",
      });

      setProgress(`Embedding ${rawChunks.length} chunks…`);
      const embeddings = await embedTexts(rawChunks.map(c => c.text), settings);
      const newChunks = rawChunks.map((c, j) => ({
        subjectId: subject.id, docId: doc.id, docName: doc.name,
        text: c.text, page: c.page || null,
        embedding: embeddings[j],
      }));

      await replaceChunksForDoc(doc.id, newChunks);
      toast(`"${doc.name}" re-processed with ${newChunks.length} chunks.`, "success");
    } catch (e) {
      toast("Re-process failed: " + e.message, "error");
    } finally {
      setReprocessing(null);
      setProgress("");
    }
  };

  const MODES = [
    { id:"qa",    label:"Q&A",         color:"var(--accent)", desc:"Ask anything — answers come only from your documents.",             icon:<Icon.QA size={22}/>    },
    { id:"quiz",  label:"Quiz / Test", color:"#34d399",       desc:"Generate tests: multiple choice, T/F, freeform, timed.",           icon:<Icon.Quiz size={22}/>  },
    { id:"study", label:"Study",       color:"#fb923c",       desc:"Read docs side-by-side with an AI chat and cited source jumping.", icon:<Icon.Study size={22}/> },
  ];

  // check how many unembedded chunks exist for the badge
  const [unembeddedCount, setUnembeddedCount] = useState(0);
  useEffect(() => {
    if (!loading) {
      getUnembeddedChunks(subject.id).then(c => setUnembeddedCount(c.length));
    }
  }, [loading, docs, subject.id]);

  return (
    <div style={{ padding:"32px 36px", maxWidth:900, margin:"0 auto", width:"100%" }}>
      {/* ── Header ── */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:28 }}>
        <div>
          {editingName ? (
            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
              <input className="input" value={newName} onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key==="Enter") saveName(); if (e.key==="Escape") setEditingName(false); }}
                style={{ fontSize:20, fontWeight:700, width:300 }} autoFocus />
              <button className="btn primary sm" onClick={saveName}>Save</button>
              <button className="btn sm" onClick={() => setEditingName(false)}>Cancel</button>
            </div>
          ) : (
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <h1 style={{ fontSize:24, fontWeight:700, letterSpacing:-.4 }}>{subject.name}</h1>
              <button className="btn ghost" style={{ padding:"4px 10px", color:"var(--muted)", fontSize:12 }}
                onClick={() => { setNewName(subject.name); setEditingName(true); }}>Rename</button>
            </div>
          )}
          <p style={{ fontSize:13, color:"var(--muted)", marginTop:4, display:"flex", gap:10, flexWrap:"wrap" }}>
            <span>{docs.length} document{docs.length !== 1 ? "s" : ""}</span>
            {(settings.apiKeys||[]).some(k=>k.key)
              ? unembeddedCount > 0
                ? <span style={{ color:"#fb923c" }}>⚠ {unembeddedCount} chunks not embedded</span>
                : <span style={{ color:"#34d399" }}>✓ RAG ready</span>
              : <span style={{ color:"#fb923c" }}>⚠ Add Gemini API key in Settings to enable RAG</span>
            }
          </p>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          {/* #8 re-embed button — show when there are unembedded chunks and a key */}
          {unembeddedCount > 0 && (settings.apiKeys||[]).some(k=>k.key) && (
            <button className="btn sm" onClick={handleReEmbed} disabled={reembedding} style={{ color:"#fb923c", borderColor:"#fb923c44" }}>
              {reembedding ? <LoadingSpinner size={12}/> : "⚡"} Re-embed {unembeddedCount} chunks
            </button>
          )}
          <button className="btn danger" style={{ fontSize:12, padding:"6px 12px" }} onClick={() => setShowDeleteConfirm(true)}>
            Delete Subject
          </button>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20, marginBottom:20 }}>
        {/* ── Documents panel ── */}
        <div className="card" style={{ padding:0 }}>
          <div style={{ padding:"13px 18px", borderBottom:"1px solid var(--border)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ fontSize:14, fontWeight:600 }}>Documents</span>
            <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={processing}>
              <Icon.Upload /> Add files
            </button>
            <input ref={fileRef} type="file" multiple
              accept=".pdf,.docx,.doc,.txt,.md,.png,.jpg,.jpeg,.webp"
              style={{ display:"none" }}
              onChange={e => { addFiles(e.target.files); e.target.value = ""; }}
            />
          </div>

          {/* #27 drag-and-drop zone on doc list */}
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
            style={{ minHeight:80, overflowY:"auto", maxHeight:340, border: dragging ? "2px dashed var(--accent)" : "2px solid transparent", borderRadius:8, transition:"border .15s" }}
          >
            {/* #32 skeleton while loading */}
            {loading && <DocSkeleton />}

            {!loading && docs.length === 0 && (
              <div style={{ padding:32, textAlign:"center", color:"var(--muted)" }}>
                <div style={{ fontSize:32, marginBottom:10 }}>📄</div>
                <p style={{ fontSize:13 }}>No documents yet.</p>
                <p style={{ fontSize:12, marginTop:4 }}>Drop files here or click "Add files"</p>
                <button className="btn sm" style={{ marginTop:12 }} onClick={() => fileRef.current?.click()}>
                  Add your first document
                </button>
              </div>
            )}

            {docs.map(doc => (
              <div key={doc.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 18px", borderBottom:"1px solid var(--border)" }}>
                <DocTypeIcon type={doc.type} size={18} />
                <div style={{ flex:1, overflow:"hidden" }}>
                  <div style={{ fontSize:13, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{doc.name}</div>
                  <div style={{ fontSize:11, color:"var(--muted)" }}>
                    {(doc.size / 1024).toFixed(0)} KB · {new Date(doc.addedAt).toLocaleDateString()}
                    {/* #18 indexing badge */}
                    {reprocessing === doc.id && (
                      <span style={{ marginLeft:8, color:"var(--accent)" }}><LoadingSpinner size={10}/></span>
                    )}
                  </div>
                </div>
                {/* #16 re-process button */}
                {(settings.apiKeys||[]).some(k=>k.key) && (
                  <button className="btn ghost" style={{ padding:"4px 7px", fontSize:11, color:"var(--muted)", flexShrink:0 }}
                    title="Re-extract and re-embed this document"
                    disabled={reprocessing === doc.id}
                    onClick={() => handleReProcess(doc)}>
                    {reprocessing === doc.id ? <LoadingSpinner size={11}/> : "↻"}
                  </button>
                )}
                <button className="btn ghost" style={{ padding:"5px 7px", color:"var(--muted)" }}
                  title="Remove document" onClick={() => removeDoc(doc)}>
                  <Icon.Trash />
                </button>
              </div>
            ))}
          </div>

          {(processing || reembedding) && (
            <div style={{ padding:"10px 18px", borderTop:"1px solid var(--border)", display:"flex", gap:8, alignItems:"center", fontSize:12, color:"var(--accent)" }}>
              <LoadingSpinner size={13} />
              <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{progress || "Processing…"}</span>
            </div>
          )}
        </div>

        {/* ── Quick start ── */}
        <div className="card">
          <div style={{ fontSize:14, fontWeight:600, marginBottom:16 }}>Start a session</div>
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {MODES.map(m => (
              <button key={m.id} onClick={() => setMode(m.id)} style={{
                display:"flex", alignItems:"center", gap:14, padding:"13px 16px",
                background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10,
                cursor:"pointer", textAlign:"left", transition:"border-color .15s", width:"100%",
              }}
                onMouseEnter={e => e.currentTarget.style.borderColor = m.color}
                onMouseLeave={e => e.currentTarget.style.borderColor = "var(--border)"}
              >
                <span style={{ color:m.color, flexShrink:0 }}>{m.icon}</span>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:"var(--text)", marginBottom:2 }}>{m.label}</div>
                  <div style={{ fontSize:12, color:"var(--muted)", lineHeight:1.5 }}>{m.desc}</div>
                </div>
                <Icon.ChevronRight color="var(--muted)" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Delete confirm modal ── */}
      {showDeleteConfirm && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setShowDeleteConfirm(false)}>
          <div className="modal fade-in" style={{ padding:28, maxWidth:400 }}>
            <h3 style={{ fontSize:17, fontWeight:700, marginBottom:10 }}>Delete "{subject.name}"?</h3>
            <p style={{ fontSize:13, color:"var(--muted)", lineHeight:1.65, marginBottom:22 }}>
              This permanently deletes this subject, all {docs.length} document{docs.length !== 1 ? "s" : ""}, and all embeddings. There is no undo.
            </p>
            <div style={{ display:"flex", gap:8, justifyContent:"flex-end" }}>
              <button className="btn" onClick={() => setShowDeleteConfirm(false)}>Cancel</button>
              <button className="btn danger" onClick={handleDeleteSubject}>Delete forever</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
