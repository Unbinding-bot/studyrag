import { useState, useEffect, useRef } from "react";
import { getDocsBySubject, deleteDoc, putSubject, deleteSubject } from "../lib/db.js";
import { processDocuments } from "../App.jsx";
import { LoadingSpinner, DocTypeIcon, Icon } from "../App.jsx";

export default function SubjectHome({ subject, setMode, settings, onSubjectUpdate, onSubjectDelete }) {
  const [docs, setDocs]                   = useState([]);
  const [loading, setLoading]             = useState(true);
  const [processing, setProcessing]       = useState(false);
  const [progress, setProgress]           = useState("");
  const [editingName, setEditingName]     = useState(false);
  const [newName, setNewName]             = useState(subject.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
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

  const addFiles = async (fileList) => {
    const files = Array.from(fileList);
    if (!files.length) return;
    setProcessing(true);
    try {
      await processDocuments(files, subject.id, settings, (msg) => setProgress(msg));
      const updated = { ...subject, updatedAt: Date.now(), docCount: docs.length + files.length };
      await putSubject(updated);
      onSubjectUpdate(updated);
      await refreshDocs();
    } catch (e) {
      alert("Error processing files: " + e.message);
    } finally {
      setProcessing(false);
      setProgress("");
    }
  };

  const removeDoc = async (doc) => {
    if (!confirm(`Remove "${doc.name}"? This also deletes its embeddings.`)) return;
    await deleteDoc(doc.id);
    const updated = { ...subject, updatedAt: Date.now(), docCount: Math.max(0, docs.length - 1) };
    await putSubject(updated);
    onSubjectUpdate(updated);
    await refreshDocs();
  };

  const saveName = async () => {
    const name = newName.trim();
    if (!name) return;
    const updated = { ...subject, name, updatedAt: Date.now() };
    await putSubject(updated);
    onSubjectUpdate(updated);
    setEditingName(false);
  };

  const handleDeleteSubject = async () => {
    for (const d of docs) await deleteDoc(d.id);
    await deleteSubject(subject.id);
    onSubjectDelete();
  };

  const MODES = [
    { id:"qa",    label:"Q&A",         color:"var(--accent)", desc:"Ask anything — answers come only from your documents.",               icon:<Icon.QA size={22}/>    },
    { id:"quiz",  label:"Quiz / Test", color:"#34d399",       desc:"Generate tests: multiple choice, T/F, freeform, timed.",             icon:<Icon.Quiz size={22}/>  },
    { id:"study", label:"Study",       color:"#fb923c",       desc:"Read docs side-by-side with an AI chat and cited source jumping.",   icon:<Icon.Study size={22}/> },
  ];

  return (
    <div style={{ padding:"32px 36px", maxWidth:900, margin:"0 auto", width:"100%" }}>
      {/* ── Header ── */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:28 }}>
        <div>
          {editingName ? (
            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
              <input
                className="input"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key==="Enter") saveName(); if (e.key==="Escape") setEditingName(false); }}
                style={{ fontSize:20, fontWeight:700, width:300 }}
                autoFocus
              />
              <button className="btn primary sm" onClick={saveName}>Save</button>
              <button className="btn sm" onClick={() => setEditingName(false)}>Cancel</button>
            </div>
          ) : (
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <h1 style={{ fontSize:24, fontWeight:700, letterSpacing:-.4 }}>{subject.name}</h1>
              <button
                className="btn ghost"
                style={{ padding:"4px 10px", color:"var(--muted)", fontSize:12 }}
                onClick={() => { setNewName(subject.name); setEditingName(true); }}
              >
                Rename
              </button>
            </div>
          )}
          <p style={{ fontSize:13, color:"var(--muted)", marginTop:4 }}>
            {docs.length} document{docs.length !== 1 ? "s" : ""} ·{" "}
            {(settings.apiKeys||[]).some(k=>k.key) ? "RAG ready" : "⚠ Add Gemini API key in Settings to enable RAG"}
          </p>
        </div>
        <button className="btn danger" style={{ fontSize:12, padding:"6px 12px" }} onClick={() => setShowDeleteConfirm(true)}>
          Delete Subject
        </button>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20, marginBottom:20 }}>
        {/* ── Documents panel ── */}
        <div className="card" style={{ padding:0 }}>
          <div style={{ padding:"13px 18px", borderBottom:"1px solid var(--border)", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ fontSize:14, fontWeight:600 }}>Documents</span>
            <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={processing}>
              <Icon.Upload /> Add files
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".pdf,.docx,.doc,.txt,.md,.png,.jpg,.jpeg,.webp,.pptx"
              style={{ display:"none" }}
              onChange={e => { addFiles(e.target.files); e.target.value = ""; }}
            />
          </div>

          <div style={{ overflowY:"auto", maxHeight:300 }}>
            {loading && (
              <div style={{ padding:28, display:"flex", justifyContent:"center" }}>
                <LoadingSpinner />
              </div>
            )}
            {!loading && docs.length === 0 && (
              <div style={{ padding:32, textAlign:"center", color:"var(--muted)" }}>
                <div style={{ fontSize:32, marginBottom:10 }}>📄</div>
                <p style={{ fontSize:13 }}>No documents yet.</p>
                <button className="btn sm" style={{ marginTop:12 }} onClick={() => fileRef.current?.click()}>
                  Add your first document
                </button>
              </div>
            )}
            {docs.map(doc => (
              <div
                key={doc.id}
                style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 18px", borderBottom:"1px solid var(--border)" }}
              >
                <DocTypeIcon type={doc.type} size={18} />
                <div style={{ flex:1, overflow:"hidden" }}>
                  <div style={{ fontSize:13, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{doc.name}</div>
                  <div style={{ fontSize:11, color:"var(--muted)" }}>
                    {(doc.size / 1024).toFixed(0)} KB · added {new Date(doc.addedAt).toLocaleDateString()}
                  </div>
                </div>
                <button
                  className="btn ghost"
                  style={{ padding:"5px 7px", color:"var(--muted)" }}
                  title="Remove document"
                  onClick={() => removeDoc(doc)}
                >
                  <Icon.Trash />
                </button>
              </div>
            ))}
          </div>

          {processing && (
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
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                style={{
                  display:"flex", alignItems:"center", gap:14,
                  padding:"13px 16px",
                  background:"var(--surface2)",
                  border:"1px solid var(--border)",
                  borderRadius:10,
                  cursor:"pointer",
                  textAlign:"left",
                  transition:"border-color .15s",
                  width:"100%",
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
              This permanently deletes this subject, all {docs.length} document{docs.length !== 1 ? "s" : ""}, and all
              embeddings. There is no undo.
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
