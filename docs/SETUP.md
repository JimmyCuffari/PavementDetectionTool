# Setup Guide — Pavement Dataset Tool

This guide walks through the one-time Google Cloud setup required before the web app can be used.

---

## 1. Create a Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click the project dropdown (top left) → **New Project**
3. Name it `PavementDatasetTool` → **Create**

---

## 2. Enable Required APIs

In the new project, go to **APIs & Services → Library** and enable:

- **Google Drive API**

---

## 3. Configure the OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. User type: **External** → **Create**
3. Fill in:
   - App name: `Pavement Dataset Tool`
   - User support email: your email
   - Developer contact email: your email
4. Click **Save and Continue**
5. On **Scopes**, click **Add or Remove Scopes** and add:
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
6. Click **Save and Continue**
7. On **Test users**, add every team member's Gmail address
   (While the app is in "Testing" mode, only listed users can sign in)
8. Click **Save and Continue** → **Back to Dashboard**

> **Note on the `drive` scope:** The app uses full Drive access (not the narrower `drive.file`)
> so all team members share a single `/PavementDataset/` folder and `tracking.json` log.
> This is appropriate for a team-internal tool. The consent screen will show a warning —
> this is normal for internal tools and can be dismissed by team members.

---

## 4. Create OAuth 2.0 Credentials

1. Go to **APIs & Services → Credentials**
2. Click **+ Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Name: `Pavement Dataset Tool Web`
5. Under **Authorized JavaScript origins**, add:
   - `https://jimmycuffari.github.io` (for production)
   - `http://localhost:5500` (for VS Code Live Server local dev)
   - `http://localhost:3000` (optional, if using a local dev server)
6. Leave **Authorized redirect URIs** empty (token flow does not redirect)
7. Click **Create**
8. Copy the **Client ID** (looks like `1234567890-abc...apps.googleusercontent.com`)

---

## 5. Add Your Client ID to the App

Open [docs/js/auth.js](js/auth.js) and replace the placeholder on line 2:

```js
export const CLIENT_ID = 'YOUR_CLIENT_ID.apps.googleusercontent.com';
```

with your actual Client ID:

```js
export const CLIENT_ID = '1234567890-abcdefg.apps.googleusercontent.com';
```

Commit and push. This is **not a secret** — OAuth Client IDs for web apps are always public.

---

## 6. Enable GitHub Pages

1. In the GitHub repo, go to **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `main`, Folder: `/docs`
4. Click **Save**
5. After a minute, the app will be live at:
   `https://jimmycuffari.github.io/PavementDetectionTool/`

---

## 7. Final Check

- Open the GitHub Pages URL
- Click **Sign in with Google**
- A Google popup will appear — sign in with a test user account
- The two tabs (Extract Frames, Upload Labels) should appear

If the popup is blocked, check that the GitHub Pages origin is in the **Authorized JavaScript origins** list in GCP.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Error 400: redirect_uri_mismatch" | The page origin is not in Authorized JavaScript origins |
| "This app isn't verified" warning | Expected — click "Advanced → Go to Pavement Dataset Tool (unsafe)" or add user to test users list |
| Popup immediately closes | `signIn()` must be triggered by a user click, not programmatically |
| Files not visible to other users | Expected if using `drive.file` scope; this setup uses full `drive` scope to avoid this |
| Upload fails with 403 | Token may have expired; the app will auto-refresh, but if it persists, sign out and back in |
