import type {
  ChatHistoryItem,
  Llama,
  LlamaChatSession,
  LlamaContext,
  LlamaModel,
} from "node-llama-cpp";
import { POLISH_EXAMPLES, POLISH_SYSTEM_PROMPT } from "./prompt.js";

/** Rewrites masked dictation text with a local model. */
export interface TranscriptPolisher {
  /** Load the model ahead of use; a failure surfaces again on `polish`. */
  prepare(): Promise<void>;
  polish(text: string, signal: AbortSignal): Promise<string>;
  /** Release the model and its native memory. */
  unload(): Promise<void>;
}

/** Fits the instructions, the examples and a long dictation with its rewrite. */
const CONTEXT_SIZE = 2048;
const MAX_OUTPUT_TOKENS = 512;

interface LoadedPolisher {
  llama: Llama;
  model: LlamaModel;
  context: LlamaContext;
  session: LlamaChatSession;
  history: ChatHistoryItem[];
}

/**
 * Qwen3 cleanup through node-llama-cpp. The native library loads on first
 * use. Calls are serialized because one context sequence serves them; each
 * call starts from the same instructions and examples.
 */
export class LlamaPolisher implements TranscriptPolisher {
  private loading: Promise<LoadedPolisher> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly modelPath: string) {}

  async prepare(): Promise<void> {
    await this.load();
  }

  polish(text: string, signal: AbortSignal): Promise<string> {
    const run = this.queue.then(async () => {
      signal.throwIfAborted();
      const loaded = await this.load();
      signal.throwIfAborted();
      loaded.session.setChatHistory(structuredClone(loaded.history));
      return loaded.session.prompt(text, {
        signal,
        maxTokens: Math.min(MAX_OUTPUT_TOKENS, text.length * 2 + 32),
        temperature: 0,
        budgets: { thoughtTokens: 0 },
      });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async unload(): Promise<void> {
    const loading = this.loading;
    this.loading = null;
    if (!loading) return;
    await this.queue;
    const loaded = await loading.catch(() => null);
    if (!loaded) return;
    await loaded.context.dispose();
    await loaded.model.dispose();
    await loaded.llama.dispose();
  }

  private load(): Promise<LoadedPolisher> {
    if (!this.loading) {
      const loading = loadPolisher(this.modelPath);
      this.loading = loading;
      loading.catch(() => {
        // Let the next call retry instead of caching the failure.
        if (this.loading === loading) this.loading = null;
      });
    }
    return this.loading;
  }
}

async function loadPolisher(modelPath: string): Promise<LoadedPolisher> {
  const { getLlama, LlamaChatSession, QwenChatWrapper } = await import("node-llama-cpp");
  // Prebuilt binaries only: never compile llama.cpp inside the app.
  const llama = await getLlama({ build: "never", gpu: "auto" });
  try {
    const model = await llama.loadModel({ modelPath });
    try {
      const context = await model.createContext({ contextSize: CONTEXT_SIZE });
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        chatWrapper: new QwenChatWrapper({ thoughts: "discourage" }),
      });
      return { llama, model, context, session, history: baseHistory() };
    } catch (error) {
      await model.dispose();
      throw error;
    }
  } catch (error) {
    await llama.dispose();
    throw error;
  }
}

function baseHistory(): ChatHistoryItem[] {
  const history: ChatHistoryItem[] = [{ type: "system", text: POLISH_SYSTEM_PROMPT }];
  for (const example of POLISH_EXAMPLES) {
    history.push({ type: "user", text: example.input });
    history.push({ type: "model", response: [example.output] });
  }
  return history;
}
