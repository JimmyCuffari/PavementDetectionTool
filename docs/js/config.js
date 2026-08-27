// Emails listed here are the only accounts that can access the Review Annotations tab.
// Add or remove addresses as needed, then commit and push.
export const MASTER_USERS = [
  'jimmycuffari.jr@gmail.com',
  'cuffar29@students.rowan.edu',
  'nortona@rowan.edu',
  'jvrishitha@gmail.com'
];

// The folder ID of the shared PavementDataset folder in the owner's Google Drive.
// All team members upload here instead of their own drives.
//
// Setup:
//   1. Create a folder called PavementDataset in your Google Drive
//   2. Right-click → Share → add each team member's email with Editor access
//      (or set "Anyone with the link" → Editor for open access)
//   3. Open the folder and copy the ID from the URL:
//      https://drive.google.com/drive/folders/THIS_PART_IS_THE_ID
//   4. Paste it below, commit, and push.
export const SHARED_FOLDER_ID = '1AmMfIs2ESaSX7Tbgx0lhhRpdy-z1lXNA';

// The folder ID of the shared Drive folder containing raw collection data (the .db files
// produced during street collection). The Coverage Map's "Choose Drive Folder" picker opens
// here by default instead of at the root of the signed-in user's My Drive.
export const COLLECTION_ROOT_FOLDER_ID = '1vcU3g2Wrc3TccW9IkT6HR0Z1R59uCMZg';
