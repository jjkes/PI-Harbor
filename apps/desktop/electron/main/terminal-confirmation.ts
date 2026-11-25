/**
 * Shared Main-process confirmation for opening an interactive terminal.
 *
 * Both local and remote terminal opens require the same native user confirmation
 * before the request reaches host-core / RACP. The renderer's boolean is never
 * treated as authorization.
 *
 * Two properties matter here:
 *
 * - The wording comes from the active locale. Main resolves the labels and
 *   hands them in, so a Chinese UI shows a Chinese dialog; this module never
 *   owns English copy.
 * - Cancel owns the default button and Escape. Opening a shell is a privileged
 *   action, so it must cost an explicit click on the confirming button rather
 *   than a stray Enter on a dialog the user did not read.
 *
 * `electron` is imported lazily so the dialog-shape rule below stays a pure
 * function the test runner can import without a browser process.
 */
import { catalogs, resolveLocale } from "@pi-harbor/i18n";
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron";

export type TerminalOpenConfirmationLabels = {
  title: string;
  message: string;
  cancel: string;
  confirm: string;
};

/**
 * Resolve the dialog copy from the active locale.
 *
 * Main has no renderer i18n instance, so it reads the same catalogs the shell
 * renders with. `getLocale` is called per dialog, which keeps a language change
 * effective for the next confirmation.
 */
export function terminalDialogLabels(
  getLocale: () => string,
): TerminalOpenConfirmationLabels {
  const catalog = catalogs[resolveLocale(getLocale())];
  return {
    title: catalog.panel.terminal.openConfirmTitle,
    message: catalog.panel.terminal.openConfirm,
    cancel: catalog.common.cancel,
    confirm: catalog.panel.terminal.open,
  };
}

/** Cancel is index 0 in the button array and owns `defaultId` / `cancelId`. */
export const CANCEL_BUTTON_INDEX = 0;
export const CONFIRM_BUTTON_INDEX = 1;

/**
 * The exact dialog Electron shows. Pure so the "Cancel is the default" rule is
 * testable without mocking the dialog.
 */
export function terminalOpenDialogOptions(
  labels: TerminalOpenConfirmationLabels,
): MessageBoxOptions {
  return {
    type: "question",
    title: labels.title,
    message: labels.message,
    buttons: [labels.cancel, labels.confirm],
    defaultId: CANCEL_BUTTON_INDEX,
    cancelId: CANCEL_BUTTON_INDEX,
    noLink: true,
  };
}

async function showMessageBox(
  parent: BrowserWindow | null,
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  const { dialog } = await import("electron");
  return parent && !parent.isDestroyed()
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options);
}

export type TerminalOpenConfirmationDependencies = {
  /** The parent window for the confirmation dialog, or null if none. */
  getMainWindow: () => BrowserWindow | null;
  /**
   * Resolve the labels when the dialog opens, not when it is registered: a
   * language change must reach the next dialog without a restart.
   */
  labels: () => TerminalOpenConfirmationLabels;
};

/**
 * Returns a function that shows a native confirmation dialog for opening a
 * terminal. The returned function is mockable and can be injected into both
 * local and remote terminal backends.
 */
export function createTerminalOpenConfirmation(
  options: TerminalOpenConfirmationDependencies,
): () => Promise<boolean> {
  const { getMainWindow, labels } = options;
  return async () => {
    const { response } = await showMessageBox(
      getMainWindow(),
      terminalOpenDialogOptions(labels()),
    );
    return response === CONFIRM_BUTTON_INDEX;
  };
}
