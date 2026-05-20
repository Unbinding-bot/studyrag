// Gemini API client
// All real API calls live here — no stubs.

const BASE = "https://generativelanguage.googleapis.com/v1beta";

// ── helpers ───────────────────────────────────────────────────────────────────

function geminiHeaders(apiKey) {
  return { "Content-Type": "application/json", "x-goog-api-key": apiKey };
}

// geminiPost with key rotation — tries each key in order starting from startIdx.
// Returns { data, usedKey } on success, throws if all keys fail.
async function geminiPost(path, apiKey, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: geminiHeaders(apiKey),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Gemini error ${r.status}`);
  }
  return r.json();
}

// Try a request with automatic key rotation.
// Pass settings (has .apiKeys array + .activeKeyIndex).
// Returns response data, using the first key that works.
// Throws a combined error only if every key fails.
export async function geminiPostWithRotation(path, settings, body) {
  const keys = (settings.apiKeys || []).map(k => k.key).filter(Boolean);
  if (!keys.length) throw new Error("No API keys configured. Add one in Settings.");

  // Start from activeKeyIndex, wrap around
  const start  = Math.min(settings.activeKeyIndex || 0, keys.length - 1);
  const order  = [...keys.slice(start), ...keys.slice(0, start)];
  const errors = [];

  for (const key of order) {
    try {
      return await geminiPost(path, key, body);
    } catch (e) {
      const msg = e.message || "";
      // Only rotate on auth/quota errors, not on bad requests
      if (msg.includes("API_KEY_INVALID") || msg.includes("quota") ||
          msg.includes("429") || msg.includes("403") || msg.includes("PERMISSION_DENIED")) {
        errors.push(`Key …${key.slice(-6)}: ${msg}`);
        continue;
      }
      // Non-auth error — throw immediately, don't rotate
      throw e;
    }
  }
  throw new Error("All API keys failed:\n" + errors.join("\n"));
}

// Convenience: get just the active key string for non-rotating calls
export function getActiveKey(settings) {
  const keys = settings.apiKeys || [];
  if (!keys.length) return "";
  const idx = Math.min(settings.activeKeyIndex || 0, keys.length - 1);
  return keys[idx]?.key || "";
}

// Try a streaming SSE fetch with key rotation.
// Returns the fetch Response from the first working key.
export async function streamFetchWithRotation(path, settings, body) {
  const keys = (settings.apiKeys || []).map(k => k.key).filter(Boolean);
  if (!keys.length) throw new Error("No API keys configured. Add one in Settings.");

  const start  = Math.min(settings.activeKeyIndex || 0, keys.length - 1);
  const order  = [...keys.slice(start), ...keys.slice(0, start)];
  const errors = [];

  for (const key of order) {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: geminiHeaders(key),
      body: JSON.stringify(body),
    });
    if (r.ok) return r;
    // Check if it's an auth/quota error worth rotating on
    const errBody = await r.json().catch(() => ({}));
    const msg = errBody?.error?.message || `HTTP ${r.status}`;
    if (r.status === 429 || r.status === 403 || msg.includes("API_KEY_INVALID") || msg.includes("quota")) {
      errors.push(`Key …${key.slice(-6)}: ${msg}`);
      continue;
    }
    // Other error (bad request, model not found etc) — throw immediately
    throw new Error(msg);
  }
  throw new Error("All API keys failed:\n" + errors.join("\n"));
}

// ── text extraction ───────────────────────────────────────────────────────────

export async function extractText(file) {
  const ext = file.name.split(".").pop().toLowerCase();

  if (ext === "txt" || ext === "md") {
    return file.text();
  }

  if (ext === "pdf") {
    // Use pdf.js (loaded via CDN in index.html)
    const ab = await file.arrayBuffer();
    const pdfjsLib = window["pdfjs-dist/build/pdf"];
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += `\n[Page ${i}]\n` + content.items.map((it) => it.str).join(" ");
    }
    return text;
  }

  if (ext === "docx") {
    const ab = await file.arrayBuffer();
    const mammoth = window.mammoth;
    if (!mammoth) throw new Error("mammoth.js not loaded");
    const result = await mammoth.extractRawText({ arrayBuffer: ab });
    return result.value;
  }

  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
    // Return a marker — images go directly to Gemini vision, not chunked
    return `[IMAGE:${file.name}]`;
  }

  // pptx / other: best-effort binary text (will be noisy but better than nothing)
  return `[Unsupported format: ${file.name}. Text extraction not available for this file type. Upload a PDF, DOCX, or TXT for full RAG support.]`;
}

// ── chunking ──────────────────────────────────────────────────────────────────

export function chunkText(text, { chunkSize = 512, overlap = 64, strategy = "semantic" } = {}) {
  if (strategy === "page") {
    // Split on [Page N] markers
    const pages = text.split(/\[Page \d+\]/);
    return pages
      .map((p, i) => p.trim())
      .filter((p) => p.length > 20)
      .map((p, i) => ({ text: p, page: i + 1 }));
  }

  if (strategy === "semantic") {
    // Split on paragraph boundaries first, then merge to chunkSize
    const paras = text.split(/\n{2,}/);
    const chunks = [];
    let current = "";
    let startPara = 0;

    for (let i = 0; i < paras.length; i++) {
      const para = paras[i].trim();
      if (!para) continue;
      if ((current + " " + para).length > chunkSize * 4 && current.length > 0) {
        chunks.push({ text: current.trim(), paraStart: startPara, paraEnd: i - 1 });
        // overlap: keep last overlap chars
        current = current.slice(-overlap * 4) + " " + para;
        startPara = i;
      } else {
        current += (current ? " " : "") + para;
      }
    }
    if (current.trim()) chunks.push({ text: current.trim(), paraStart: startPara, paraEnd: paras.length });
    return chunks;
  }

  // fixed-size
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize - overlap) {
    const slice = words.slice(i, i + chunkSize).join(" ");
    if (slice.trim()) chunks.push({ text: slice });
  }
  return chunks;
}

// ── embeddings ────────────────────────────────────────────────────────────────

export async function embedTexts(texts, settings) {
  const apiKey = getActiveKey(settings);
  // text-embedding-004 supports batch up to 100
  const BATCH = 100;
  const all = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const body = {
      requests: batch.map((t) => ({
        model: "models/text-embedding-004",
        content: { parts: [{ text: t }] },
        taskType: "RETRIEVAL_DOCUMENT",
      })),
    };
    const data = await geminiPost("/models/text-embedding-004:batchEmbedContents", apiKey, body);
    all.push(...data.embeddings.map((e) => e.values));
  }
  return all;
}

export async function embedQuery(text, settings) {
  const apiKey = getActiveKey(settings);
  const data = await geminiPost("/models/text-embedding-004:embedContent", apiKey, {
    model: "models/text-embedding-004",
    content: { parts: [{ text }] },
    taskType: "RETRIEVAL_QUERY",
  });
  return data.embedding.values;
}

// ── cosine similarity ─────────────────────────────────────────────────────────

export function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

export function topK(queryVec, chunks, k = 5) {
  return chunks
    .map((c) => ({ ...c, score: cosineSim(queryVec, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ── RAG Q&A ───────────────────────────────────────────────────────────────────

export async function ragAnswer({ question, chunks, settings, apiKey, model = "gemini-2.5-flash-lite", onChunk }) {
  // support both old apiKey string and new settings object
  const _settings = settings || { apiKeys:[{key:apiKey}], activeKeyIndex:0 };
  const context = chunks.map((c, i) => `[Source ${i + 1} | Doc: ${c.docName} | Page: ${c.page || "?"}]\n${c.text}`).join("\n\n---\n\n");

  const systemPrompt = `You are a study assistant. Your job is to answer questions using the provided document excerpts.

IMPORTANT RULES:
1. If the answer is in the documents, answer from them and cite sources (e.g. "According to Source 2...").
2. If the answer is partially in the documents, answer what the documents cover, then add any supplemental info clearly prefixed with "Note: the following is general knowledge, not from your documents:".
3. If the answer is not in the documents at all, say "This topic does not appear in your uploaded documents." then provide a helpful general answer prefixed with "General knowledge (not from your documents):".
4. Never silently mix document facts with outside knowledge.

DOCUMENTS:
${context}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: question }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  };

  const r = await streamFetchWithRotation(
    `/models/${model}:streamGenerateContent?alt=sse`,
    _settings,
    body
  );

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let full = "";
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(6).trim();
      if (json === "[DONE]") continue;
      try {
        const parsed = JSON.parse(json);
        const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        full += text;
        onChunk?.(text, full);
      } catch {}
    }
  }
  return full;
}

