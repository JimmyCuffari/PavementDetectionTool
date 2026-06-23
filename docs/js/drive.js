import { refreshToken } from './auth.js';
import { slugify, isoNow, makeSemaphore } from './utils.js';
import { SHARED_FOLDER_ID } from './config.js';

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
  const params = new URLSearchParams({ q, fields, pageSize: 50, supportsAllDrives: true, includeItemsFromAllDrives: true });
  const resp = await driveRequest(token, `${DRIVE_API}/files?${params}`);
  return resp.json();
}

// ── Folder management ──────────────────────────────────────────────────────────

export async function findOrCreateFolder(token, name, parentId) {
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

// Returns { rootId, framesId, labelsId } for a given video name.
// rootId overrides SHARED_FOLDER_ID when provided (used for project-scoped uploads).
export async function ensureFolderPath(token, videoName, rootId = null) {
  let root;
  if (rootId) {
    root = { id: rootId };
  } else if (SHARED_FOLDER_ID) {
    root = { id: SHARED_FOLDER_ID };
  } else {
    root = await findOrCreateFolder(token, ROOT_FOLDER_NAME, 'root');
  }
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
    const resp = await driveRequest(token, `${DRIVE_API}/files?supportsAllDrives=true`, {
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
    `${DRIVE_UPLOAD}/files?uploadType=multipart&supportsAllDrives=true`,
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

// Returns Map<filename, fileId> for all non-trashed files in a folder
export async function indexFolderFiles(token, folderId) {
  const files = await listAllFiles(token, `'${folderId}' in parents and trashed=false`, 'id,name');
  return new Map(files.map(f => [f.name, f.id]));
}

// Create or update a file depending on whether existingId is provided
export function upsertFile(token, folderId, filename, mimeType, blob, existingId) {
  return sem(async () => {
    if (!existingId) {
      return uploadMultipart(token, { name: filename, mimeType, parents: [folderId] }, blob);
    }
    const boundary = 'apdd_mp_boundary';
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n{}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    const resp = await driveRequest(token, `${DRIVE_UPLOAD}/files/${existingId}?uploadType=multipart&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return resp.json();
  });
}

// ── Tracking log ───────────────────────────────────────────────────────────────

// Find PavementDataset root without creating it
export async function findRootFolder(token) {
  if (SHARED_FOLDER_ID) return { id: SHARED_FOLDER_ID, name: ROOT_FOLDER_NAME };
  const q = `name='${ROOT_FOLDER_NAME}' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const result = await driveList(token, q, 'files(id,name)');
  return result.files?.[0] ?? null;
}

// Paginated file listing — fileFields is the inner mask e.g. 'id,name'
export async function listAllFiles(token, q, fileFields = 'id,name,mimeType') {
  const allFiles = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ q, fields: `nextPageToken,files(${fileFields})`, pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true });
    if (pageToken) params.set('pageToken', pageToken);
    const resp = await driveRequest(token, `${DRIVE_API}/files?${params}`);
    const data = await resp.json();
    if (data.files) allFiles.push(...data.files);
    pageToken = data.nextPageToken ?? null;
  } while (pageToken);
  return allFiles;
}

// Check if a folder exists without creating it — returns {id,name} or null
export async function findFolder(token, name, parentId) {
  const q = `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const result = await driveList(token, q, 'files(id,name)');
  return result.files?.[0] ?? null;
}

// Permanently delete a file or folder
export async function deleteFile(token, fileId) {
  const resp = await driveRequest(token, `${DRIVE_API}/files/${fileId}?supportsAllDrives=true`, { method: 'DELETE' });
  return resp.ok || resp.status === 204;
}

// Rename a file or folder (metadata-only PATCH)
export async function renameFile(token, fileId, newName) {
  const resp = await driveRequest(token, `${DRIVE_API}/files/${fileId}?supportsAllDrives=true`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  });
  return resp.json();
}

// Copy a file within Drive to a new parent folder (avoids download+re-upload)
export async function copyFileToDrive(token, fileId, name, parentId) {
  return sem(async () => {
    const resp = await driveRequest(token, `${DRIVE_API}/files/${fileId}/copy?supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parents: [parentId] }),
    });
    return resp.json();
  });
}

// Fetch a file's raw content as ArrayBuffer
export async function downloadFileContent(token, fileId) {
  const resp = await driveRequest(token, `${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`);
  if (!resp.ok) throw new Error(`${resp.status}`);
  return resp.arrayBuffer();
}

export async function writeJsonFile(token, folderId, filename, data) {
  const q = `name='${filename}' and '${folderId}' in parents and trashed=false`;
  const search = await driveList(token, q, 'files(id)');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const existingId = search.files?.[0]?.id ?? null;
  return upsertFile(token, folderId, filename, 'application/json', blob, existingId);
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
      const mediaResp = await driveRequest(token, `${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`);
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
    await driveRequest(token, `${DRIVE_UPLOAD}/files/${fileId}?uploadType=multipart&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  } else {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    await uploadMultipart(token, { name: filename, mimeType: 'application/json', parents: [rootId] }, blob);
  }
}
