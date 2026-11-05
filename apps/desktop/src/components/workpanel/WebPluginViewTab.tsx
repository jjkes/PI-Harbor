import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { pluginViewIcon } from "../../lib/plugin-view-icons";
import {
  PLUGIN_VIEW_FRAME_HTML,
  PLUGIN_VIEW_FRAME_SANDBOX,
  PLUGIN_VIEW_HOST_SOURCE,
  blobTypeFor,
  isPluginViewFrameMessage,
  type PluginViewFrameAsset,
} from "../../lib/web-access/plugin-view-frame";
import { IconPlug } from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";

/**
 * A plugin-contributed work panel view in a browser (ADR 0345).
 *
 * The desktop surface is a native `WebContentsView` the main process
 * composites; a browser has nothing to composite, so the same view document is
 * mounted in a sandboxed frame with an opaque origin. The frame's
 * `pluginBridge` is supplied by the frame itself and relayed here: open the
 * instance, fetch the document's assets, forward each plugin call, and close it
 * when the tab goes away. The frame never reaches IPC.
 */
export function WebPluginViewTab({
  pluginId,
  viewId,
  title,
  icon,
  blocked = false,
  sessionId,
  location,
}: {
  pluginId: string;
  viewId: string;
  title: string;
  icon?: string;
  blocked?: boolean;
  sessionId?: string;
  location?: string;
}) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const instanceRef = useRef<string | null>(null);
  const mountRef = useRef<{
    html: string;
    assets: PluginViewFrameAsset[];
    theme: string;
    locale: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const post = useCallback((message: unknown) => {
    frameRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  // Open the instance and hand the frame its document. The frame asks for the
  // bytes, so a document that arrives first is mounted on `ready`.
  useEffect(() => {
    let current = true;
    const assets: PluginViewFrameAsset[] = [];
    setFailed(false);
    setLoading(true);
    instanceRef.current = null;
    mountRef.current = null;

    const open = async () => {
      try {
        const opened = await api.pluginWebViewOpen({
          pluginId,
          viewId,
          ...(sessionId ? { sessionId } : {}),
          ...(location ? { location } : {}),
        });
        if (!current) {
          void api.pluginWebViewClose({ instanceId: opened.instanceId }).catch(() => undefined);
          return;
        }
        instanceRef.current = opened.instanceId;
        const collected: PluginViewFrameAsset[] = [];
        for (const asset of opened.assets) {
          const bytes = await api.pluginWebViewAsset({
            instanceId: opened.instanceId,
            path: asset.path,
          });
          // A fresh `ArrayBuffer`: the frame must mint its own `blob:` URL,
          // because a blob made here belongs to this origin and an opaque one
          // cannot load it.
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          collected.push({
            reference: asset.reference,
            type: blobTypeFor(asset.path),
            bytes: copy.buffer,
          });
        }
        if (!current) return;
        assets.push(...collected);
        mountRef.current = {
          html: opened.html,
          assets,
          theme: opened.theme,
          locale: opened.locale,
        };
        post({ source: PLUGIN_VIEW_HOST_SOURCE, kind: "mount", ...mountRef.current });
      } catch {
        if (current) setFailed(true);
      }
    };
    void open();

    return () => {
      current = false;
      const instanceId = instanceRef.current;
      instanceRef.current = null;
      mountRef.current = null;
      // The frame's own blob URLs die with its document.
      if (instanceId) void api.pluginWebViewClose({ instanceId }).catch(() => undefined);
    };
  }, [pluginId, viewId, sessionId, location, post]);

  // Plugin events the desktop writes into a view's web contents.
  useEffect(
    () =>
      api.onPluginWebViewEvent((event) => {
        if (event.instanceId !== instanceRef.current) return;
        post({ source: PLUGIN_VIEW_HOST_SOURCE, kind: "event", event: event.event, payload: event.payload });
      }),
    [post],
  );

  const handle = useCallback(
    async (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (!isPluginViewFrameMessage(event.data)) return;
      const message = event.data;
      if (message.kind === "ready") {
        if (mountRef.current) post({ source: PLUGIN_VIEW_HOST_SOURCE, kind: "mount", ...mountRef.current });
        return;
      }
      if (message.kind === "mounted") {
        setLoading(false);
        return;
      }
      if (message.kind === "failed") {
        setFailed(true);
        return;
      }
      if (message.kind === "clipboard") {
        // The frame is opaque-origin, so the browser's clipboard belongs here.
        void navigator.clipboard?.writeText(message.text).catch(() => undefined);
        return;
      }
      const instanceId = instanceRef.current;
      if (!instanceId) return;
      try {
        const value = await api.pluginWebViewInvoke({
          instanceId,
          channel: message.channel,
          payload: (message.payload ?? {}) as Record<string, unknown>,
        });
        post({ source: PLUGIN_VIEW_HOST_SOURCE, kind: "result", id: message.id, ok: true, value });
      } catch (error) {
        post({
          source: PLUGIN_VIEW_HOST_SOURCE,
          kind: "result",
          id: message.id,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [post],
  );

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      void handle(event);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [handle]);

  if (failed) {
    return (
      <div className="work-plugin-view">
        <WorkTabEmpty
          icon={pluginViewIcon(icon) ?? IconPlug}
          title={title}
          body={t("panel.pluginView.failed")}
        />
      </div>
    );
  }

  return (
    <div className="work-plugin-view">
      <iframe
        ref={frameRef}
        title={title}
        className="work-plugin-view-surface work-plugin-view-frame"
        sandbox={PLUGIN_VIEW_FRAME_SANDBOX}
        srcDoc={PLUGIN_VIEW_FRAME_HTML}
        style={{ visibility: blocked ? "hidden" : "visible", opacity: loading ? 0 : 1 }}
        allow="clipboard-write"
      />
    </div>
  );
}
