// Replace with your OAuth 2.0 Client ID from Google Cloud Console
export const CLIENT_ID = '799785166783-rgpmjt05nko3io6nkh5u95n0khrnc4f6.apps.googleusercontent.com';

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

let tokenClient = null;
let currentToken = null;
let currentUser = null;
let _onSignedIn = null;
let _refreshPromise = null;
let _finishRefresh = null;   // settles _refreshPromise: called with an Error on failure, nothing on success
let tokenExpiresAt = 0;      // ms timestamp; Google access tokens last about an hour

const REFRESH_TIMEOUT_MS = 2 * 60 * 1000;
const EXPIRY_MARGIN_MS   = 5 * 60 * 1000;

// Call once after both GIS and GAPI scripts have loaded
export function initAuth(onSignedIn) {
  _onSignedIn = onSignedIn;
  gapi.load('client', async () => {
    await gapi.client.init({
      discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'],
    });
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: async (resp) => {
        if (resp.error) {
          console.error('OAuth error:', resp.error);
          _finishRefresh?.(new Error(`Google sign-in failed (${resp.error})`));
          return;
        }
        currentToken = resp.access_token;
        tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        // A refresh keeps the same account, so the app doesn't need to set itself up again
        if (_finishRefresh) { _finishRefresh(); return; }
        currentUser = await fetchUserInfo(currentToken);
        _onSignedIn(currentUser);
      },
      // The sign-in window couldn't open (often blocked as a popup) or was closed
      error_callback: (err) => {
        console.error('OAuth popup error:', err);
        _finishRefresh?.(new Error(err?.type === 'popup_failed_to_open'
          ? 'your Google sign-in expired and the browser blocked the sign-in window. Allow popups for this site, or try again'
          : 'your Google sign-in expired and wasn\'t renewed. Try again'));
      },
    });
  });
}

// Must be called from a direct click handler — browsers block popup otherwise
export function signIn() {
  if (!tokenClient) return;
  tokenClient.requestAccessToken({ prompt: 'select_account' });
}

export function signOut() {
  if (currentToken) google.accounts.oauth2.revoke(currentToken, () => { });
  currentToken = null;
  currentUser = null;
  tokenExpiresAt = 0;
}

export function getToken() { return currentToken; }
export function getUser() { return currentUser; }

// Gets a new token for the same account (called automatically by drive.js on 401). Rejects if
// Google refuses, the sign-in window can't open, or nothing comes back in time, so callers never
// wait forever. Browsers only allow the sign-in window during a click or key press, so call
// ensureFreshToken() at the start of a user action rather than relying on this mid-way through.
export function refreshToken() {
  if (_refreshPromise) return _refreshPromise;
  if (!tokenClient) return Promise.reject(new Error('Not signed in'));
  let settle;
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const timer = setTimeout(() => _finishRefresh?.(new Error('Google sign-in did not respond. Try again')), REFRESH_TIMEOUT_MS);
  _refreshPromise = promise;
  _finishRefresh = (err) => {
    clearTimeout(timer);
    _finishRefresh = null;
    _refreshPromise = null;
    if (err) settle.reject(err); else settle.resolve(currentToken);
  };
  // Asked for only once the promise is in place, so an answer that comes back straight away
  // (or a throw) still clears it and the next attempt starts fresh
  try {
    tokenClient.requestAccessToken({ prompt: '' });
  } catch (err) {
    _finishRefresh(err);
  }
  return promise;
}

// True when the token is missing, expired, or about to expire
export function tokenExpiresSoon() {
  return !currentToken || Date.now() > tokenExpiresAt - EXPIRY_MARGIN_MS;
}

// Renews the token first if it's about to expire. Call it straight from a click or key handler,
// before anything is awaited, so the browser lets the sign-in window open.
export function ensureFreshToken() {
  return tokenExpiresSoon() && tokenClient ? refreshToken() : Promise.resolve(currentToken);
}

async function fetchUserInfo(token) {
  try {
    const r = await fetch(`https://www.googleapis.com/oauth2/v1/userinfo?access_token=${token}`);
    if (r.ok) return await r.json();
  } catch { /* fall through */ }
  return { email: 'unknown', name: 'Unknown', picture: '' };
}
