// Classic Web Worker (no ES module imports) — compatible with all modern browsers
// Receives UPLOAD_FRAME messages from the main thread and uploads each frame to Drive

const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_API    = 'https://www.googleapis.com/drive/v3';
const BOUNDARY     = 'apdd_worker_boundary';
const MAX_RETRIES  = 3;

let token   = null;
let folderId = null;

self.onmessage = async function(e) {
  const { type } = e.data;

  if (type === 'INIT') {
    token    = e.data.token;
    folderId = e.data.folderId;
    return;
  }

  if (type === 'UPDATE_TOKEN') {
    token = e.data.token;
    return;
  }

  if (type === 'UPLOAD_FRAME') {
    const { frameIndex, arrayBuffer, filename } = e.data;
    const blob = new Blob([arrayBuffer], { type: 'image/jpeg' });
    try {
      await uploadWithRetry(filename, blob);
      self.postMessage({ type: 'FRAME_DONE', frameIndex });
    } catch (err) {
      self.postMessage({ type: 'FRAME_ERROR', frameIndex, message: err.message });
    }
  }
};

async function uploadWithRetry(filename, blob, attempt = 0) {
  const metaJson = JSON.stringify({
    name: filename,
    mimeType: 'image/jpeg',
    parents: [folderId],
  });

  const body = new Blob([
    `--${BOUNDARY}\r\nContent-Type: application/json\r\n\r\n${metaJson}\r\n`,
    `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n\r\n`,
    blob,
    `\r\n--${BOUNDARY}--`,
  ]);

  const resp = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${BOUNDARY}`,
    },
    body,
  });

  if (resp.status === 401 && attempt < MAX_RETRIES) {
    // Signal main thread to refresh token and wait for it
    self.postMessage({ type: 'NEED_TOKEN' });
    // Main thread will send UPDATE_TOKEN; use a Promise that resolves on next UPDATE_TOKEN
    await waitForToken();
    return uploadWithRetry(filename, blob, attempt + 1);
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Upload failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  return resp.json();
}

// Resolve when the next UPDATE_TOKEN message arrives
function waitForToken() {
  return new Promise((resolve) => {
    const handler = (e) => {
      if (e.data.type === 'UPDATE_TOKEN') {
        token = e.data.token;
        self.removeEventListener('message', handler);
        resolve();
      }
    };
    self.addEventListener('message', handler);
  });
}
