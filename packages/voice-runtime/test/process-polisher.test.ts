import { describe, expect, it } from "vitest";
import {
  isPolisherRequest,
  type PolisherChannel,
  type PolisherRequest,
} from "../src/cleanup/polisher-protocol.js";
import { ProcessPolisher } from "../src/cleanup/process-polisher.js";

class FakeChannel implements PolisherChannel {
  readonly sent: PolisherRequest[] = [];
  killed = false;
  private messageListener: ((message: unknown) => void) | null = null;
  private exitListener: ((code: number | null) => void) | null = null;

  postMessage(message: PolisherRequest): void {
    if (this.killed) throw new Error("worker gone");
    this.sent.push(message);
  }
  onMessage(listener: (message: unknown) => void): void {
    this.messageListener = listener;
  }
  onExit(listener: (code: number | null) => void): void {
    this.exitListener = listener;
  }
  kill(): void {
    this.killed = true;
  }
  reply(message: unknown): void {
    this.messageListener?.(message);
  }
  exit(code: number | null): void {
    this.exitListener?.(code);
  }
  last(): PolisherRequest {
    const message = this.sent.at(-1);
    if (!message) throw new Error("nothing sent");
    return message;
  }
}

function setup() {
  const channels: FakeChannel[] = [];
  const polisher = new ProcessPolisher(() => {
    const channel = new FakeChannel();
    channels.push(channel);
    return channel;
  }, "/models/qwen.gguf");
  const channel = (index = 0): FakeChannel => {
    const found = channels[index];
    if (!found) throw new Error(`no worker ${index}`);
    return found;
  };
  return { polisher, channels, channel };
}

const live = (): AbortSignal => new AbortController().signal;

describe("ProcessPolisher", () => {
  it("starts the worker on first use and resolves results by id", async () => {
    const { polisher, channels, channel } = setup();
    expect(channels).toHaveLength(0);
    const pending = polisher.polish("嗯整理一下", live());
    const request = channel().last();
    expect(request).toMatchObject({
      type: "polish",
      modelPath: "/models/qwen.gguf",
      text: "嗯整理一下",
    });
    channel().reply({ type: "result", id: request.id, ok: true, text: "整理一下" });
    await expect(pending).resolves.toBe("整理一下");
  });

  it("reuses one worker across calls", async () => {
    const { polisher, channels, channel } = setup();
    const prepared = polisher.prepare();
    channel().reply({ type: "result", id: channel().last().id, ok: true });
    await prepared;
    const polished = polisher.polish("x", live());
    channel().reply({ type: "result", id: channel().last().id, ok: true, text: "y" });
    await expect(polished).resolves.toBe("y");
    expect(channels).toHaveLength(1);
  });

  it("rejects worker errors", async () => {
    const { polisher, channel } = setup();
    const pending = polisher.polish("x", live());
    channel().reply({ type: "result", id: channel().last().id, ok: false, error: "boom" });
    await expect(pending).rejects.toThrow("boom");
  });

  it("forwards an abort, rejects with its reason, and ignores the late result", async () => {
    const { polisher, channel } = setup();
    const controller = new AbortController();
    const pending = polisher.polish("x", controller.signal);
    const { id } = channel().last();
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(channel().last()).toEqual({ type: "abort", id });
    expect(() => channel().reply({ type: "result", id, ok: true, text: "late" })).not.toThrow();
  });

  it("rejects an already-aborted signal without starting a worker", async () => {
    const { polisher, channels } = setup();
    const controller = new AbortController();
    controller.abort(new Error("early"));
    await expect(polisher.polish("x", controller.signal)).rejects.toThrow("early");
    expect(channels).toHaveLength(0);
  });

  it("fails in-flight calls when the worker crashes and restarts on the next call", async () => {
    const { polisher, channels, channel } = setup();
    const pending = polisher.polish("x", live());
    channel().exit(null);
    await expect(pending).rejects.toThrow(/exited/);
    const next = polisher.polish("y", live());
    expect(channels).toHaveLength(2);
    channel(1).reply({ type: "result", id: channel(1).last().id, ok: true, text: "z" });
    await expect(next).resolves.toBe("z");
  });

  it("unload ends the worker and fails in-flight calls", async () => {
    const { polisher, channel } = setup();
    const pending = polisher.polish("x", live());
    await polisher.unload();
    await expect(pending).rejects.toThrow(/unloaded/);
    expect(channel().killed).toBe(true);
    expect(() => channel().exit(0)).not.toThrow();
  });

  it("ignores malformed worker messages", async () => {
    const { polisher, channel } = setup();
    const pending = polisher.polish("x", live());
    const { id } = channel().last();
    channel().reply("garbage");
    channel().reply({ type: "result", id: String(id), ok: true, text: "no" });
    channel().reply({ type: "result", id, ok: false });
    channel().reply({ type: "result", id, ok: true, text: "yes" });
    await expect(pending).resolves.toBe("yes");
  });
});

describe("isPolisherRequest", () => {
  it("accepts well-formed requests only", () => {
    expect(isPolisherRequest({ type: "polish", id: 1, modelPath: "/m", text: "t" })).toBe(true);
    expect(isPolisherRequest({ type: "prepare", id: 1, modelPath: "/m" })).toBe(true);
    expect(isPolisherRequest({ type: "abort", id: 2 })).toBe(true);
    expect(isPolisherRequest({ type: "polish", id: 1, modelPath: "", text: "t" })).toBe(false);
    expect(isPolisherRequest({ type: "polish", id: 1.5, modelPath: "/m", text: "t" })).toBe(false);
    expect(isPolisherRequest({ type: "eval", id: 1 })).toBe(false);
    expect(isPolisherRequest(null)).toBe(false);
  });
});
