/**
 * Entry point of the process that runs the local cleanup model.
 *
 * node-llama-cpp and transcribe-cpp each ship their own ggml build under the
 * same install name (`@rpath/libggml-base.dylib`). Loading node-llama-cpp in
 * a process where transcribe-cpp is already loaded crashes with SIGSEGV
 * (observed on macOS arm64 with node-llama-cpp 3.22.2 and transcribe-cpp
 * 0.2.2), so the cleanup model never loads in the recognizer's process. A
 * crash here ends only this process; the app keeps the rule-based text.
 *
 * Runs under Electron `utilityProcess` (`process.parentPort`) and under
 * `child_process.fork` (`process.send`).
 */
import { LlamaPolisher } from "./llama-polisher.js";
import {
  isPolisherRequest,
  type PolisherRequest,
  type PolisherResponse,
} from "./polisher-protocol.js";

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;

function send(message: PolisherResponse): void {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
}

function onRequest(listener: (message: unknown) => void): void {
  if (parentPort) {
    parentPort.on("message", (event) => listener(event.data));
    return;
  }
  process.on("message", (message: unknown) => listener(message));
  // A forked worker must not outlive its parent.
  process.on("disconnect", () => process.exit(0));
}

let polisher: LlamaPolisher | null = null;
let polisherPath: string | null = null;
const inFlight = new Map<number, AbortController>();

function polisherFor(modelPath: string): LlamaPolisher {
  if (polisher && polisherPath === modelPath) return polisher;
  const stale = polisher;
  polisher = new LlamaPolisher(modelPath);
  polisherPath = modelPath;
  void stale?.unload().catch(() => undefined);
  return polisher;
}

async function handle(request: Exclude<PolisherRequest, { type: "abort" }>): Promise<void> {
  const controller = new AbortController();
  inFlight.set(request.id, controller);
  try {
    const target = polisherFor(request.modelPath);
    if (request.type === "prepare") {
      await target.prepare();
      send({ type: "result", id: request.id, ok: true });
    } else {
      const text = await target.polish(request.text, controller.signal);
      send({ type: "result", id: request.id, ok: true, text });
    }
  } catch (error) {
    send({
      type: "result",
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      aborted: controller.signal.aborted,
    });
  } finally {
    inFlight.delete(request.id);
  }
}

onRequest((message) => {
  if (!isPolisherRequest(message)) return;
  if (message.type === "abort") {
    inFlight.get(message.id)?.abort();
    return;
  }
  void handle(message);
});
