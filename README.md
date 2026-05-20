# StudyRAG

A fully local, browser-based RAG study app. Upload your documents, chat with them, quiz yourself, and study with cited source-jumping, powered by your own Gemini API key, no server required, everything stored in your browser.

## Quick Start

```bash
npm install
npm run dev
# http://localhost:5173
```

1. Click the gear icon (top right) → **General**
2. Paste your Gemini API key → **Save Settings**
3. Click **+** in the sidebar → create a subject
4. Add your documents
5. Pick a mode: Q&A, Quiz, or Study

**Get a free API key:** https://aistudio.google.com/app/apikey

## Project Structure

- `index.html` — entry point, loads pdf.js and mammoth.js from CDN
- `vite.config.js` — Vite config (React plugin, port 5173)
- `package.json` — react, react-dom, vite, @vitejs/plugin-react
- `src/main.jsx` — React root, wraps app in AppProvider
- `src/App.jsx` — shell: layout, sidebar, modals, global CSS, shared exports (Icon, Toggle, LoadingSpinner, DocTypeIcon, processDocuments, keywordSearch)
- `src/lib/db.js` — IndexedDB wrapper, all persistent storage
- `src/lib/gemini.js` — all Gemini API calls: extract, chunk, embed, RAG answer, quiz gen, grading, study chat
- `src/lib/themes.js` — 8 dark + 4 light color themes, 52 fonts, DEFAULT_SETTINGS
- `src/lib/context.jsx` — React context: settings, theme, save to IDB
- `src/pages/SubjectHome.jsx` — subject landing: doc list, add/remove, modes
- `src/pages/QAMode.jsx` — streaming RAG chat with expandable source panel
- `src/pages/QuizMode.jsx` — quiz engine: config, take, timer, grade, history
- `src/pages/StudyMode.jsx` — split view: continuous-scroll viewer + RAG chat

## How It Works

### Document ingestion

When you add a file, text is extracted based on type:

- **PDF** — pdf.js, page-by-page with `[Page N]` markers preserved
- **DOCX** — mammoth.js raw text
- **TXT/MD** — native read
- **Images** — stored for viewing, not indexed (no text)

Text is then chunked (semantic, fixed, or page-based), each chunk is embedded via `text-embedding-004`, and the chunks and vectors are saved to IndexedDB.

### Query time (Q&A, Study chat, Quiz generation)

The user's question is embedded, compared against all stored chunk vectors via cosine similarity, and the top-K most relevant chunks are sent as context to Gemini, which streams the response token by token.

### Fallback when embeddings aren't available

If embedding fails (API error, rate limit, no key), keyword search automatically kicks in — splits the query into words, counts matches per chunk, returns the top-K. Less semantic, still useful.

## Features

### Subjects

- **Create** with the + button in the sidebar or from the home screen
- **Auto-name with Gemini** — leave the name blank and Gemini reads your file names to suggest one (toggle between auto/manual)
- **Rename** inline from the Subject Home page
- **Delete** — removes the subject, all documents, and all embeddings permanently
- Each subject is fully isolated — documents, chunks, and tests never cross subjects
- Sidebar shows doc count per subject

### Documents

#### Supported file types

| Type | Indexed for RAG | Viewer |
|------|----------------|--------|
| PDF | Full text + page numbers | Continuous scroll, all pages rendered, zoom |
| DOCX / DOC | mammoth.js text extraction | Continuous scroll paragraphs, snippet highlight |
| TXT / MD | Native | Continuous scroll paragraphs, snippet highlight |
| PNG / JPG / JPEG / WEBP / GIF | No text to index | Zoom viewer |
| PPTX | Best-effort text | Text fallback |

#### Managing documents

- **Add** from the Subject Home doc panel (click "Add files") or during subject creation
- **Remove** with the trash icon — also deletes all embeddings for that document
- Files are stored as base64 in IndexedDB so the viewer can display them without re-uploading
- Processing progress (extracting → chunking → embedding) is shown inline

### Q&A Mode

Streaming chat that answers strictly from your uploaded documents.

1. Question embedded → top-K chunks retrieved by cosine similarity
2. Chunks formatted as `[Source N | Doc: X | Page: Y]` context blocks
3. Sent to Gemini with a system prompt enforcing document-only answers
4. Response streams in token by token

Other features:
- Streaming response with blinking cursor while generating
- **Sources panel** (expandable per message) — shows each retrieved chunk with document name, page number, relevance % score, and a snippet preview
- Keyword fallback if embedding fails
- "Clear chat" button
- Enter to send, Shift+Enter for a new line
- Index info shown in header (total chunks, how many have embeddings)

