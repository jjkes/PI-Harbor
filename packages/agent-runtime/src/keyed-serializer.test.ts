import { describe, expect, it } from "vitest";
import { createKeyedSerializer } from "./keyed-serializer.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createKeyedSerializer", () => {
  it("runs the tasks of one key one at a time, in call order", async () => {
    const serialize = createKeyedSerializer();
    const gate = deferred();
    const log: string[] = [];
    const first = serialize("session-a", async () => {
      log.push("first:start");
      await gate.promise;
      log.push("first:end");
      return 1;
    });
    const second = serialize("session-a", async () => {
      log.push("second:start");
      return 2;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["first:start"]);
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(log).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not hold one key behind another", async () => {
    const serialize = createKeyedSerializer();
    const gate = deferred();
    const blocked = serialize("session-a", async () => {
      await gate.promise;
      return "a";
    });
    await expect(serialize("session-b", async () => "b")).resolves.toBe("b");
    gate.resolve();
    await expect(blocked).resolves.toBe("a");
  });

  it("keeps a failed task from blocking the next one for its key", async () => {
    const serialize = createKeyedSerializer();
    const failed = serialize("session-a", async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    await expect(serialize("session-a", async () => "next")).resolves.toBe("next");
  });
});
