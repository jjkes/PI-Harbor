/**
 * The session's generated images in one place, as a work-panel gallery.
 *
 * Images are produced by the agent's `GenerateImages` tool, so this tab owns no
 * image pipeline of its own: it reads the tool rows the session already holds
 * and shows their succeeded outputs with the prompt that produced them. The
 * form above the grid runs the same tool through main with no model turn in
 * between, so a user can ask for an image directly. The reader and full-screen
 * viewer are the transcript's own components, so a thumbnail behaves the same
 * in the panel as it does in the turn — one image pipeline, not a second one
 * that can drift.
 */
import { MAX_GENERATED_IMAGES } from "@pi-harbor/shared";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Select, Textarea } from "../ui";
import { GeneratedImageThumbnail } from "../../features/chat/transcript/GeneratedImageThumbnail";
import { GeneratedImageViewer } from "../../features/chat/transcript/GeneratedImageViewer";
import { api } from "../../lib/api";
import {
  generatedImagesFromResult,
  generatedSessionImages,
  mergeGeneratedImages,
  type GeneratedSessionImage,
} from "../../lib/generated-session-images";
import { useAppStore } from "../../stores/app-store";
import "../../styles/generated-images.css";

/** The code to report for a rejected run; a thrown error carries one too. */
function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object" && "errorCode" in error) {
    const code = (error as { errorCode?: unknown }).errorCode;
    if (typeof code === "string" && code) return code;
  }
  return error instanceof Error ? error.message : "";
}

export function ImagesTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  // The panel shows the active session, and `sessionId` only keys the remount,
  // so the store's live transcript is the same one the chat pane paints.
  const messages = useAppStore((state) => state.messages);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(1);
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // What this tab asked for, in the order the batches returned. The transcript
  // stays the record of what the agent produced, so the two lists are merged
  // for display rather than one overwriting the other.
  const [generatedImages, setGeneratedImages] = useState<GeneratedSessionImage[]>([]);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const transcriptImages = useMemo(() => generatedSessionImages(messages), [messages]);
  const images = useMemo(
    () => mergeGeneratedImages(transcriptImages, generatedImages),
    [transcriptImages, generatedImages],
  );
  const viewerImage = viewerIndex === null ? undefined : images[viewerIndex];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || pending || !sessionId) return;
    setPending(true);
    setErrorCode(null);
    try {
      const result = await api.imagesGenerate({ sessionId, items: [{ prompt: text, count }] });
      if (!result.ok) {
        setErrorCode(result.errorCode ?? "");
        return;
      }
      // The prompt stays as typed: a variation of the same request is the
      // common next step, and clearing it would make the user retype it.
      const added = generatedImagesFromResult(result.content, text);
      if (added.length) setGeneratedImages((current) => mergeGeneratedImages(current, added));
    } catch (error) {
      setErrorCode(errorCodeOf(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="work-panel-images" data-session-id={sessionId}>
      <form className="work-panel-images-form" onSubmit={submit}>
        <Textarea
          className="work-panel-images-prompt"
          aria-label={t("panel.images.prompt")}
          placeholder={t("panel.images.prompt")}
          rows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="work-panel-images-form-actions">
          <Select
            className="work-panel-images-count"
            aria-label={t("panel.images.count")}
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
          >
            {Array.from({ length: MAX_GENERATED_IMAGES }, (_, offset) => offset + 1).map(
              (option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ),
            )}
          </Select>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            aria-busy={pending || undefined}
            disabled={!sessionId || pending || !prompt.trim()}
          >
            {t("panel.images.generate")}
          </Button>
        </div>
        {errorCode !== null ? (
          <p className="work-panel-images-error" role="status">
            {t("settings.imageGenerationFailed", { index: 1 })}
            {errorCode ? ` ${errorCode}` : ""}
          </p>
        ) : null}
      </form>
      {images.length === 0 ? (
        <p className="work-panel-images-empty">{t("panel.images.empty")}</p>
      ) : (
        <ul className="work-panel-images-grid" aria-label={t("panel.tabs.images")}>
          {images.map((image, position) => (
            <li key={image.key}>
              <GeneratedImageThumbnail
                image={image}
                selected={viewerIndex === position}
                className="work-panel-image-thumb"
                onSelect={() => {
                  focusReturnRef.current =
                    document.activeElement instanceof HTMLElement
                      ? document.activeElement
                      : null;
                  setViewerIndex(position);
                }}
              />
              {image.prompt ? (
                <p className="work-panel-image-prompt" title={image.prompt}>
                  {image.prompt}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {viewerImage && viewerIndex !== null ? (
        <GeneratedImageViewer
          images={images}
          selectedIndex={viewerIndex}
          onSelect={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          focusReturnRef={focusReturnRef}
        />
      ) : null}
    </div>
  );
}
