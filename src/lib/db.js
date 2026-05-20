// IndexedDB wrapper — all persistent storage lives here
const DB_NAME = "studyrag";
const DB_VERSION = 2;

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("subjects")) {
        db.createObjectStore("subjects", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("documents")) {
        const ds = db.createObjectStore("documents", { keyPath: "id" });
        ds.createIndex("subjectId", "subjectId", { unique: false });
      }
      if (!db.objectStoreNames.contains("chunks")) {
        const cs = db.createObjectStore("chunks", { keyPath: "id", autoIncrement: true });
        cs.createIndex("docId", "docId", { unique: false });
        cs.createIndex("subjectId", "subjectId", { unique: false });
      }
      if (!db.objectStoreNames.contains("tests")) {
        const ts = db.createObjectStore("tests", { keyPath: "id" });
        ts.createIndex("subjectId", "subjectId", { unique: false });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const req = fn(s);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function txAll(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    fn(s, resolve, reject);
  });
}

// ── Subjects ──────────────────────────────────────────────────────────────────
export const getSubjects = () => new Promise(async (res, rej) => {
  const db = await openDB();
  const t = db.transaction("subjects", "readonly");
  const req = t.objectStore("subjects").getAll();
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

export const putSubject = (s) => tx("subjects", "readwrite", (store) => store.put(s));
export const deleteSubject = (id) => tx("subjects", "readwrite", (store) => store.delete(id));

// ── Documents ─────────────────────────────────────────────────────────────────
export const getDocsBySubject = (subjectId) => new Promise(async (res, rej) => {
  const db = await openDB();
  const t = db.transaction("documents", "readonly");
  const idx = t.objectStore("documents").index("subjectId");
  const req = idx.getAll(subjectId);
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

export const getDoc = (id) => tx("documents", "readonly", (s) => s.get(id));
export const putDoc = (d) => tx("documents", "readwrite", (s) => s.put(d));
export const deleteDoc = async (id) => {
  await tx("documents", "readwrite", (s) => s.delete(id));
  // also purge chunks
  const db = await openDB();
  await new Promise((res, rej) => {
    const t = db.transaction("chunks", "readwrite");
    const idx = t.objectStore("chunks").index("docId");
    const req = idx.openCursor(id);
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { cur.delete(); cur.continue(); }
      else res();
    };
    req.onerror = () => rej(req.error);
  });
};

// ── Chunks ────────────────────────────────────────────────────────────────────
export const putChunks = async (chunks) => {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction("chunks", "readwrite");
    const s = t.objectStore("chunks");
    chunks.forEach((c) => s.put(c));
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
};

export const getChunksBySubject = (subjectId) => new Promise(async (res, rej) => {
  const db = await openDB();
  const t = db.transaction("chunks", "readonly");
  const idx = t.objectStore("chunks").index("subjectId");
  const req = idx.getAll(subjectId);
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

// ── Tests ─────────────────────────────────────────────────────────────────────
export const getTestsBySubject = (subjectId) => new Promise(async (res, rej) => {
  const db = await openDB();
  const t = db.transaction("tests", "readonly");
  const idx = t.objectStore("tests").index("subjectId");
  const req = idx.getAll(subjectId);
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

export const putTest = (t) => tx("tests", "readwrite", (s) => s.put(t));
export const deleteTest = (id) => tx("tests", "readwrite", (s) => s.delete(id));

// ── Settings ──────────────────────────────────────────────────────────────────
export const getSetting = async (key, fallback = null) => {
  try {
    const r = await tx("settings", "readonly", (s) => s.get(key));
    return r ? r.value : fallback;
  } catch { return fallback; }
};

export const putSetting = (key, value) =>
  tx("settings", "readwrite", (s) => s.put({ key, value }));

export const getAllSettings = () => new Promise(async (res) => {
  const db = await openDB();
  const t = db.transaction("settings", "readonly");
  const req = t.objectStore("settings").getAll();
  req.onsuccess = () => {
    const obj = {};
    (req.result || []).forEach((r) => { obj[r.key] = r.value; });
    res(obj);
  };
  req.onerror = () => res({});
});
