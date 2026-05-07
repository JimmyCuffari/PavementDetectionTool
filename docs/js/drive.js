import { refreshToken } from './auth.js';
import { slugify, isoNow, makeSemaphore } from './utils.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const ROOT_FOLDER_NAME = 'PavementDataset';
const UPLOAD_CONCURRENCY = 4;

const sem = makeSemaphore(UPLOAD_CONCURRENCY);

// Cache folder IDs for the session to avoid redundant API queries
const folderCache = new Map();

// ── Low-level helpers ──────────────────────────────────────────────────────────

async function driveRequest(token, url, options = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...options.headers };
  const resp = await fetch(url, { ...options, headers });
  if (resp.status === 401) {
    const newToken = await refreshToken();
    return driveRequest(newToken, url, options);
  }
  return resp;
}

async function driveList(token, q, fields = 'files(id,name)') {
  const params = new URLSearchParams({ q, fields, pageSize: 50 });
  const resp = await driveRequest(token, `${DRIVE_API}/files?${params}`);
  return resp.json();
}

// ── Folder management ──────────────────────────────────────────────────────────

async function findOrCreateFolder(token, name, parentId) {
  const cacheKey = `${parentId}/${name}`;
  if (folderCache.has(cacheKey)) return folderCache.get(cacheKey);

  const q = `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const result = await driveList(token, q, 'files(id,name)');

  if (result.files && result.files.length > 0) {
    folderCache.set(cacheKey, result.files[0]);
    return result.files[0];
  }

  const folder = await uploadMultipart(token, {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId],
  }, null);
  folderCache.set(cacheKey, folder);
  return folder;
}

// Returns { rootId, framesId, labelsId } for a given video name
export async function ensureFolderPath(token, videoName) {
  const root = await findOrCreateFolder(token, ROOT_FOLDER_NAME, 'root');
  const slug = slugify(videoName.replace(/\.mp4$/i, ''));
  const videoFolder = await findOrCreateFolder(token, slug, root.id);
  const framesFolder = await findOrCreateFolder(token, 'frames', videoFolder.id);
  const labelsFolder = await findOrCreateFolder(token, 'labels', videoFolder.id);
  return { rootId: root.id, framesId: framesFolder.id, labelsId: labelsFolder.id };
}

// ── File upload ────────────────────────────────────────────────────────────────

// Multipart upload — handles both blobs and null (for folder creation)
export async function uploadMultipart(token, metadata, blob) {
  const boundary = 'apdd_mp_boundary';
  const metaJson = JSON.stringify(metadata);

  let body;
  let contentType;

  if (blob === null) {
    // Folder creation — no file body needed, use regular JSON endpoint
    const resp = await driveRequest(token, `${DRIVE_API}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: metaJson,
    });
    return resp.json();
  }

  const parts = [
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metaJson}\r\n`,
    `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ];
  body = new Blob(parts);
  contentType = `multipart/related; boundary=${boundary}`;

  const resp = await driveRequest(
    token,
    `${DRIVE_UPLOAD}/files?uploadType=multipart`,
    { method: 'POST', headers: { 'Content-Type': contentType }, body }
  );
  return resp.json();
}

// Upload a single file with semaphore-controlled concurrency
export function uploadFile(token, folderId, filename, mimeType, blob) {
  return sem(() =>
    uploadMultipart(token, { name: filename, mimeType, parents: [folderId] }, blob)
  );
}

// ── Tracking log ───────────────────────────────────────────────────────────────

// Find PavementDataset root without creating it
export async function findRootFolder(token) {
  const q = `name='${ROOT_FOLDER_NAME}' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const result = await driveList(token, q, 'files(id,name)');
  return result.files?.[0] ?? null;
}

// Paginated file listing — fileFields is the inner mask e.g. 'id,name'
export async function listAllFiles(token, q, fileFields = 'id,name,mimeType') {
  const allFiles = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ q, fields: `nextPageToken,files(${fileFields})`, pageSize: 1000 });
    if (pageToken) params.set('pageToken', pageToken);
    const resp = await driveRequest(token, `${DRIVE_API}/files?${params}`);
    const data = await resp.json();
    if (data.files) allFiles.push(...data.files);
    pageToken = data.nextPageToken ?? null;
  } while (pageToken);
  return allFiles;
}

// Fetch a file's raw content as ArrayBuffer
export async function downloadFileContent(token, fileId) {
  const resp = await driveRequest(token, `${DRIVE_API}/files/${fileId}?alt=media`);
  if (!resp.ok) throw new Error(`${resp.status}`);
  return resp.arrayBuffer();
}

export async function appendTracking(token, rootId, entry) {
  const filename = 'tracking.json';
  const q = `name='${filename}' and '${rootId}' in parents and trashed=false`;
  const search = await driveList(token, q, 'files(id)');

  const newEntry = { timestamp: isoNow(), ...entry };
  let entries = [newEntry];

  if (search.files && search.files.length > 0) {
    const fileId = search.files[0].id;
    try {
      const mediaResp = await driveRequest(token, `${DRIVE_API}/files/${fileId}?alt=media`);
      const existing = await mediaResp.json();
      if (Array.isArray(existing)) entries = [...existing, newEntry];
    } catch { /* start fresh if file is corrupt */ }

    // Update existing file via PATCH
    const boundary = 'apdd_mp_boundary';
    const metaJson = JSON.stringify({});
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metaJson}\r\n`,
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    await driveRequest(token, `${DRIVE_UPLOAD}/files/${fileId}?uploadType=multipart`, {
      method: 'PATCH',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  } else {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    await uploadMultipart(token, { name: filename, mimeType: 'application/json', parents: [rootId] }, blob);
  }
}
