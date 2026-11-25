import { describe, expect, it } from "vitest";
import { RACP_MAX_TERMINAL_INPUT_BYTES, type RacpEventEnvelope } from "@pi-harbor/shared";

import { OWNER_TOKEN, VIEWER_TOKEN, flush, harness, summary } from "./test-harness.js";
import type { RacpTerminalAccess, TerminalOpenResult } from "./host-operations.js";

function makeFakeTerminal(): RacpTerminalAccess {
  const sessions = new Map<string, { sessionId: string; size: { cols: number; rows: number }; sink: { output: (data: string) => void; exit: (code: number | null) => void } }>();
  let counter = 0;
  const id = () => {
    counter += 1;
    return `term_${counter}`;
  };
  return {
    async open(sessionId, size, sinkFactory) {
      const terminalId = id();
      const sink = sinkFactory(terminalId);
      sessions.set(terminalId, { sessionId, size, sink });
      return { terminalId, replay: "", cols: size.cols, rows: size.rows };
    },
    async input(terminalId, data) {
      const record = sessions.get(terminalId);
      if (!record) throw new Error("not found");
      record.sink.output(Buffer.from(Buffer.from(data, "base64").toString("utf8"), "utf8").toString("base64"));
    },
    async resize(terminalId, cols, rows) {
      const record = sessions.get(terminalId);
      if (!record) throw new Error("not found");
      record.size = { cols, rows };
    },
    async interrupt(terminalId) {
      const record = sessions.get(terminalId);
      if (!record) throw new Error("not found");
      record.sink.output(Buffer.from("INTERRUPT", "utf8").toString("base64"));
    },
    async close(terminalId) {
      const record = sessions.get(terminalId);
      if (record) {
        sessions.delete(terminalId);
        record.sink.exit(0);
      }
    },
    async attach(terminalId, sink) {
      const record = sessions.get(terminalId);
      if (!record) return null;
      record.sink = sink;
      return { terminalId, replay: "", cols: record.size.cols, rows: record.size.rows };
    },
    detach(terminalId) {
      const record = sessions.get(terminalId);
      if (record) {
        record.sink = { output: () => undefined, exit: () => undefined };
      }
    },
  };
}

function terminalEvents(events: RacpEventEnvelope[]) {
  return events.filter((event) => event.kind === "terminal.output" || event.kind === "terminal.changed");
}