### Quiz / Test Mode

Three tabs: **Configure**, **Take Test**, **History**.

#### Configure

**Question types** — mix any combination:

| Type | Description |
|------|-------------|
| Multiple Choice | 4 options (A–D), Gemini writes the distractors |
| True / False | Standard true/false buttons |
| Modified T/F | If the student picks False, they must type an explanation before checking. Toggled independently from T/F. |
| Freeform text | Open answer, Gemini grades 0–100 with detailed feedback |

**Number of questions:** 1–50

**Feedback options:**

| Option | Default | Effect |
|--------|---------|--------|
| Explain correct answers | On | Shows Gemini's explanation when you get it right |
| Explain wrong answers | On | Shows explanation when you get it wrong |

Both can be independently toggled off if you prefer to review later.

**Timer modes:**

| Mode | Behaviour |
|------|-----------|
| No timer | Fully untimed |
| Whole-test countdown | Single timer for the entire test — auto-finishes when it hits zero |
| Per-question countdown | Each question has its own countdown — auto-advances when time runs out |

For per-question mode you can set a fixed number of seconds per question, or toggle **"Gemini decides time"** — Gemini estimates how long each question should take based on complexity and difficulty. The estimated seconds are baked into the quiz JSON at generation time.

**Stopwatch:** Independently toggleable — records total elapsed time regardless of timer mode. Result shown on the completion screen.

**Pause:** Freezes all timers and hides question content so you can't read ahead.

**Test name:** Optional — used in History. Left blank it auto-names with the date.

**Generate Test** sends up to 40 document chunks as context to Gemini along with your exact config and receives a JSON array of questions with correct answers, explanations, difficulty ratings, source references, and optional `suggestedSeconds`.

#### Take Test

- Progress bar across the top
- **Per-question mode:** large countdown shown beside the question
- **Whole-test mode:** compact countdown in the header bar
- **Stopwatch:** elapsed time shown alongside
- **Pause button** appears whenever any timer is active

**Multiple Choice:** Click an option → "Check answer" → green highlight on correct, red on wrong, correct option always revealed.

**True / False:** Tap True or False → reveal with color feedback. If Modified T/F is active and you picked False, a text area appears for your explanation before you can check.

**Freeform:** Type your answer → "Grade answer" → Gemini returns a score (0–100), a verdict, detailed feedback, which rubric points you hit and missed, and a collapsible model answer.

**Navigation:** Previous/Next buttons — go back and review already-answered questions anytime.

**Finish Test** button available at any point, or auto-triggers when the whole-test timer expires.

#### Results screen

- Score as fraction + percentage
- Color-coded progress bar: green ≥80%, yellow ≥60%, red <60%
- Stopwatch total (if enabled)
- **Retake** (same questions, reset everything) or **Back to config**

#### History tab

- Every generated test is automatically saved to IndexedDB
- Shows: name, question count, types used, date
- **Load & Retake** — restores exact questions and config, jumps straight to Take Test
- **Delete** — removes the saved test

### Study Mode

Split-panel layout: document viewer on the left, RAG chat on the right.

#### Document viewer (left)

- Back/Forward buttons with full history — switching docs via "View Source" or tabs is tracked like browser navigation
- "Address bar" shows the current document name
- One tab per document for quick switching, active tab highlighted in accent color

**PDF viewer:** All pages rendered as stacked canvases in one scrollable column. Page number badge shown in the corner of each page. Zoom in/out re-renders all pages at the new scale. When a source is cited in chat, the viewer scrolls to the correct page and flashes a green border around it for ~3 seconds.

**DOCX / TXT / MD viewer:** Text split into paragraphs, each rendered as its own block. When a source is cited in chat, the matching paragraph is highlighted with a green mark that fades out.

**Image viewer:** Zoom in/out with reset button.

#### Chat panel (right)

- Same RAG pipeline as Q&A mode (embed → top-K → stream)
- Gemini appends a `SOURCES_JSON` block to each response with source doc name, page number, and a text snippet — parsed and stripped before display
- After each AI message: a **View source** button shows the document name and page
- Clicking it navigates the viewer to that document and scrolls/highlights the relevant section with a green flash

### Settings

Three tabs — all settings saved to IndexedDB, persist across sessions.

#### General

| Setting | Notes |
|---------|-------|
| Gemini API Key | Stored in your browser only. Never sent anywhere except Google's API. |
| Model | See model table below |

**Models:**

