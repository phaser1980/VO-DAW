/**
 * storage.js — IndexedDB persistence.
 *
 * Two object stores:
 *   projects : { id, name, updatedAt, data }   — the JSON project
 *   audio    : { key, blob, meta }             — one WAV blob per Take
 *
 * Audio is kept out of the project record on purpose: a 20-minute take is
 * ~200 MB of Float32 and has no business being (de)serialised every autosave.
 */

const DB_NAME = "statevo";
const DB_VERSION = 1;
const STORE_PROJECTS = "projects";
const STORE_AUDIO = "audio";
const STORE_PREFS = "prefs";

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        const s = db.createObjectStore(STORE_PROJECTS, { keyPath: "id" });
        s.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        db.createObjectStore(STORE_AUDIO, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORE_PREFS)) {
        db.createObjectStore(STORE_PREFS, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(db, store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ------------------------------- projects ------------------------------- */

export async function saveProject(project) {
  const db = await openDB();
  const rec = {
    id: project.id,
    name: project.name,
    updatedAt: Date.now(),
    data: project,
  };
  project.updatedAt = rec.updatedAt;
  await reqAsPromise(tx(db, STORE_PROJECTS, "readwrite").put(rec));
  return rec.updatedAt;
}

export async function loadProject(id) {
  const db = await openDB();
  const rec = await reqAsPromise(tx(db, STORE_PROJECTS).get(id));
  return rec ? rec.data : null;
}

export async function listProjects() {
  const db = await openDB();
  const all = await reqAsPromise(tx(db, STORE_PROJECTS).getAll());
  return all
    .map((r) => ({ id: r.id, name: r.name, updatedAt: r.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id, takeIds = []) {
  const db = await openDB();
  await reqAsPromise(tx(db, STORE_PROJECTS, "readwrite").delete(id));
  for (const t of takeIds) await deleteAudio(t);
}

/* -------------------------------- audio --------------------------------- */

export async function putAudio(key, blob, meta = {}) {
  const db = await openDB();
  await reqAsPromise(tx(db, STORE_AUDIO, "readwrite").put({ key, blob, meta }));
}

export async function getAudio(key) {
  const db = await openDB();
  const rec = await reqAsPromise(tx(db, STORE_AUDIO).get(key));
  return rec ? rec.blob : null;
}

export async function deleteAudio(key) {
  const db = await openDB();
  await reqAsPromise(tx(db, STORE_AUDIO, "readwrite").delete(key));
}

export async function audioKeys() {
  const db = await openDB();
  return reqAsPromise(tx(db, STORE_AUDIO).getAllKeys());
}

/* -------------------------------- prefs --------------------------------- */

export async function setPref(key, value) {
  const db = await openDB();
  await reqAsPromise(tx(db, STORE_PREFS, "readwrite").put({ key, value }));
}

export async function getPref(key, fallback = null) {
  const db = await openDB();
  const rec = await reqAsPromise(tx(db, STORE_PREFS).get(key));
  return rec ? rec.value : fallback;
}

/* -------------------------------- quota --------------------------------- */

/** Best-effort storage usage, for the status bar. Not supported everywhere. */
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

/**
 * Ask the browser to make this origin's storage persistent, so a long
 * session's takes don't get evicted under storage pressure. Silently
 * best-effort — Chrome grants it based on engagement heuristics.
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
