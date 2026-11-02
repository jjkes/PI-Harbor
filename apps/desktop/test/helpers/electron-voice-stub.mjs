/**
 * Minimal `electron` module stub for importing voice-service.ts under
 * `node --test`: the service touches `app` (the createVoiceService wrapper
 * and the packaged-build check), `net` and `utilityProcess` (model downloads
 * and the cleanup-model worker, which these tests never reach), and
 * `BrowserWindow` as a type, while audio-backend.ts reads
 * `systemPreferences` for the macOS microphone permission path.
 */
export const app = {
  isPackaged: false,
  once: () => undefined,
};

export const BrowserWindow = class BrowserWindow {};

export const net = {
  fetch: () => Promise.reject(new Error("net.fetch is not available in voice tests")),
};

export const utilityProcess = {
  fork: () => {
    throw new Error("utilityProcess is not available in voice tests");
  },
};

/** File picker used by model import; tests never open it. */
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
};
export const systemPreferences = {
  getMediaAccessStatus: () => "granted",
  askForMediaAccess: async () => true,
};