| Model | Speed | Quality | Free tier |
|-------|-------|---------|-----------|
| `gemini-2.5-flash-lite` | Fastest | Good | Generous (default) |
| `gemini-2.5-flash` | Fast | Better | Generous |
| `gemini-2.5-pro` | Slower | Best | Daily limit applies |

#### Appearance

8 dark themes: Obsidian, Forest, Crimson, Amber, Sapphire, Violet, Teal, Slate

4 light themes: Paper, Meadow, Blush, Sand

Theme changes apply instantly via CSS custom properties — no reload needed.

52 fonts across all categories:

- **Sans-serif:** Outfit, DM Sans, Syne, Karla, Nunito, Lato, Raleway, Cabin, Barlow, Exo 2, Rubik, Manrope, Plus Jakarta Sans, Lexend, Quicksand, Josefin Sans, Poppins, Work Sans, Mulish, IBM Plex Sans
- **Serif:** Merriweather, Playfair Display, Libre Baskerville, PT Serif, Lora, Source Serif 4, Crimson Pro, EB Garamond, Cormorant Garamond
- **Monospace:** IBM Plex Mono, JetBrains Mono, Fira Code, Source Code Pro, Space Mono, Courier Prime, Anonymous Pro, Inconsolata, Roboto Mono, Ubuntu Mono, Share Tech Mono, Azeret Mono, Red Hat Mono
- **Display / handwriting:** Comic Neue, Pacifico, Permanent Marker, Special Elite, Caveat, Kalam, Patrick Hand, Architects Daughter

A live preview sentence updates immediately when you pick a font.

#### RAG / AI

| Setting | Default | What it does |
|---------|---------|-------------|
| Chunk size (words) | 512 | Words per document chunk. Smaller = more precise retrieval. Larger = richer context per chunk. |
| Chunk overlap (words) | 64 | Words shared between adjacent chunks to avoid cutting off context at boundaries. |
| Top-K | 5 | How many chunks are sent to Gemini per query. More = richer context, more tokens used. |
| Temperature | 0.2 | 0 = factual/deterministic, 1 = creative/varied. Keep 0.1–0.3 for study use. |
| Embedding strategy | Semantic | See below |

**Embedding strategies:**

| Strategy | Best for |
|----------|---------|
| Semantic | Most documents — splits on paragraph boundaries, then merges to chunk size |
| Fixed-size | Dense technical text — strict word count windows |
| Page-based | PDFs where you want page-level precision — one chunk per page, page numbers match the viewer exactly |

> Changing RAG/chunk settings only affects newly added documents. To reprocess existing documents with new settings, remove and re-add them.

## IndexedDB Schema

**Database name:** `studyrag` — **Version:** 2

### `subjects` (keyPath: `id`)
```js
{
  id:         string,   // UUID
  name:       string,
  createdAt:  number,   // timestamp ms
  updatedAt:  number,
  docCount:   number,
}
```

### `documents` (keyPath: `id`, index: `subjectId`)
```js
{
  id:         string,   // UUID
  subjectId:  string,
  name:       string,
  type:       string,   // "pdf" | "docx" | "txt" | "png" | etc.
  size:       number,   // bytes
  addedAt:    number,
  fileData:   string,   // base64-encoded file (for viewer)
  mimeType:   string,
}
```

### `chunks` (keyPath: `id` autoIncrement, indexes: `docId`, `subjectId`)
```js
{
  id:         number,   // auto
  subjectId:  string,
  docId:      string,
  docName:    string,
  text:       string,   // chunk content
  page:       number|null,
  embedding:  number[]|null,  // 768-dim float32 from text-embedding-004
}
```

### `tests` (keyPath: `id`, index: `subjectId`)
```js
{
  id:         string,   // UUID
  subjectId:  string,
  name:       string,
  config:     object,   // full QuizConfig saved with the test
  questions:  array,    // full question array from Gemini
  createdAt:  number,
}
```

### `settings` (keyPath: `key`)
```js
{ key: string, value: any }
// Keys: apiKey, colorTheme, font, model, chunkSize,
//       chunkOverlap, topK, temperature, embedStrategy
```

## Gemini Free Tier

| Model | Requests/min | Requests/day |
|-------|-------------|-------------|
| gemini-2.5-flash-lite | 15 | 1,500 |
| gemini-2.5-flash | 10 | 500 |
| gemini-2.5-pro | 5 | 25 |
| text-embedding-004 | 1,500 | Unlimited |

