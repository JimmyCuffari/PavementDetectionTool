// Shared state across all Process Data sub-panels.
// Each pd-*.js module imports this and reads/writes it directly.
export const pdState = {
  framesFolderId:  null,  // Drive file ID of the frames/ subfolder (mutually exclusive with framesLocalPath)
  framesLocalPath: null,  // absolute local path on the server machine
  framesFolder:    null,  // folder name for display
  startFrame:      0,
  endFrame:        null,  // null = all frames
  homography:      null,  // parsed JSON object { H, calibration_points }
  resultFolderId:  null,  // optional Drive folder for result upload
  result:          null,  // { pngB64, sections[] } after stitch completes
  serverUrl:       'http://localhost:7860',
};
