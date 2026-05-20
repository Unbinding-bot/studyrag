import { useState, useRef, useEffect, useCallback } from "react";
import { getChunksBySubject } from "../lib/db.js";
import { ragAnswer, embedQuery, topK } from "../lib/gemini.js";
import { keywordSearch, LoadingSpinner } from "../App.jsx";

// ── Markdown-ish renderer (bold, italic, inline code, newlines) ───────────────
function Render({ text }) {
  const html = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code style='background:var(--surface2);padding:1px 6px;border-radius:4px;font-size:12px;font-family:monospace'>$1</code>")
    .replace(/\n/g, "<br/>");
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function Avatar({ role }) {
  return (
    <div style={{
      width:32, height:32, borderRadius:"50%",
      background: role === "user" ? "var(--accent)" : "var(--surface2)",
      color: role === "user" ? "var(--accent-fg)" : "var(--muted)",
      display:"flex", alignItems:"center", justifyContent:"center",
      fontSize:11, fontWeight:700, flexShrink:0,
    }}>
      {role === "user" ? "U" : "AI"}
    </div>
  );
}

function SourcePanel({ sources }) {
  const [open, setOpen] = useState(false);
  if (!sources?.length) return null;
  return (
    <div style={{ marginTop:6 }}>
      <button
        className="btn ghost"
        style={{ fontSize:11, padding:"3px 9px", color:"var(--muted)" }}
        onClick={() => setOpen(p => !p)}
      >
        📎 {open ? "Hide" : "Show"} sources ({sources.length})
      </button>
      {open && (
        <div style={{ marginTop:6, display:"flex", flexDirection:"column", gap:5 }}>
          {sources.map((s, i) => (
            <div
              key={i}
              style={{ padding:"8px 11px", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, fontSize:12 }}
            >
              <div style={{ fontWeight:600, color:"var(--accent)", marginBottom:3 }}>
                {s.docName}{s.page ? ` · p.${s.page}` : ""}
                {s.score != null && (
                  <span style={{ marginLeft:8, fontSize:10, color:"var(--muted)", fontWeight:400 }}>
                    {(s.score * 100).toFixed(0)}% match
                  </span>
                )}
              </div>
              <div style={{ color:"var(--muted)", lineHeight:1.5,
                overflow:"hidden", display:"-webkit-box",
                WebkitLineClamp:2, WebkitBoxOrient:"vertical",
              }}>
                {s.text?.slice(0, 220)}…
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChatBubble({ message: m }) {
  const isUser = m.role === "user";
  return (
    <div className="fade-in" style={{ display:"flex", flexDirection:isUser ? "row-reverse" : "row", gap:10 }}>
      <Avatar role={m.role} />
      <div style={{ maxWidth:"75%", display:"flex", flexDirection:"column", alignItems:isUser ? "flex-end" : "flex-start", gap:4 }}>
        <div style={{
          background: isUser ? "var(--accent)" : "var(--surface)",
          border:"1px solid var(--border)",
          borderRadius: isUser ? "14px 4px 14px 14px" : "4px 14px 14px 14px",
          padding:"10px 14px",
          fontSize:14, lineHeight:1.65,
          color: isUser ? "var(--accent-fg)" : "var(--text)",
        }}>
          <Render text={m.content} />
          {m.streaming && (
            <span style={{ display:"inline-block", width:8, height:14, background:"var(--accent)", borderRadius:2, marginLeft:4, animation:"blink .8s infinite", verticalAlign:"middle" }} />
          )}
        </div>
        {!isUser && <SourcePanel sources={m.sources} />}
      </div>
    </div>
  );
}

// ── Main Q&A Mode ─────────────────────────────────────────────────────────────
export default function QAMode({ subject, settings }) {
  const [messages, setMessages] = useState([{
    role:"assistant",
    content:`Ready. I'll answer questions about **${subject.name}** strictly from your uploaded documents. Ask anything.`,
  }]);
  const [input, setInput]         = useState("");
  const [loading, setLoading]     = useState(false);
  const [chunks, setChunks]       = useState([]);
  const [indexInfo, setIndexInfo] = useState("Loading index…");
  const bottomRef = useRef();
  const inputRef  = useRef();

  useEffect(() => {
    getChunksBySubject(subject.id).then(c => {
      setChunks(c);
      const withEmbed = c.filter(x => x.embedding).length;
      setIndexInfo(`${c.length} chunks · ${withEmbed} embedded`);
    });
  }, [subject.id]);

  const scrollToBottom = () => setTimeout(() => bottomRef.current?.scrollIntoView({ behavior:"smooth" }), 50);

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || loading) return;
    const hasKeys = (settings.apiKeys||[]).some(k=>k.key);
    if (!hasKeys) { alert("Add at least one Gemini API key in Settings → General."); return; }
    if (!chunks.length)   { alert("No document chunks found. Add documents to this subject first."); return; }

    setInput("");
    setLoading(true);
    setMessages(p => [...p, { role:"user", content:q }]);
    scrollToBottom();

    // Retrieve relevant chunks
    let relevant = [];
    try {
      const qVec = await embedQuery(q, settings);
      const withEmbed = chunks.filter(c => c.embedding);
      relevant = withEmbed.length
        ? topK(qVec, withEmbed, settings.topK || 5)
        : keywordSearch(q, chunks, settings.topK || 5);
    } catch {
      relevant = keywordSearch(q, chunks, settings.topK || 5);
    }

    if (!relevant.length) {
      setMessages(p => [...p, { role:"assistant", content:"I couldn't find relevant content in your documents for that question. Try rephrasing, or check that documents have been added to this subject." }]);
      setLoading(false);
      return;
    }

    // Streaming response
    const msgId = crypto.randomUUID();
    setMessages(p => [...p, { role:"assistant", content:"", id:msgId, streaming:true, sources:relevant }]);

    try {
      await ragAnswer({
        question: q,
        chunks: relevant,
        settings: settings,
        model: settings.model || "gemini-2.5-flash-lite",
        onChunk: (_, full) => {
          setMessages(p => p.map(m => m.id === msgId ? { ...m, content:full } : m));
          scrollToBottom();
        },
      });
      setMessages(p => p.map(m => m.id === msgId ? { ...m, streaming:false } : m));
    } catch (e) {
      setMessages(p => p.map(m => m.id === msgId ? { ...m, content:`Error: ${e.message}`, streaming:false } : m));
    } finally {
      setLoading(false);
      scrollToBottom();
      inputRef.current?.focus();
    }
  }, [input, loading, chunks, settings]);

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"calc(100vh - 52px)" }}>
      {/* Header */}
      <div style={{ padding:"11px 24px", borderBottom:"1px solid var(--border)", display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0, background:"var(--surface)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <span style={{ fontSize:14, fontWeight:600 }}>Q&amp;A</span>
          <span style={{ fontSize:11, color:"var(--muted)", background:"var(--surface2)", padding:"2px 8px", borderRadius:99 }}>
            {indexInfo}{!(settings.apiKeys||[]).some(k=>k.key) && " · ⚠ no API key"}
          </span>
        </div>
        <button
          className="btn ghost"
          style={{ fontSize:12, padding:"5px 10px" }}
          onClick={() => setMessages([{ role:"assistant", content:`Chat cleared. Ask anything about **${subject.name}**.` }])}
        >
          Clear chat
        </button>
      </div>

      {/* Messages */}
      <div style={{ flex:1, overflowY:"auto", padding:"22px 28px", display:"flex", flexDirection:"column", gap:18 }}>
        {messages.map((m, i) => <ChatBubble key={i} message={m} />)}
        {loading && !messages.find(m => m.streaming) && (
          <div style={{ display:"flex", gap:10 }}>
            <Avatar role="assistant" />
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"4px 14px 14px 14px", padding:"12px 16px" }}>
              <div className="dots"><span/><span/><span/></div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ padding:"13px 24px 16px", borderTop:"1px solid var(--border)", flexShrink:0 }}>
        <div style={{ display:"flex", gap:8 }}>
          <textarea
            ref={inputRef}
            className="input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Ask a question about your documents… (Enter to send, Shift+Enter for newline)"
            style={{ resize:"none", height:46, paddingTop:11, lineHeight:1.5 }}
          />
          <button className="btn primary" onClick={send} disabled={!input.trim() || loading} style={{ flexShrink:0, padding:"0 22px" }}>
            {loading ? <LoadingSpinner size={16}/> : "Send"}
          </button>
        </div>
        <p style={{ fontSize:11, color:"var(--muted)", marginTop:6 }}>
          Answers are grounded only in your uploaded documents.
        </p>
      </div>
    </div>
  );
}
