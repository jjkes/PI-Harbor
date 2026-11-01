import type { CleanupMode } from "../types.js";
import type { TranscriptPolisher } from "./llama-polisher.js";
import { cleanTranscript, type CleanedTranscript } from "./pipeline.js";

export interface TranscriptCleanerOptions {
  /** Local path of the downloaded cleanup model, or null when it is missing. */
  resolveModelPath: () => string | null;
  /**
   * Builds the polisher for a model path. Production passes a
   * `ProcessPolisher`: the cleanup model must not load in the recognizer's
   * process (see polisher-worker.ts).
   */
  createPolisher: (modelPath: string) => TranscriptPolisher;
  timeoutMs?: number;
}

export interface CleanRequest {
  mode: CleanupMode;
  languages: readonly string[];
  detectedLanguage?: string;
  signal?: AbortSignal;
}

/**
 * Owns the cleanup polisher's lifecycle: created on first `llm` use, reused
 * while the model path is unchanged, released by `unload()`.
 */
export class TranscriptCleaner {
  private polisher: TranscriptPolisher | null = null;
  private polisherPath: string | null = null;

  constructor(private readonly options: TranscriptCleanerOptions) {}

  clean(raw: string, request: CleanRequest): Promise<CleanedTranscript> {
    const polisher = request.mode === "llm" ? this.currentPolisher() : null;
    return cleanTranscript(raw, { ...request, polisher, timeoutMs: this.options.timeoutMs });
  }

  /** Start loading the local model while the user is still speaking. */
  prewarm(mode: CleanupMode): void {
    if (mode !== "llm") return;
    void this.currentPolisher()
      ?.prepare()
      .catch(() => undefined);
  }

  async unload(): Promise<void> {
    const polisher = this.polisher;
    this.polisher = null;
    this.polisherPath = null;
    await polisher?.unload();
  }

  private currentPolisher(): TranscriptPolisher | null {
    const modelPath = this.options.resolveModelPath();
    if (this.polisher && this.polisherPath === modelPath) return this.polisher;
    this.release();
    if (!modelPath) return null;
    this.polisher = this.options.createPolisher(modelPath);
    this.polisherPath = modelPath;
    return this.polisher;
  }

  private release(): void {
    const stale = this.polisher;
    this.polisher = null;
    this.polisherPath = null;
    if (stale) void stale.unload().catch(() => undefined);
  }
}
