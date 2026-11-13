/**
 * The app-surface switch in the conversation top bar: agent development, or the
 * image workbench.
 *
 * It is a view preference only. Switching never touches the active session, its
 * mode, its model, or its permissions — it changes which surface is on screen,
 * and in image mode it brings the session's Images tab up so the press lands
 * somewhere visible. The local switch happens first and persistence follows: a
 * slow or rejected settings write must never make the control look dead.
 */
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { AppMode } from "@pi-harbor/shared";
import { SegmentedControl } from "../../components/ui";
import { api } from "../../lib/api";
import { appModeOf } from "../../lib/app-mode";
import { imagesWorkPanelTab } from "../../lib/work-panel-tabs";
import { useAppStore } from "../../stores/app-store";

/** Focus the session's Images tab; opening an existing tab id just focuses it. */
function showImageWorkbench() {
  if (!useAppStore.getState().activeSessionId) return;
  useAppStore.getState().openWorkPanelTab(imagesWorkPanelTab());
}

export function AppModeSwitch() {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const mode = appModeOf(settings);

  /*
   * A session that starts while image mode is on gets the workbench too, so the
   * mode keeps its promise without the user pressing anything again.
   */
  useEffect(() => {
    if (mode !== "images" || !activeSessionId) return;
    showImageWorkbench();
  }, [mode, activeSessionId]);

  const change = useCallback(async (next: AppMode) => {
    const current = useAppStore.getState().settings;
    if (!current || next === appModeOf(current)) return;
    const updated = { ...current, appMode: next };
    // The switch and the workbench are local and immediate; the settings write is
    // bookkeeping that must not gate them.
    useAppStore.setState({ settings: updated });
    if (next === "images") showImageWorkbench();
    try {
      await api.setSettings(updated);
    } catch (error) {
      useAppStore.getState().showToast(
        error instanceof Error ? error.message : String(error),
        { variant: "error" },
      );
    }
  }, []);

  return (
    <SegmentedControl
      className="ct-app-mode"
      value={mode}
      label={t("settings.mode")}
      options={[
        { value: "agent", label: t("settings.modeAgent") },
        { value: "images", label: t("panel.tabs.images") },
        { value: "plan", label: t("settings.modePlan") },
      ]}
      onChange={(next) => void change(next)}
    />
  );
}
