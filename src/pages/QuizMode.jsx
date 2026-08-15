import { useState, useEffect, useRef, useCallback } from "react";
import { getChunksBySubject, getTestsBySubject, putTest, deleteTest } from "../lib/db.js";
import { generateQuiz, gradeFreeform } from "../lib/gemini.js";
import { LoadingSpinner, Toggle, Icon, toast } from "../App.jsx";

const DEFAULT_CONFIG = {
  types:            { mc:true, tf:false, freeform:false },
  modifiedTF:       false,
  numQ:             10,
  showExplainRight: true,
  showExplainWrong: true,
  timerMode:        "none",
  wholeMinutes:     20,
  perqSeconds:      60,
  geminiTime:       false,
  stopwatch:        false,
  testName:         "",
};

function fmtTime(s) {
  return `${String(Math.floor(s / 60)).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`;
}

// ── Config Panel ──────────────────────────────────────────────────────────────
function ConfigPanel({ config, onChange, onGenerate, generating, genStep, hasChunks, hasKey }) {
  const set  = patch => onChange({ ...config, ...patch });
  const setT = key   => onChange({ ...config, types:{ ...config.types, [key]:!config.types[key] } });
  const anyType = Object.values(config.types).some(Boolean);

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
        <div className="card">
          <div style={{ fontSize:13, fontWeight:600, marginBottom:16 }}>Question Types</div>
          <div style={{ display:"flex", flexDirection:"column", gap:13 }}>
            <Toggle label="Multiple Choice (4 options)" value={config.types.mc}       onChange={() => setT("mc")} />
            <Toggle label="True / False"                value={config.types.tf}       onChange={() => setT("tf")} />
            {config.types.tf && (
              <div style={{ paddingLeft:18, borderLeft:"2px solid var(--border)", marginTop:-4 }}>
                <Toggle label="Modified T/F — must explain if false" value={config.modifiedTF} onChange={v => set({ modifiedTF:v })} />
              </div>
            )}
            <Toggle label="Freeform text (Gemini grades)" value={config.types.freeform} onChange={() => setT("freeform")} />
          </div>
          <div style={{ marginTop:18 }}>
            <label style={{ fontSize:12, color:"var(--muted)", display:"block", marginBottom:6 }}>Number of questions</label>
            <input type="number" className="input" style={{ width:100 }}
              value={config.numQ === 0 ? "" : config.numQ} min={1} max={50}
              onChange={e => {
                const raw = e.target.value;
                if (raw === "" || raw === "0") { set({ numQ:0 }); return; }
                const n = parseInt(raw, 10);
                if (!isNaN(n)) set({ numQ: Math.min(50, Math.max(1, n)) });
              }}
              onBlur={() => { if (!config.numQ || config.numQ < 1) set({ numQ:1 }); }}
            />
            {config.numQ < 1  && <p style={{ fontSize:11, color:"#fb923c", marginTop:5 }}>⚠ Set at least 1 question.</p>}
            {config.numQ > 30 && <p style={{ fontSize:11, color:"var(--muted)", marginTop:5 }}>Tip: over 30 questions may be slow to generate.</p>}
          </div>
        </div>

        <div className="card">
          <div style={{ fontSize:13, fontWeight:600, marginBottom:14 }}>Feedback</div>
          <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:20 }}>
            <Toggle label="Explain correct answers" value={config.showExplainRight} onChange={v => set({ showExplainRight:v })} />
            <Toggle label="Explain wrong answers"   value={config.showExplainWrong} onChange={v => set({ showExplainWrong:v })} />
          </div>
          <div style={{ fontSize:13, fontWeight:600, marginBottom:12 }}>Timer</div>
          <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
            {[["none","No timer"],["whole","Whole-test countdown"],["perq","Per-question countdown"]].map(([v,l]) => (
              <label key={v} style={{ display:"flex", alignItems:"center", gap:8, fontSize:13, cursor:"pointer" }}>
                <input type="radio" name="timerMode" checked={config.timerMode===v} onChange={() => set({ timerMode:v })} style={{ accentColor:"var(--accent)" }} />
                {l}
              </label>
            ))}
          </div>
          {config.timerMode === "whole" && (
            <div style={{ marginTop:12, display:"flex", alignItems:"center", gap:8 }}>
              <input type="number" className="input" style={{ width:80 }} value={config.wholeMinutes} min={1} max={180}
                onChange={e => set({ wholeMinutes:+e.target.value })} />
              <span style={{ fontSize:13, color:"var(--muted)" }}>minutes total</span>
            </div>
          )}
          {config.timerMode === "perq" && (
            <div style={{ marginTop:12, display:"flex", flexDirection:"column", gap:10 }}>
              <Toggle label="Gemini picks time per question" value={config.geminiTime} onChange={v => set({ geminiTime:v })} />
              {!config.geminiTime && (
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <input type="number" className="input" style={{ width:80 }} value={config.perqSeconds} min={10} max={600}
                    onChange={e => set({ perqSeconds:+e.target.value })} />
                  <span style={{ fontSize:13, color:"var(--muted)" }}>seconds / question</span>
                </div>
              )}
            </div>
          )}
          <div style={{ marginTop:14 }}>
            <Toggle label="Stopwatch (show total time taken)" value={config.stopwatch} onChange={v => set({ stopwatch:v })} />
          </div>
        </div>
      </div>

      <div className="card" style={{ display:"flex", alignItems:"flex-end", gap:14, flexWrap:"wrap" }}>
        <div style={{ flex:1, minWidth:200 }}>
          <label style={{ fontSize:12, color:"var(--muted)", display:"block", marginBottom:6 }}>Test name (optional)</label>
          <input className="input" value={config.testName} onChange={e => set({ testName:e.target.value })} placeholder="e.g. Chapter 3 Review" />
        </div>
        <div style={{ display:"flex", gap:10, flexDirection:"column", alignItems:"flex-end" }}>
          {!hasKey    && <span style={{ fontSize:12, color:"#fb923c" }}>⚠ No API key</span>}
          {!hasChunks && <span style={{ fontSize:12, color:"#fb923c" }}>⚠ No indexed documents</span>}
          {/* #35 step indicator */}
          {generating && genStep && (
            <span style={{ fontSize:12, color:"var(--accent)", display:"flex", alignItems:"center", gap:6 }}>
              <LoadingSpinner size={12}/> {genStep}
            </span>
          )}
          <button className="btn primary" style={{ padding:"10px 26px", fontSize:14 }}
            onClick={onGenerate}
            disabled={!anyType || !hasKey || !hasChunks || generating || config.numQ < 1}>
            {generating ? <><LoadingSpinner size={14}/> Generating…</> : "⚡ Generate Test"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Test Taker ────────────────────────────────────────────────────────────────
function TestTaker({ questions, config, settings, model, onFinish }) {
  const [idx,       setIdx]      = useState(0);
  const [answers,   setAnswers]  = useState({});
  const [tfReasons, setTfReasons]= useState({});
  const [revealed,  setRevealed] = useState({});
  const [grades,    setGrades]   = useState({});
  const [grading,   setGrading]  = useState(false);
  const [paused,    setPaused]   = useState(false);
  const [done,      setDone]     = useState(false);
  const [showReview, setShowReview] = useState(false);

  const [elapsed,  setElapsed]  = useState(0);
  // #6 use first question's suggestedSeconds on init
  const [timeLeft, setTimeLeft] = useState(
    config.timerMode === "whole"
      ? config.wholeMinutes * 60
      : (questions[0]?.suggestedSeconds || config.perqSeconds)
  );

  // #3 use a ref for idx inside the timer effect to avoid stale closure
  const idxRef = useRef(idx);
  useEffect(() => { idxRef.current = idx; }, [idx]);

  // Reset per-q timer when question changes
  useEffect(() => {
    if (config.timerMode === "perq") {
      setTimeLeft(questions[idx]?.suggestedSeconds || config.perqSeconds);
    }
  }, [idx, config.timerMode, questions, config.perqSeconds]);

  useEffect(() => {
    if (done || (config.timerMode === "none" && !config.stopwatch)) return;
    const iv = setInterval(() => {
      if (paused) return;
      if (config.stopwatch || config.timerMode !== "none") setElapsed(p => p + 1);
      if (config.timerMode !== "none") {
        setTimeLeft(p => {
          if (p <= 1) {
            if (config.timerMode === "whole") { setDone(true); return 0; }
            // perq — advance using ref to avoid stale closure (#3)
            const cur = idxRef.current;
            if (cur < questions.length - 1) {
              setIdx(cur + 1);
              // next question's suggested time
              return questions[cur + 1]?.suggestedSeconds || config.perqSeconds;
            } else {
              setDone(true); return 0;
            }
          }
          return p - 1;
        });
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [paused, done, config, questions]);

  // #25 keyboard shortcuts
  useEffect(() => {
    if (done || paused) return;
    const q = questions[idx];
    const handler = (e) => {
      // A-D or 1-4 for MC
      if (q?.type === "mc" && !revealed[idx]) {
        const charMap = { a:0, b:1, c:2, d:3, 1:0, 2:1, 3:2, 4:3 };
        const key = e.key.toLowerCase();
        if (key in charMap && q.options?.[charMap[key]] !== undefined) {
          setAnswers(p => ({ ...p, [idx]: charMap[key] }));
          return;
        }
      }
      // T/F shortcuts
      if (q?.type === "true_false" && !revealed[idx]) {
        if (e.key === "t" || e.key === "T") { setAnswers(p => ({ ...p, [idx]: true })); return; }
        if (e.key === "f" || e.key === "F") { setAnswers(p => ({ ...p, [idx]: false })); return; }
      }
      // Enter = check/next
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!revealed[idx] && answers[idx] !== undefined && !grading) { checkAnswer(); }
        else if (revealed[idx]) { goNext(); }
      }
      // Arrow keys
      if (e.key === "ArrowRight" && revealed[idx]) goNext();
      if (e.key === "ArrowLeft")  setIdx(p => Math.max(0, p - 1));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [idx, answers, revealed, done, paused, grading, questions]);

  const q     = questions[idx];
  const ans   = answers[idx];
  const isRev = !!revealed[idx];

  const isCorrect = useCallback((qi, a) => {
    const qq = questions[qi];
    if (qq.type === "mc")         return a === qq.correctIndex;
    if (qq.type === "true_false") return a === qq.answer;
    if (qq.type === "freeform")   return grades[qi]?.correct ?? false;
    return false;
  }, [questions, grades]);

  const checkAnswer = async () => {
    if (isRev) return;
    if (q.type === "freeform" && ans) {
      setGrading(true);
      try {
        const g = await gradeFreeform({ question:q.question, modelAnswer:q.modelAnswer, rubric:q.rubric||[], userAnswer:ans, settings, model });
        setGrades(p => ({ ...p, [idx]:g }));
      } catch(e) {
        setGrades(p => ({ ...p, [idx]:{ score:0, correct:false, feedback:"Grading failed: "+e.message, missedPoints:[], hitPoints:[] } }));
      } finally { setGrading(false); }
    }
    setRevealed(p => ({ ...p, [idx]:true }));
  };

  const goNext = () => {
    if (!isRev && ans !== undefined) { checkAnswer(); return; }
    if (idx < questions.length - 1) setIdx(p => p + 1);
    else setDone(true);
  };

  // ── Results ────
  if (done) {
    let correct = 0;
    questions.forEach((qq, i) => { if (answers[i] !== undefined && isCorrect(i, answers[i])) correct++; });
    const pct = Math.round((correct / questions.length) * 100);

    // #23 review mode
    if (showReview) {
      return (
        <div style={{ maxWidth:740, margin:"0 auto", padding:"24px 0" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
            <h3 style={{ fontSize:17, fontWeight:700 }}>Answer Review</h3>
            <button className="btn" onClick={() => setShowReview(false)}>← Back to results</button>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
            {questions.map((qq, i) => {
              const userAns = answers[i];
              const correct = isCorrect(i, userAns);
              return (
                <div key={i} className="card" style={{ borderLeft:`3px solid ${correct ? "#34d399" : userAns === undefined ? "var(--border)" : "#f87171"}` }}>
                  <div style={{ display:"flex", gap:8, marginBottom:10, alignItems:"center" }}>
                    <span style={{ fontSize:20 }}>{correct ? "✓" : userAns === undefined ? "—" : "✗"}</span>
                    <span className="badge" style={{ background:"var(--surface2)", color:"var(--muted)" }}>
                      {{ mc:"Multiple Choice", true_false:"True / False", freeform:"Freeform" }[qq.type]}
                    </span>
                    {qq.difficulty && <span className="badge" style={{ background:"var(--surface2)", color:"var(--muted)" }}>{qq.difficulty}</span>}
                  </div>
                  <p style={{ fontSize:14, fontWeight:500, lineHeight:1.65, marginBottom:10 }}>{qq.question}</p>
                  {qq.type === "mc" && (
                    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                      {(qq.options||[]).map((opt, oi) => (
                        <div key={oi} style={{ padding:"7px 12px", borderRadius:7, fontSize:13, background:"var(--surface2)",
                          border:`1.5px solid ${oi === qq.correctIndex ? "#34d399" : oi === userAns && oi !== qq.correctIndex ? "#f87171" : "var(--border)"}`,
                          color: oi === qq.correctIndex ? "#34d399" : oi === userAns && oi !== qq.correctIndex ? "#f87171" : "var(--text)" }}>
                          {String.fromCharCode(65+oi)}. {opt}
                          {oi === qq.correctIndex && " ✓"}
                          {oi === userAns && oi !== qq.correctIndex && " ✗ (your answer)"}
                          {oi === userAns && oi === qq.correctIndex && " (your answer)"}
                        </div>
                      ))}
                    </div>
                  )}
                  {qq.type === "true_false" && (
                    <p style={{ fontSize:13, color:"var(--muted)" }}>
                      Your answer: <strong style={{ color: correct ? "#34d399" : "#f87171" }}>{userAns === undefined ? "Not answered" : userAns ? "True" : "False"}</strong>
                      {" · "}Correct: <strong style={{ color:"#34d399" }}>{qq.answer ? "True" : "False"}</strong>
                    </p>
                  )}
                  {qq.type === "freeform" && (
                    <div>
                      <p style={{ fontSize:13, color:"var(--muted)", marginBottom:6 }}>Your answer: <em>{userAns || "Not answered"}</em></p>
                      {grades[i] && <p style={{ fontSize:13 }}>Score: <strong style={{ color: grades[i].score >= 70 ? "#34d399" : "#f87171" }}>{grades[i].score}%</strong> — {grades[i].feedback}</p>}
                    </div>
                  )}
                  {qq.explanation && (
                    <div style={{ marginTop:10, padding:"8px 12px", background:"var(--surface2)", borderRadius:7, borderLeft:"3px solid var(--accent)", fontSize:13, lineHeight:1.65 }}>
                      <span style={{ fontWeight:600, color:"var(--accent)" }}>Explanation: </span>{qq.explanation}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    return (
      <div className="card fade-in" style={{ maxWidth:500, margin:"40px auto", textAlign:"center", padding:44 }}>
        <div style={{ fontSize:54, marginBottom:10 }}>{pct>=80?"🏆":pct>=60?"👍":"📚"}</div>
        <h2 style={{ fontSize:22, fontWeight:700, marginBottom:6 }}>Test Complete!</h2>
        <p style={{ fontSize:16, color:"var(--muted)", marginBottom:4 }}>{correct} / {questions.length} correct ({pct}%)</p>
        {config.stopwatch && <p style={{ fontSize:13, color:"var(--muted)" }}>Total time: {fmtTime(elapsed)}</p>}
        <div style={{ margin:"22px 0", height:8, background:"var(--surface2)", borderRadius:99, overflow:"hidden" }}>
          <div style={{ width:`${pct}%`, height:"100%", background:pct>=80?"#34d399":pct>=60?"#fcd34d":"#f87171", borderRadius:99, transition:"width 1.2s" }} />
        </div>
        <div style={{ display:"flex", gap:10, justifyContent:"center", flexWrap:"wrap" }}>
          <button className="btn" onClick={() => {
            setIdx(0); setAnswers({}); setTfReasons({}); setRevealed({}); setGrades({});
            setElapsed(0);
            // #6 correct retake timeLeft reset
            setTimeLeft(config.timerMode === "whole"
              ? config.wholeMinutes * 60
              : (questions[0]?.suggestedSeconds || config.perqSeconds));
            setDone(false);
          }}>Retake</button>
          {/* #23 review answers button */}
          <button className="btn" onClick={() => setShowReview(true)}>Review Answers</button>
          <button className="btn primary" onClick={onFinish}>Back to config</button>
        </div>
      </div>
    );
  }

  // ── Paused screen ────
  if (paused) return (
    <div style={{ textAlign:"center", padding:"80px 0" }}>
      <div style={{ fontSize:48, marginBottom:16 }}>⏸</div>
      <p style={{ fontSize:20, fontWeight:600, marginBottom:8, color:"var(--text)" }}>Test Paused</p>
      <p style={{ fontSize:13, color:"var(--muted)", marginBottom:28 }}>Your progress and timers are frozen.</p>
      <button className="btn primary" style={{ padding:"12px 32px", fontSize:15 }} onClick={() => setPaused(false)}>▶ Resume</button>
    </div>
  );

  const optStyle = (isSelected, showResult, isCorrectOpt) => {
    let bg = "var(--surface2)", border = "var(--border)", color = "var(--text)";
    if (showResult) {
      if (isCorrectOpt)            { bg="#14532d22"; border="#34d399"; color="#34d399"; }
      else if (isSelected)         { bg="#7f1d1d22"; border="#f87171"; color="#f87171"; }
    } else if (isSelected)         { border="var(--accent)"; color="var(--accent)"; }
    return { bg, border, color };
  };

  return (
    <div style={{ maxWidth:740, margin:"0 auto", padding:"24px 0" }}>
      {/* Progress + timer row */}
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20 }}>
        <div style={{ flex:1, height:5, background:"var(--surface2)", borderRadius:99, overflow:"hidden" }}>
          <div style={{ width:`${((idx+1)/questions.length)*100}%`, height:"100%", background:"var(--accent)", borderRadius:99, transition:"width .3s" }} />
        </div>
        <span style={{ fontSize:12, color:"var(--muted)", flexShrink:0 }}>{idx+1}/{questions.length}</span>
        {config.stopwatch && (
          <span style={{ fontSize:13, color:"var(--muted)", fontVariantNumeric:"tabular-nums", flexShrink:0 }}>⏱ {fmtTime(elapsed)}</span>
        )}
        {config.timerMode === "whole" && (
          <span style={{ fontSize:15, fontWeight:700, fontVariantNumeric:"tabular-nums", flexShrink:0,
            color: timeLeft < 60 ? "#f87171" : timeLeft < 120 ? "#fcd34d" : "var(--accent)" }}>
            {fmtTime(timeLeft)}
          </span>
        )}
        {/* #39 more prominent pause button */}
        {(config.timerMode !== "none" || config.stopwatch) && (
          <button className="btn" style={{ padding:"6px 14px", fontSize:13 }} onClick={() => setPaused(true)}>
            ⏸ Pause
          </button>
        )}
      </div>

      {config.timerMode === "perq" && (
        <div style={{ display:"flex", alignItems:"center", gap:16, marginBottom:16 }}>
          <span style={{ fontSize:44, fontWeight:700, fontVariantNumeric:"tabular-nums", lineHeight:1,
            color: timeLeft < 10 ? "#f87171" : timeLeft < 20 ? "#fcd34d" : "var(--accent)" }}>
            {fmtTime(timeLeft)}
          </span>
          <span style={{ fontSize:12, color:"var(--muted)" }}>
            {q.suggestedSeconds ? `Gemini suggested ${q.suggestedSeconds}s` : `${config.perqSeconds}s per question`}
          </span>
        </div>
      )}

      {/* keyboard hint */}
      <p style={{ fontSize:11, color:"var(--muted)", marginBottom:12 }}>
        {q?.type === "mc" && "Press A–D or 1–4 to select · "}
        {q?.type === "true_false" && "Press T/F to select · "}
        Enter to check · ← → to navigate
      </p>

      {/* Question card */}
      <div className="card" style={{ marginBottom:14 }}>
        <div style={{ display:"flex", gap:8, marginBottom:16, alignItems:"center" }}>
          <span className="badge" style={{ background:"var(--surface2)", color:"var(--muted)" }}>
            {{ mc:"Multiple Choice", true_false:"True / False", freeform:"Freeform" }[q.type]}
          </span>
          {q.difficulty && <span className="badge" style={{ background:"var(--surface2)", color:"var(--muted)" }}>{q.difficulty}</span>}
          {q.docName && <span style={{ fontSize:11, color:"var(--muted)", marginLeft:"auto" }}>📄 {q.docName}{q.page ? ` p.${q.page}` : ""}</span>}
        </div>

        <p style={{ fontSize:16, fontWeight:500, lineHeight:1.65, marginBottom:18 }}>{q.question}</p>

        {/* Multiple Choice */}
        {q.type === "mc" && (
          <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
            {!q.options?.length && <p style={{ color:"var(--muted)", fontSize:13 }}>⚠ Options missing — try regenerating.</p>}
            {(q.options||[]).map((opt, i) => {
              const { bg, border, color } = optStyle(ans===i, isRev, i===q.correctIndex);
              return (
                <button key={i} disabled={isRev} onClick={() => setAnswers(p => ({ ...p, [idx]:i }))}
                  style={{ display:"flex", alignItems:"center", gap:12, padding:"11px 14px", background:bg, border:`1.5px solid ${border}`, borderRadius:9, cursor:isRev?"default":"pointer", color, textAlign:"left", fontSize:14, transition:"all .15s", width:"100%" }}>
                  <span style={{ width:26, height:26, borderRadius:"50%", border:`1.5px solid ${border}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, flexShrink:0 }}>
                    {String.fromCharCode(65+i)}
                  </span>
                  <span style={{ flex:1 }}>{opt}</span>
                  {isRev && i===q.correctIndex && <span style={{ fontSize:16 }}>✓</span>}
                  {isRev && ans===i && i!==q.correctIndex && <span style={{ fontSize:16 }}>✗</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* True / False */}
        {q.type === "true_false" && (
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ display:"flex", gap:10 }}>
              {[true, false].map(val => {
                const { bg, border, color } = optStyle(ans===val, isRev, val===q.answer);
                return (
                  <button key={String(val)} disabled={isRev} onClick={() => setAnswers(p => ({ ...p, [idx]:val }))}
                    style={{ flex:1, padding:"13px", background:bg, border:`1.5px solid ${border}`, borderRadius:9, color, fontSize:15, fontWeight:600, cursor:isRev?"default":"pointer", transition:"all .15s" }}>
                    {val ? "✓ True" : "✗ False"}
                  </button>
                );
              })}
            </div>
            {config.modifiedTF && ans === false && !isRev && (
              <div>
                <label style={{ fontSize:12, color:"var(--muted)", display:"block", marginBottom:6 }}>Explain why this statement is false:</label>
                <textarea className="input" style={{ resize:"vertical", minHeight:80 }}
                  value={tfReasons[idx] || ""}
                  onChange={e => setTfReasons(p => ({ ...p, [idx]:e.target.value }))}
                  placeholder="Write your reasoning here…" />
              </div>
            )}
          </div>
        )}

        {/* Freeform */}
        {q.type === "freeform" && (
          <textarea className="input" style={{ resize:"vertical", minHeight:110, fontSize:14 }}
            value={ans || ""} onChange={e => setAnswers(p => ({ ...p, [idx]:e.target.value }))}
            disabled={isRev} placeholder="Write your answer here…" />
        )}

        {/* Freeform grade */}
        {isRev && q.type === "freeform" && grades[idx] && (
          <div style={{ marginTop:16, padding:"14px 16px", background:"var(--surface2)", borderRadius:9 }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
              <span style={{ fontSize:22, fontWeight:800, color:grades[idx].score>=70?"#34d399":"#f87171" }}>{grades[idx].score}%</span>
              <span style={{ fontSize:13, fontWeight:600, color:grades[idx].correct?"#34d399":"#f87171" }}>
                {grades[idx].correct ? "Correct" : "Needs improvement"}
              </span>
            </div>
            <p style={{ fontSize:13, lineHeight:1.65, color:"var(--text)" }}>{grades[idx].feedback}</p>
            {grades[idx].hitPoints?.length > 0 && <p style={{ fontSize:12, color:"#34d399", marginTop:8 }}>✓ Covered: {grades[idx].hitPoints.join(", ")}</p>}
            {grades[idx].missedPoints?.length > 0 && <p style={{ fontSize:12, color:"#f87171", marginTop:4 }}>✗ Missed: {grades[idx].missedPoints.join(", ")}</p>}
          </div>
        )}

        {/* Explanation */}
        {isRev && q.explanation && (() => {
          const correct = isCorrect(idx, ans);
          const show = (correct && config.showExplainRight) || (!correct && config.showExplainWrong);
          return show ? (
            <div style={{ marginTop:14, padding:"11px 14px", background:"var(--surface2)", borderRadius:9, borderLeft:"3px solid var(--accent)", fontSize:13, lineHeight:1.65 }}>
              <span style={{ fontWeight:600, color:"var(--accent)" }}>Explanation: </span>{q.explanation}
            </div>
          ) : null;
        })()}

        {/* Freeform model answer */}
        {isRev && q.type === "freeform" && q.modelAnswer && (
          <details style={{ marginTop:12 }}>
            <summary style={{ fontSize:12, color:"var(--muted)", cursor:"pointer", userSelect:"none" }}>View model answer</summary>
            <div style={{ marginTop:8, padding:"11px 14px", background:"var(--surface2)", borderRadius:9, fontSize:13, lineHeight:1.65 }}>{q.modelAnswer}</div>
          </details>
        )}
      </div>

      {/* Navigation */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <button className="btn" onClick={() => setIdx(p => Math.max(0,p-1))} disabled={idx===0}>← Back</button>
        <div style={{ display:"flex", gap:8 }}>
          {!isRev && ans !== undefined && !grading && (
            <button className="btn" onClick={checkAnswer}>{q.type==="freeform" ? "Grade answer" : "Check answer"}</button>
          )}
          {grading && <LoadingSpinner size={18}/>}
          {idx < questions.length-1
            ? <button className="btn primary" onClick={goNext}>Next →</button>
            : <button className="btn primary" onClick={() => setDone(true)}>Finish Test</button>
          }
        </div>
      </div>
    </div>
  );
}

// ── History Panel ─────────────────────────────────────────────────────────────
function HistoryPanel({ subjectId, onLoad }) {
  const [tests,   setTests]   = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => getTestsBySubject(subjectId).then(t => {
    setTests(t.sort((a,b)=>b.createdAt-a.createdAt));
    setLoading(false);
  });
  useEffect(() => { refresh(); }, [subjectId]);

  const remove = async (id) => {
    if (!window.confirm("Delete this saved test?")) return;
    await deleteTest(id);
    refresh();
  };

  if (loading) return <div style={{ padding:40, display:"flex", justifyContent:"center" }}><LoadingSpinner/></div>;
  if (!tests.length) return (
    <div className="card" style={{ textAlign:"center", padding:48, color:"var(--muted)" }}>
      <Icon.Quiz size={36}/>
      <p style={{ marginTop:14, fontSize:13 }}>No saved tests yet. Generate one first.</p>
    </div>
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
      {tests.map(t => (
        <div key={t.id} className="card" style={{ display:"flex", gap:14, alignItems:"center" }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, fontWeight:600 }}>{t.name}</div>
            <div style={{ fontSize:12, color:"var(--muted)", marginTop:3 }}>
              {t.questions?.length || 0} questions ·{" "}
              {Object.entries(t.config?.types||{}).filter(([,v])=>v).map(([k])=>({mc:"MC",tf:"T/F",freeform:"Text"}[k])).join(", ")} ·{" "}
              {new Date(t.createdAt).toLocaleDateString()}
            </div>
          </div>
          <button className="btn sm" onClick={() => onLoad(t)}>Load &amp; Retake</button>
          <button className="btn sm danger" onClick={() => remove(t.id)}>Delete</button>
        </div>
      ))}
    </div>
  );
}

// ── Main QuizMode ─────────────────────────────────────────────────────────────
export default function QuizMode({ subject, settings }) {
  const [tab,        setTab]        = useState("config");
  const [config,     setConfig]     = useState(DEFAULT_CONFIG);
  const [questions,  setQuestions]  = useState(null);
  const [generating, setGenerating] = useState(false);
  const [genStep,    setGenStep]    = useState(""); // #35 step indicator
  const [chunks,     setChunks]     = useState([]);

  useEffect(() => {
    getChunksBySubject(subject.id).then(setChunks);
  }, [subject.id]);

  const generate = async () => {
    setGenerating(true);
    setGenStep("");
    try {
      const sample = chunks.slice(0, 40);
      const qs = await generateQuiz({
        chunks: sample, config,
        settings, model: settings.model || "gemini-2.5-flash-lite",
        onStep: (step) => setGenStep(step), // #35
      });
      if (!qs?.length) throw new Error("No questions returned. Try again.");

      // #1 normalize BEFORE saving
      const normalized = qs.map(q => ({
        ...q,
        type: q.type === "multiple_choice" ? "mc"
            : q.type === "true/false" || q.type === "true_false" ? "true_false"
            : q.type === "open_ended" || q.type === "open-ended" || q.type === "text" ? "freeform"
            : q.type,
        options: q.options || (q.choices ? Object.values(q.choices) : []),
      }));

      setQuestions(normalized);

      // #1 save normalized (not raw qs)
      await putTest({
        id:        crypto.randomUUID(),
        subjectId: subject.id,
        name:      config.testName || `Test — ${new Date().toLocaleDateString()}`,
        config,
        questions: normalized,
        createdAt: Date.now(),
      });
      setTab("take");
      toast(`Generated ${normalized.length} questions.`, "success");
    } catch (e) {
      toast("Quiz generation failed: " + e.message, "error");
    } finally {
      setGenerating(false);
      setGenStep("");
    }
  };

  const loadTest = t => {
    // normalize loaded questions too (#1 guard for old saves)
    const normalized = (t.questions||[]).map(q => ({
      ...q,
      type: q.type === "multiple_choice" ? "mc"
          : q.type === "true/false" || q.type === "true_false" ? "true_false"
          : q.type === "open_ended" || q.type === "open-ended" || q.type === "text" ? "freeform"
          : q.type,
      options: q.options || (q.choices ? Object.values(q.choices) : []),
    }));
    setConfig(t.config);
    setQuestions(normalized);
    setTab("take");
  };

  return (
    <div style={{ flex:1, padding:"24px 32px", overflowY:"auto" }}>
      <div style={{ marginBottom:20 }}>
        <h2 style={{ fontSize:20, fontWeight:700, marginBottom:4 }}>Quiz / Test</h2>
        <p style={{ fontSize:13, color:"var(--muted)" }}>
          {subject.name} · {chunks.length} chunks indexed
          {!(settings.apiKeys||[]).some(k=>k.key) && " · ⚠ No API key"}
        </p>
      </div>

      <div style={{ display:"flex", gap:3, marginBottom:24, background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:4, width:"fit-content" }}>
        {["config","take","history"].map(t => (
          <button key={t} className={`tab ${tab===t?"active":""}`} onClick={() => setTab(t)}>
            {{ config:"Configure", take:"Take Test", history:"History" }[t]}
          </button>
        ))}
      </div>

      {tab === "config" && (
        <ConfigPanel config={config} onChange={setConfig}
          onGenerate={generate} generating={generating} genStep={genStep}
          hasChunks={chunks.length>0} hasKey={(settings.apiKeys||[]).some(k=>k.key)} />
      )}

      {tab === "take" && !questions && (
        <div className="card" style={{ maxWidth:460, margin:"0 auto", textAlign:"center", padding:44 }}>
          <Icon.Quiz size={40}/>
          <p style={{ fontSize:14, color:"var(--muted)", marginTop:14, marginBottom:22 }}>
            No test generated yet. Configure and generate one first.
          </p>
          <button className="btn primary" onClick={() => setTab("config")}>Go to Configure</button>
        </div>
      )}

      {tab === "take" && questions && (
        <TestTaker questions={questions} config={config}
          settings={settings} model={settings.model || "gemini-2.5-flash-lite"}
          onFinish={() => { setQuestions(null); setTab("config"); }} />
      )}

      {tab === "history" && (
        <HistoryPanel subjectId={subject.id} onLoad={loadTest}/>
      )}
    </div>
  );
}
