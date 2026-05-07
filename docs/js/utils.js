export function slugify(str) {
  return str
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_\-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

export function isoNow() {
  return new Date().toISOString();
}

export function toast(message, type = 'info', durationMs = 4000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

// Promise-based semaphore for capping concurrent uploads
export function makeSemaphore(limit) {
  let active = 0;
  const queue = [];

  function next() {
    if (queue.length === 0 || active >= limit) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  }

  return function acquire(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// Collect all File objects from a DataTransferItemList (supports nested dirs)
export async function collectFilesFromDrop(dataTransferItems) {
  const files = [];
  const entries = [];
  for (const item of dataTransferItems) {
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  await Promise.all(entries.map(e => readEntry(e, files)));
  return files;
}

async function readEntry(entry, files) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    files.push(file);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      await Promise.all(batch.map(e => readEntry(e, files)));
    } while (batch.length > 0);
  }
}
