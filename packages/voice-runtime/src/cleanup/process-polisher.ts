import type { TranscriptPolisher } from "./llama-polisher.js";
import {
  isPolisherResponse,
  type PolisherChannel,
  type PolisherRequest,
} from "./polisher-protocol.js";

interface Pending {
  resolve: (text: string) => void;
  reject: (error: unknown) => void;
}

/**
 * `TranscriptPolisher` backed by the isolated worker in polisher-worker.ts.
 * The worker starts on first use, and `unload()` ends it, which returns all of
 * the model's memory. A worker crash rejects the in-flight calls (the pipeline
 * then keeps the rule-based text) and the next call starts a fresh worker.
 */
export class ProcessPolisher implements TranscriptPolisher {
  private channel: PolisherChannel | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly spawn: () => PolisherChannel,
    private readonly modelPath: string,
  ) {}

  async prepare(): Promise<void> {
    await this.request({ type: "prepare", id: this.nextId++, modelPath: this.modelPath });
  }

  polish(text: string, signal: AbortSignal): Promise<string> {
    return this.request(
      { type: "polish", id: this.nextId++, modelPath: this.modelPath, text },
      signal,
    );
  }

  async unload(): Promise<void> {
    const channel = this.channel;
    this.channel = null;
    this.rejectAll(new Error("Cleanup model unloaded"));
    channel?.kill();
  }

  private request(
    message: Exclude<PolisherRequest, { type: "abort" }>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const channel = this.ensureChannel();
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.pending.delete(message.id)) return;
        try {
          channel.postMessage({ type: "abort", id: message.id });
        } catch {
          // The worker already exited; nothing left to stop.
        }
        reject(signal?.reason);
      };
      this.pending.set(message.id, {
        resolve: (text) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(text);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        channel.postMessage(message);
      } catch (error) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        entry?.reject(error);
      }
    });
  }

  private ensureChannel(): PolisherChannel {
    if (this.channel) return this.channel;
    const channel = this.spawn();
    this.channel = channel;
    channel.onMessage((message) => {
      if (!isPolisherResponse(message)) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.ok) entry.resolve(message.text ?? "");
      else entry.reject(new Error(message.error));
    });
    channel.onExit((code) => {
      if (this.channel !== channel) return;
      this.channel = null;
      this.rejectAll(new Error(`Cleanup worker exited (${code ?? "signal"})`));
    });
    return channel;
  }

  private rejectAll(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(error);
  }
}
