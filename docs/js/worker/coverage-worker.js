// Classic Web Worker — parses a collection .db (SQLite) file off the main thread.
// Reads the `frames` table (session, session_group_id, session_group_name, ts_ms, lat, lon)
// and reduces each session's dense GPS trace down to a decimated polyline.

importScripts('https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-wasm.js');

const MIN_POINT_SPACING_M = 6; // drop points closer than this to the last kept point
let sqlJsPromise = null;

function loadSqlJs() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/${file}`,
    });
  }
  return sqlJsPromise;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function isValidLatLon(lat, lon) {
  return (
    typeof lat === 'number' && typeof lon === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lon) &&
    !(lat === 0 && lon === 0) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
  );
}

function decimateSessions(rows) {
  // rows: [session, session_group_id, session_group_name, ts_ms, lat, lon][], pre-sorted by session
  const sessions = new Map();

  for (const [session, groupId, groupName, tsMs, lat, lon] of rows) {
    if (!isValidLatLon(lat, lon)) continue;

    let s = sessions.get(session);
    if (!s) {
      s = {
        session: String(session),
        groupId: groupId != null ? String(groupId) : null,
        name: groupName || `Session ${session}`,
        startTs: tsMs,
        endTs: tsMs,
        points: [[lat, lon]],
        distanceM: 0,
      };
      sessions.set(session, s);
      continue;
    }

    s.endTs = tsMs;
    const last = s.points[s.points.length - 1];
    const dist = haversineMeters(last[0], last[1], lat, lon);
    if (dist >= MIN_POINT_SPACING_M) {
      s.distanceM += dist;
      s.points.push([lat, lon]);
    }
  }

  return [...sessions.values()].filter((s) => s.points.length >= 2);
}

self.onmessage = async function (e) {
  const { type, fileId } = e.data;
  if (type !== 'PARSE') return;

  try {
    const SQL = await loadSqlJs();
    const db = new SQL.Database(new Uint8Array(e.data.buffer));

    const tableCheck = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='frames'"
    );
    if (tableCheck.length === 0) {
      db.close();
      self.postMessage({ type: 'ERROR', fileId, message: 'No "frames" table found in database' });
      return;
    }

    const result = db.exec(
      `SELECT session, session_group_id, session_group_name, ts_ms, lat, lon
       FROM frames
       WHERE lat IS NOT NULL AND lon IS NOT NULL
       ORDER BY session, frame`
    );
    db.close();

    const rows = result.length > 0 ? result[0].values : [];
    const sessions = decimateSessions(rows);

    self.postMessage({ type: 'PARSED', fileId, sessions });
  } catch (err) {
    self.postMessage({ type: 'ERROR', fileId, message: err.message || String(err) });
  }
};
