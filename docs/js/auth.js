// Replace with your OAuth 2.0 Client ID from Google Cloud Console
export const CLIENT_ID = '799785166783-rgpmjt05nko3io6nkh5u95n0khrnc4f6.apps.googleusercontent.com.apps.googleusercontent.com';

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

let tokenClient = null;
let currentToken = null;
let currentUser = null;
let _onSignedIn = null;

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
          return;
        }
        currentToken = resp.access_token;
        currentUser = await fetchUserInfo(currentToken);
        _onSignedIn(currentUser);
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
}

export function getToken() { return currentToken; }
export function getUser() { return currentUser; }

// Silently refresh token if it has expired (called automatically by drive.js on 401)
export async function refreshToken() {
  return new Promise((resolve) => {
    const prev = _onSignedIn;
    _onSignedIn = (user) => {
      _onSignedIn = prev;
      resolve(currentToken);
      prev(user);
    };
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

async function fetchUserInfo(token) {
  const r = await fetch(`https://www.googleapis.com/oauth2/v1/userinfo?access_token=${token}`);
  if (!r.ok) return { email: 'unknown', name: 'Unknown', picture: '' };
  return r.json();
}