describe("RACP terminal operations", () => {
  it("opens a terminal, emits opened and output events, and rejects viewers", async () => {
    const terminal = makeFakeTerminal();
    const h = await harness({ operations: { terminal } });
    const owner = await h.connect(OWNER_TOKEN);
    const viewer = await h.connect(VIEWER_TOKEN);
    try {
      expect(owner.client.initialized?.capabilities.terminal).toBe(true);
      const opened = await owner.client.request<TerminalOpenResult>("terminal/open", { sessionId: "s1", cols: 100, rows: 30 });
      expect(opened.terminalId).toMatch(/^term_/);
      expect(opened.cols).toBe(100);
      expect(opened.rows).toBe(30);
      await owner.client.request("terminal/input", { sessionId: "s1", terminalId: opened.terminalId, data: Buffer.from("hello", "utf8").toString("base64") });
      await flush();
      const relevant = terminalEvents(owner.events);
      expect(relevant.map((event) => event.kind)).toEqual(["terminal.changed", "terminal.output"]);
      expect((relevant[0]!.payload as { state: string }).state).toBe("opened");
      expect((relevant[1]!.payload as { data: string }).data).toBe(Buffer.from("hello", "utf8").toString("base64"));
      await expect(viewer.client.request("terminal/open", { sessionId: "s1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await owner.client.close();
      await viewer.client.close();
    }
  });

  it("resizes, interrupts, and closes a terminal", async () => {
    const terminal = makeFakeTerminal();
    const h = await harness({ operations: { terminal } });
    const { client, events } = await h.connect(OWNER_TOKEN);
    try {
      const opened = await client.request<TerminalOpenResult>("terminal/open", { sessionId: "s1" });
      await client.request("terminal/resize", { sessionId: "s1", terminalId: opened.terminalId, cols: 120, rows: 40 });
      await client.request("terminal/interrupt", { sessionId: "s1", terminalId: opened.terminalId });
      await client.request("terminal/close", { sessionId: "s1", terminalId: opened.terminalId });
      await flush();
      const exited = terminalEvents(events).find((event) => event.kind === "terminal.changed" && (event.payload as { state?: string }).state === "exited");
      expect(exited).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it("rejects terminal operations when the Host does not advertise the capability", async () => {
    const h = await harness();
    const { client } = await h.connect(OWNER_TOKEN);
    try {
      expect(client.initialized?.capabilities.terminal).toBe(false);
      await expect(client.request("terminal/open", { sessionId: "s1" })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      await expect(client.request("terminal/interrupt", { sessionId: "s1", terminalId: "term_x" })).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    } finally {
      await client.close();
    }
  });

  it("rejects malformed terminal parameters", async () => {
    const terminal = makeFakeTerminal();
    const h = await harness({ operations: { terminal } });
    const { client } = await h.connect(OWNER_TOKEN);
    try {
      await expect(client.request("terminal/open", { sessionId: "" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(client.request("terminal/open", { sessionId: "s1", cols: 0 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(client.request("terminal/resize", { sessionId: "s1", terminalId: "t", cols: 10 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally {
      await client.close();
    }
  });

  it("reattaches after a reconnect and forwards output to the new sink", async () => {
    const terminal = makeFakeTerminal();
    const h = await harness({ operations: { terminal } });
    const { client, events, link } = await h.connect(OWNER_TOKEN, { reconnect: { enabled: true, baseDelayMs: 1 } });
    try {
      const opened = await client.request<TerminalOpenResult>("terminal/open", { sessionId: "s1" });
      await client.request("terminal/input", { sessionId: "s1", terminalId: opened.terminalId, data: Buffer.from("before", "utf8").toString("base64") });
      await flush();
      const before = terminalEvents(events).filter((event) => event.kind === "terminal.output").length;
      link().drop();
      await flush();
      expect(client.state).toBe("connected");
      const attached = await client.request<TerminalOpenResult>("terminal/open", { sessionId: "s1", terminalId: opened.terminalId });
      expect(attached.terminalId).toBe(opened.terminalId);
      await client.request("terminal/input", { sessionId: "s1", terminalId: opened.terminalId, data: Buffer.from("after", "utf8").toString("base64") });
      await flush();
      expect(terminalEvents(events).filter((event) => event.kind === "terminal.output")).toHaveLength(before + 1);
    } finally {
      await client.close();
    }
  });

  it("keeps terminal alive after disconnect and allows only same-session reattach", async () => {
    const terminal = makeFakeTerminal();
    const h = await harness({ operations: { terminal } });
    h.sessions.set("s2", summary("s2"));
    const s1Conn = await h.connect(OWNER_TOKEN);
    const opened = await s1Conn.client.request<TerminalOpenResult>("terminal/open", { sessionId: "s1" });
    try {
      s1Conn.link().drop();
      await flush();
      const s2Conn = await h.connect(OWNER_TOKEN);
      try {
        await expect(s2Conn.client.request("terminal/open", { sessionId: "s2", terminalId: opened.terminalId })).rejects.toMatchObject({ code: "FORBIDDEN" });
        const reattached = await s2Conn.client.request<TerminalOpenResult>("terminal/open", { sessionId: "s1", terminalId: opened.terminalId });
        expect(reattached.terminalId).toBe(opened.terminalId);
        await s2Conn.client.request("terminal/close", { sessionId: "s1", terminalId: opened.terminalId });
        await expect(s2Conn.client.request("terminal/open", { sessionId: "s1", terminalId: opened.terminalId })).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(s2Conn.client.request("terminal/input", { sessionId: "s1", terminalId: opened.terminalId, data: "" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      } finally {
        await s2Conn.client.close();
      }
    } finally {
      await s1Conn.client.close();
    }
  });
  it("rejects terminal input whose decoded bytes exceed the advertised limit", async () => {
    const terminal = makeFakeTerminal();
    const h = await harness({ operations: { terminal } });
    const { client } = await h.connect(OWNER_TOKEN);
    try {
      const opened = await client.request<TerminalOpenResult>("terminal/open", { sessionId: "s1" });
      const atLimit = Buffer.alloc(RACP_MAX_TERMINAL_INPUT_BYTES, "a");
      await expect(
        client.request("terminal/input", { sessionId: "s1", terminalId: opened.terminalId, data: atLimit.toString("base64") }),
      ).resolves.toEqual({ ok: true });
      const overLimit = Buffer.alloc(RACP_MAX_TERMINAL_INPUT_BYTES + 1, "a");
      await expect(
        client.request("terminal/input", { sessionId: "s1", terminalId: opened.terminalId, data: overLimit.toString("base64") }),
      ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    } finally {
      await client.close();
    }
  });
});
