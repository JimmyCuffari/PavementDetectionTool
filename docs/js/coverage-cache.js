// IndexedDB cache for parsed collection-db results, keyed by Drive file ID.
// Avoids re-downloading and re-parsing large (100MB+) .db files on every scan.

const DB_NAME    = 'pavement_coverage_cache';
const DB_VERSION = 1;
const STORE      = 'files';

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'fileId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _dbPromise;
}

// Returns the cached entry for fileId if its size+modifiedTime still match, else null.
export async function getCached(fileId, size, modifiedTime) {
  try {
    const db = await openDb();
    const entry = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(fileId);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(req.error);
    });
    if (!entry) return null;
    if (entry.size !== size || entry.modifiedTime !== modifiedTime) return null;
    return entry.sessions;
  } catch {
    return null;
  }
}

export async function putCached(fileId, size, modifiedTime, sessions) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ fileId, size, modifiedTime, sessions, cachedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch { /* cache is best-effort */ }
}

export async function clearCache() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}