// ── Subject naming ────────────────────────────────────────────────────────────

export async function nameSubject(docNames, settings) {
  const data = await geminiPostWithRotation(`/models/gemini-2.5-flash-lite:generateContent`, settings, {
    contents: [{ role: "user", parts: [{ text: `Given these uploaded file names, generate a concise and descriptive subject/topic name (3-6 words max, title case). Files: ${docNames.join(", ")}. Reply with ONLY the name, nothing else.` }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 32 },
  });
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "New Subject";
}

// ── Quiz generation ───────────────────────────────────────────────────────────

// ── Topic-aware chunk filtering ───────────────────────────────────────────────
// Identifies the academic topic of a document and filters out boilerplate
// (copyright pages, author bios, table of contents, etc.)

export async function filterTopicChunks(allChunks, settings, model = "gemini-2.5-flash-lite") {
  if (!allChunks.length) return allChunks;

  // Group by document
  const byDoc = {};
  allChunks.forEach(c => {
    if (!byDoc[c.docName]) byDoc[c.docName] = [];
    byDoc[c.docName].push(c);
  });

  const filtered = [];

  for (const [docName, chunks] of Object.entries(byDoc)) {
    // Use first 6 chunks to detect topic (cheap) — enough to see real content
    const sample = chunks.slice(0, 6).map(c => c.text.slice(0, 300)).join("\n---\n");

    let topicKeywords = [];
    try {
      const data = await geminiPostWithRotation(`/models/${model}:generateContent`, settings, {
        contents: [{ role: "user", parts: [{ text:
          `Analyze these excerpts from a document and return a JSON object with two fields:
1. "topic": the main academic subject (e.g. "trigonometry", "world war 2", "cell biology")
2. "keywords": an array of 8-12 specific content keywords that appear in real subject matter (NOT words like "copyright", "author", "republic", "act", "module", "department", "education", "learning objectives", "preface", "acknowledgment", "introduction", "page", "chapter", "lesson")

Excerpts:
${sample}

Reply ONLY with the JSON object, no markdown.` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
      });
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      const clean = raw.replace(/\`\`\`json|\`\`\`/g, "").trim();
      const parsed = JSON.parse(clean);
      topicKeywords = (parsed.keywords || []).map(k => k.toLowerCase());
    } catch (e) {
      console.warn("Topic detection failed for", docName, e.message);
      // If topic detection fails, keep all chunks
      filtered.push(...chunks);
      continue;
    }

    if (!topicKeywords.length) {
      filtered.push(...chunks);
      continue;
    }

    // Boilerplate patterns to always exclude
    const boilerplatePatterns = [
      /copyright|all rights reserved|published by|printed in|isbn|issn/i,
      /department of education|bureau of|republic act|deped|ched/i,
      /acknowledgment|acknowledgement|foreword|preface/i,
      /table of contents|list of figures|list of tables/i,
      /this module was designed|learning objectives|most essential/i,
      /what i need to know|what i know|what.s new|what is it|what.s more/i,
      /what i can do|additional activities|assessment|answer key/i,
      /\bpage\s+\d+\s*of\s*\d+\b/i,
    ];

    chunks.forEach(chunk => {
      const text = chunk.text.toLowerCase();

      // Skip obvious boilerplate
      if (boilerplatePatterns.some(p => p.test(chunk.text))) return;

      // Must have at least 1 topic keyword OR be longer substantive text
      const hasKeyword = topicKeywords.some(kw => text.includes(kw));
      const isSubstantive = chunk.text.trim().length > 120 && !text.match(/^(\w+\s*){1,8}$/);

      if (hasKeyword || isSubstantive) {
        filtered.push(chunk);
      }
    });
  }

  // Fallback — if filtering removed everything, return originals
  return filtered.length > 0 ? filtered : allChunks;
}

export async function generateQuiz({ chunks, config, settings, apiKey, model = "gemini-2.5-flash-lite" }) {
  const _settings = settings || { apiKeys:[{key:apiKey}], activeKeyIndex:0 };
  // Filter out boilerplate (copyright, author pages etc) then take top 30
  const topicFiltered = await filterTopicChunks(chunks, _settings, model).catch(() => chunks);
  const context = topicFiltered.slice(0, 30).map((c) => `[${c.docName} | p.${c.page || "?"}]\n${c.text}`).join("\n\n---\n\n");

  const typeLines = [];
  if (config.types.mc)       typeLines.push("multiple_choice");
  if (config.types.tf)       typeLines.push("true_false");
  if (config.types.freeform) typeLines.push("freeform");

  const withTimer = config.geminiTime && config.timerMode === "perq";

  // Clean JSON examples per type — no JS comments, pure valid JSON objects
  const mcExample = `{"type":"multiple_choice","question":"...","docName":"file.pdf","page":1,"difficulty":"medium","options":["Option A","Option B","Option C","Option D"],"correctIndex":0,"explanation":"..."}`;
  const tfExample = `{"type":"true_false","question":"...","docName":"file.pdf","page":2,"difficulty":"easy","answer":true,"explanation":"...","requireExplanation":${config.modifiedTF}}`;
  const ffExample = `{"type":"freeform","question":"...","docName":"file.pdf","page":3,"difficulty":"hard","modelAnswer":"...","rubric":["key point 1","key point 2"],"explanation":"..."}`;

  const examples = [];
  if (config.types.mc)       examples.push(mcExample);
  if (config.types.tf)       examples.push(tfExample);
  if (config.types.freeform) examples.push(ffExample);

  const timerNote = withTimer
    ? `\nAlso add "suggestedSeconds": <integer> to every question — your estimate of seconds a student needs to read, think, and answer it.`
    : "";

  const prompt = `You are a rigorous academic quiz generator.

Generate exactly ${config.numQ} quiz questions based ONLY on the document excerpts at the bottom of this prompt.
Question types to use (distribute evenly if more than one): ${typeLines.join(", ")}.${timerNote}

Rules:
- Output ONLY a raw JSON array. No markdown fences, no explanation, no text before or after the array.
- Every string value must be properly escaped. No unescaped quotes or literal newlines inside strings.
- Do not truncate — output all ${config.numQ} questions in full.
- Each question must reference a real fact from the documents.

JSON shape per type:
${examples.join("\n")}

DOCUMENTS:
${context}`;

  const data = await geminiPostWithRotation(`/models/${model}:generateContent`, _settings, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 65536,
    },
  });

  const raw   = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const clean = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "").trim();

  // Attempt 1: direct parse
  try { return JSON.parse(clean); } catch {}

  // Attempt 2: extract array portion
  const arrMatch = clean.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch {}
  }

  // Attempt 3: response got cut off — recover complete objects before the truncation point
  const startIdx = clean.indexOf("[");
  if (startIdx !== -1) {
    let partial = clean.slice(startIdx);
    const lastGood = partial.lastIndexOf("},");
    if (lastGood !== -1) {
      partial = partial.slice(0, lastGood + 1) + "]";
      try {
        const questions = JSON.parse(partial);
        if (questions.length > 0) {
          console.warn(`Quiz truncated — recovered ${questions.length} of ${config.numQ} questions.`);
          return questions;
        }
      } catch {}
    }
  }

  throw new Error(
    `Quiz generation failed to produce valid JSON. ` +
    `Try fewer questions or a single question type.`
  );
}


// ── Freeform answer grading ───────────────────────────────────────────────────

export async function gradeFreeform({ question, modelAnswer, rubric, userAnswer, settings, apiKey, model = "gemini-2.5-flash-lite" }) {
  const _settings = settings || { apiKeys:[{key:apiKey}], activeKeyIndex:0 };
  const prompt = `You are a brutally honest academic grader. Grade this student answer.

Question: ${question}
Model Answer: ${modelAnswer}
Rubric points to cover: ${rubric.join(", ")}
Student Answer: ${userAnswer}

Respond ONLY with JSON:
{
  "score": 0-100,
  "correct": true/false,
  "feedback": "detailed, honest feedback about what they got right and wrong",
  "missedPoints": ["rubric point they missed"],
  "hitPoints": ["rubric point they nailed"]
}`;

  const data = await geminiPostWithRotation(`/models/${model}:generateContent`, _settings, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
  });

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const clean = raw.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); }
  catch { return { score: 0, correct: false, feedback: raw, missedPoints: [], hitPoints: [] }; }
}

// ── Study chat ────────────────────────────────────────────────────────────────

export async function studyChat({ messages, chunks, settings, apiKey, model = "gemini-2.5-flash-lite", onChunk }) {
  const _settings = settings || { apiKeys:[{key:apiKey}], activeKeyIndex:0 };
  const context = chunks.map((c, i) => `[Source ${i + 1} | Doc: ${c.docName} | Page: ${c.page || "?"}]\n${c.text}`).join("\n\n---\n\n");

  const system = `You are a helpful, precise study assistant. Your primary job is to answer using the provided document excerpts.

IMPORTANT RULES:
1. If the answer is clearly in the documents, answer from them and cite sources.
2. If the answer is partially in the documents, answer what you can from them and explicitly say "Note: the following is based on general knowledge, not your uploaded documents:" before any supplemental info.
3. If the answer is not in the documents at all, say "This topic does not appear in your uploaded documents." then provide a general answer clearly prefixed with "General knowledge (not from your documents):".
4. Never silently mix document content with outside knowledge.

After your answer, output ALL document sources you drew from, one SOURCES_JSON per line — one for each distinct document/page used. Format exactly:
SOURCES_JSON:{"docName":"filename.pdf","page":1,"snippet":"first 80 chars of the relevant passage"}

If you used 3 sources, output 3 SOURCES_JSON lines. If you used none (fully general answer), output none.

DOCUMENTS:
${context}`;

  const body = {
    contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  };

  const r = await streamFetchWithRotation(
    `/models/${model}:streamGenerateContent?alt=sse`,
    _settings,
    body
  );

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let full = "";
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(6).trim();
      if (json === "[DONE]") continue;
      try {
        const parsed = JSON.parse(json);
        const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        full += text;
        onChunk?.(text, full);
      } catch {}
    }
  }
  return full;
}

export function parseSourcesFromReply(text) {
  // Collect ALL SOURCES_JSON lines — there may be multiple sources
  const regex = /SOURCES_JSON:(\{[^\n]+\})/g;
  const sources = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      // Deduplicate by docName+page combo
      const key = `${parsed.docName}||${parsed.page}`;
      if (!sources.find(s => `${s.docName}||${s.page}` === key)) {
        sources.push(parsed);
      }
    } catch {}
  }
  return sources.length > 0 ? sources : null;
}

export function stripSourcesJson(text) {
  // Remove ALL SOURCES_JSON lines
  return text.replace(/\n?SOURCES_JSON:\{[^\n]+\}/g, "").trim();
}