For personal studying — a few subjects, a handful of documents, daily sessions — you will almost certainly never hit a limit using `gemini-2.5-flash-lite`. Each Q&A message, quiz generation, or study chat message is one API call.

The only thing to watch: quiz generation sends up to 40 chunks as context (large prompt), but it's still one call. Freeform answer grading is one call per question.

## Deploy Live

The app is entirely static — no server, no backend.

```bash
npm run build
# Output: dist/
```

**Vercel:**
```bash
npx vercel --prod
```

**Netlify:**
```bash
npx netlify deploy --prod --dir=dist
```

**GitHub Pages** — first add `base` to `vite.config.js`:
```js
export default defineConfig({
  base: '/your-repo-name/',
  plugins: [react()],
})
```
Then push `dist/` to the `gh-pages` branch.

**nginx:**
```nginx
server {
  listen 80;
  root /var/www/studyrag/dist;
  index index.html;
  location / { try_files $uri $uri/ /index.html; }
}
```

Each user brings their own API key. Data stays in their own browser's IndexedDB — no accounts, no sync, no server costs.

## Troubleshooting

**"No document chunks found"** — You've added documents but they weren't embedded. This happens if your API key wasn't set at upload time — embedding runs at upload, not at query time. Remove the documents and re-add them with the key set.

**PDF pages are blank / white** — `pdf.js` loads from CDN, so check your internet connection. Very large PDFs (100+ pages) can take a few seconds to render all pages after loading.

**Quiz generation fails or returns garbled JSON** — Gemini occasionally trips on complex multi-type prompts. Retry. If it keeps failing, reduce the question count or use a single question type. Switching from `gemini-2.5-flash-lite` to `gemini-2.5-flash` also helps with JSON reliability.

**Freeform grading says "Grading failed"** — Usually a rate limit or token limit issue. Wait a moment and try "Grade answer" again. If you're using `gemini-2.5-pro`, remember the 25 req/day limit.

**Embedding hits rate limit (429 error)** — `text-embedding-004` allows 1,500 requests/minute. This only happens if you're uploading a massive library all at once. The app falls back to keyword search automatically in the meantime.

**DOCX text looks garbled** — `mammoth.js` handles standard `.docx` well but can struggle with complex layouts (multi-column, heavy tables, embedded objects). Export to PDF for best results with complex documents.

**Settings not saving** — Some browsers block IndexedDB in private/incognito mode. Use a normal browser window.

**"Model not found" error** — Your saved settings may have an old model name (e.g. `gemini-1.5-flash`). Go to Settings → General → change the model to `gemini-2.5-flash-lite` → Save Settings.

## Extending

### Add a color theme

In `src/lib/themes.js`, add an object to `DARK_THEMES` or `LIGHT_THEMES`:

```js
{
  id:       "my-theme",
  label:    "My Theme",
  accent:   "#hex",      // primary color (buttons, links, highlights)
  accentFg: "#hex",      // text on top of accent
  bg:       "#hex",      // page background
  surface:  "#hex",      // card / panel background
  surface2: "#hex",      // input / hover / secondary background
  border:   "#hex",      // all borders
  text:     "#hex",      // primary text
  muted:    "#hex",      // secondary / placeholder text
}
```

### Add a font

Add its exact Google Fonts name to the `FONTS` array in `src/lib/themes.js`. The app loads it from Google Fonts automatically when selected.

### Add a new quiz question type

1. Add a key to `DEFAULT_CONFIG.types` in `QuizMode.jsx`
2. Add a `Toggle` row for it in `ConfigPanel`
3. Describe the new type's JSON shape in the `generateQuiz` prompt in `gemini.js`
4. Add a rendering block in `TestTaker` for the new `q.type`

### Add PPTX slide-by-slide viewing

Currently PPTX falls back to text. To add proper slide viewing:

```bash
npm install pptxgenjs
```

Parse the PPTX to extract slide images or SVGs, then render them with Previous/Next buttons in `StudyMode.jsx`.

### Add cloud sync / multi-device

Replace `db.js` calls with API calls to any backend (Supabase, Firebase, PocketBase). Keep IndexedDB as a local cache for instant loads. No other changes needed — the rest of the app doesn't know where data comes from.

### Improve source citation accuracy

Currently Gemini is asked to return a `docName` and `page` in its `SOURCES_JSON` block, which is approximately correct. For exact accuracy:

1. Store character byte offsets when chunking in `db.js`
2. After each answer, find the matching chunk by text similarity
3. Use the stored offset to highlight the exact span in `TextViewer` or jump to the exact page in `PDFViewer`