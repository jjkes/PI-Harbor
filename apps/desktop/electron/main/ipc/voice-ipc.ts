/**
 * Voice IPC handler registration.
 * Follows the same pattern as speech-ipc.ts and other IPC modules. Renderer
 * input is untrusted: settings patches are normalized and model ids must name
 * a catalog entry before they reach VoiceService.
 */

import { IPC } from "@pi-harbor/shared";
import { findModel, normalizeVoiceSettingsPatch } from "@pi-harbor/voice-runtime";
import type { VoiceService } from "../voice-service";
import type { IpcRegistrar } from "./types";

function catalogModelId(input: unknown): string {
  const modelId =
    typeof input === "object" && input !== null ? (input as { modelId?: unknown }).modelId : undefined;
  if (typeof modelId !== "string" || !findModel(modelId)) {
    throw new Error("Unknown voice model");
  }
  return modelId;
}

export function registerVoiceIpc({
  registrar,
  voiceService,
}: {
  registrar: IpcRegistrar;
  voiceService: VoiceService;
}): void {
  const { handle } = registrar;

  handle(IPC.invoke.voiceStart, (settings: unknown) =>
    voiceService.start(settings === undefined ? undefined : normalizeVoiceSettingsPatch(settings)),
  );

  handle(IPC.invoke.voiceStop, () => voiceService.stop());

  handle(IPC.invoke.voiceCancel, async () => {
    voiceService.cancel();
    return { ok: true };
  });

  handle(IPC.invoke.voiceGetState, async () => voiceService.getState());

  handle(IPC.invoke.voiceGetDevices, async () => voiceService.getDevices());

  handle(IPC.invoke.voiceGetModels, () => voiceService.getModels());

  handle(IPC.invoke.voiceDownloadModel, async (input: unknown) =>
    voiceService.downloadModel(catalogModelId(input)),
  );

  handle(IPC.invoke.voiceDeleteModel, async (input: unknown) =>
    voiceService.deleteModel(catalogModelId(input)),
  );

  handle(IPC.invoke.voiceUpdateSettings, async (input: unknown) =>
    voiceService.updateSettings(normalizeVoiceSettingsPatch(input)),
  );

  handle(IPC.invoke.voiceCheckPermission, () =>
    voiceService.checkPermission(),
  );

  handle(IPC.invoke.voiceRequestPermission, () =>
    voiceService.requestPermission(),
  );
}
