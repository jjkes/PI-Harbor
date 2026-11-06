import i18n from "i18next";
import { api } from "../../lib/api";
import { playNotificationChime } from "../../lib/notification-sound";
import {
  type InputRequestKind,
  viewedSessionId,
} from "../../lib/session-input-requests";
import type { StoreGet } from "../slices/types";

export type InteractivePromptNotifier = (
  sessionId: string,
  kind: InputRequestKind,
  payload?: { question?: string; toolName?: string },
) => void;

export function createInteractivePromptNotifier(
  get: StoreGet,
): InteractivePromptNotifier {
  return (sessionId, kind, payload) => {
    const session = get().sessions.find((item) => item.id === sessionId);
    const sessionTitle = session?.title || i18n.t("chat.untitledTask");
    let title = "";
    let body = "";
    if (kind === "ask") {
      // Session titles can contain generated/tool-call text; keep the native
      // banner title stable and let its body carry the actual question.
      title = i18n.t("notifications.askTitle");
      body = payload?.question?.trim() || i18n.t("notifications.askBodyFallback");
    } else if (kind === "permission") {
      title = i18n.t("notifications.permissionTitle", { sessionTitle });
      body = i18n.t("notifications.permissionBody", {
        toolName: payload?.toolName || "tool",
      });
    } else {
      title = i18n.t("notifications.planApprovalTitle", { sessionTitle });
      body = i18n.t("notifications.planApprovalBody");
    }
    playNotificationChime();
    // The conversation on screen already shows its own request card. Any other
    // conversation gets a reminder that stays until the request settles, the
    // user opens it from the reminder, or dismisses it.
    if (viewedSessionId(get()) !== sessionId) {
      get().showToast(`${title}: ${body}`, {
        variant: "info",
        duration: 0,
        sound: false,
        sessionId,
        inputRequest: kind,
      });
    }
    void api
      .showNativeNotification({
        id: crypto.randomUUID(),
        sessionId,
        kind: "interactive",
        title,
        body,
      })
      .catch(() => undefined);
  };
}
