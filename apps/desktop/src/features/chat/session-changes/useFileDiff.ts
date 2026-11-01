import { useEffect, useState } from "react";
import type { ReviewFileDiff } from "@pi-harbor/shared";
import { api } from "../../../lib/api";

export type FileDiffLoad =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; diff: ReviewFileDiff };

/**
 * Load one file's net diff from the host (`review.fileDiff`).
 *
 * The request is keyed by the session and its snapshot chain, so a later
 * recorded change to the file loads a fresh diff, while a response for a
 * superseded chain or an unmounted tab is dropped. Remounting the tab reloads
 * it, which also picks up edits made on disk since.
 */
export function useFileDiff(
  sessionId: string | undefined,
  snapshotIds: readonly string[],
): FileDiffLoad {
  // Snapshot ids are UUIDs, so a newline join is an unambiguous key that
  // changes only when the chain does.
  const chain = snapshotIds.join("\n");
  const key = sessionId && chain ? `${sessionId}\n${chain}` : null;
  const [result, setResult] = useState<{
    key: string;
    load: FileDiffLoad;
  } | null>(null);

  useEffect(() => {
    if (!sessionId || !chain) return;
    const requestKey = `${sessionId}\n${chain}`;
    let active = true;
    void (async () => {
      try {
        const diff = await api.workspaceReviewFileDiff({
          sessionId,
          snapshotIds: chain.split("\n"),
        });
        if (active) setResult({ key: requestKey, load: { status: "ready", diff } });
      } catch (error) {
        console.warn("[review] file diff failed", error);
        if (active) setResult({ key: requestKey, load: { status: "error" } });
      }
    })();
    return () => {
      active = false;
    };
  }, [sessionId, chain]);

  return result?.key === key ? result.load : { status: "loading" };
}
