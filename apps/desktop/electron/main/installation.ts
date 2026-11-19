import { app } from "electron";
import { homedir } from "node:os";
import { APP_ID, APP_NAME } from "@pi-harbor/shared";
import {
  applyDevelopmentUserData,
  desktopDataDir,
  honoredDataDirOverride,
} from "./data-paths";
import { ignoreBrokenStdio } from "./logger";
import { installMainProcessErrorHandlers } from "./main-process-errors";

// Complete identity and locking synchronously, before the ready promise or any writer.
ignoreBrokenStdio();
installMainProcessErrorHandlers();
export const isDevelopmentBuild = process.env.PI_HARBOR_DEV === "1" || !app.isPackaged;
app.setName(APP_NAME);
applyDevelopmentUserData(app, isDevelopmentBuild);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

// A managed restart inherits the root published for children, not an explicit profile override.
if (process.argv.includes("--pi-managed-storage")) delete process.env.PI_HARBOR_DATA_DIR;
// A development build never opens the shipped profile, even when the shell that
// started it exported that root. Dropping the value here keeps the lock verdict,
// host-core, and the plugin runtime on the one directory the profile resolves;
// every other explicit root still wins, which is how E2E profiles work.
if (
  !honoredDataDirOverride({
    override: process.env.PI_HARBOR_DATA_DIR,
    development: isDevelopmentBuild,
    home: homedir(),
  })
) {
  delete process.env.PI_HARBOR_DATA_DIR;
}
export const singleInstanceRequired = !process.env.PI_HARBOR_DATA_DIR;
export const hasSingleInstanceLock = singleInstanceRequired ? app.requestSingleInstanceLock() : true;
export const defaultDataDir = desktopDataDir(isDevelopmentBuild);
if (!hasSingleInstanceLock) app.quit();

// Preserve the existing Chromium accessibility crash workaround before ready.
app.commandLine.appendSwitch("disable-renderer-accessibility");
