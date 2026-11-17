/**
 * Live previews of tool-call arguments while the model streams them.
 *
 * The runtime turns successive partial argument snapshots into small
 * `ToolDraftChange`s, so a wire frame carries only the newly streamed text and
 * never re-sends the whole value. Consumers rebuild a display-only copy with
 * `applyToolDraftChanges`. Nothing here is ever executed: the arguments a tool
 * runs with always come from `tool_start`.
 */

import type {
  AgentEvent,
  ToolDraftChange,
  ToolDraftPathSegment,
} from "./types.js";

export type ToolDraftAgentEvent = Extract<AgentEvent, { type: "tool_draft" }>;

/**
 * Returned when a change does not fit the local copy (for example a missed
 * frame). The consumer should stop patching and wait for `tool_start`.
 */
export const TOOL_DRAFT_GAP: unique symbol = Symbol("tool-draft-gap");
export type ToolDraftGap = typeof TOOL_DRAFT_GAP;

/** Untrusted indices beyond this cannot allocate a huge sparse array. */
const MAX_DRAFT_ARRAY_INDEX = 10_000;

/** How far back a merge looks for a change to fold into; keeps merges O(1). */
const MERGE_LOOKBACK = 4;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own data property, so keys such as `__proto__` never reach the prototype. */
function defineDataProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function getAt(value: unknown, path: readonly ToolDraftPathSegment[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!isPlainRecord(current) || !Object.hasOwn(current, segment)) {
        return undefined;
      }
      current = current[segment];
    }
  }
  return current;
}

/** Copy-on-write assignment that creates missing parents along `path`. */
function setAt(
  root: unknown,
  path: readonly ToolDraftPathSegment[],
  value: unknown,
  depth = 0,
): unknown {
  if (depth === path.length) return value;
  const segment = path[depth]!;
  if (typeof segment === "number") {
    if (!Number.isInteger(segment) || segment < 0 || segment > MAX_DRAFT_ARRAY_INDEX) {
      return TOOL_DRAFT_GAP;
    }
    const array = Array.isArray(root) ? root.slice() : [];
    const child = setAt(array[segment], path, value, depth + 1);
    if (child === TOOL_DRAFT_GAP) return TOOL_DRAFT_GAP;
    array[segment] = child;
    return array;
  }
  const record: Record<string, unknown> = isPlainRecord(root) ? { ...root } : {};
  const child = setAt(
    Object.hasOwn(record, segment) ? record[segment] : undefined,
    path,
    value,
    depth + 1,
  );
  if (child === TOOL_DRAFT_GAP) return TOOL_DRAFT_GAP;
  defineDataProperty(record, segment, child);
  return record;
}

/**
 * Apply ordered changes to a draft's arguments. Returns a new value (the input
 * is never mutated), or `TOOL_DRAFT_GAP` when an append does not line up with
 * its target string.
 */
export function applyToolDraftChanges(
  args: unknown,
  changes: readonly ToolDraftChange[],
): unknown | ToolDraftGap {
  let current = args;
  for (const change of changes) {
    if (change.op === "set") {
      current = setAt(current, change.path, change.value);
    } else {
      const target = getAt(current, change.path);
      if (typeof target !== "string" || target.length !== change.offset) {
        return TOOL_DRAFT_GAP;
      }
      current = setAt(current, change.path, target + change.text);
    }
    if (current === TOOL_DRAFT_GAP) return TOOL_DRAFT_GAP;
  }
  return current;
}

/**
 * Changes that turn `previous` into `next`. A string that only grew becomes an
 * `append` of its new suffix; containers that only grew are walked; anything
 * else (a shrunk or rewritten string, a removed key, a changed scalar) is one
 * `set`. Both values must be snapshots (`snapshotToolDraftArgs`): the result
 * may share their leaves.
 */
export function diffToolDraftArgs(previous: unknown, next: unknown): ToolDraftChange[] {
  const changes: ToolDraftChange[] = [];
  diffInto(previous, next, [], changes);
  return changes;
}

function diffInto(
  previous: unknown,
  next: unknown,
  path: ToolDraftPathSegment[],
  changes: ToolDraftChange[],
): void {
  if (previous === next) return;
  if (typeof previous === "string" && typeof next === "string") {
    if (next.startsWith(previous)) {
      changes.push({ op: "append", path, text: next.slice(previous.length), offset: previous.length });
    } else {
      changes.push({ op: "set", path, value: next });
    }
    return;
  }
  if (Array.isArray(previous) && Array.isArray(next) && next.length >= previous.length) {
    for (let index = 0; index < previous.length; index += 1) {
      diffInto(previous[index], next[index], [...path, index], changes);
    }
    for (let index = previous.length; index < next.length; index += 1) {
      changes.push({ op: "set", path: [...path, index], value: next[index] });
    }
    return;
  }
  if (isPlainRecord(previous) && isPlainRecord(next)) {
    const previousKeys = Object.keys(previous);
    if (previousKeys.every((key) => Object.hasOwn(next, key))) {
      for (const key of previousKeys) {
        diffInto(previous[key], next[key], [...path, key], changes);
      }
      for (const key of Object.keys(next)) {
        if (!Object.hasOwn(previous, key)) {
          changes.push({ op: "set", path: [...path, key], value: next[key] });
        }
      }
      return;
    }
  }
  changes.push({ op: "set", path, value: next });
}

/**
 * Copy the containers of `value` and share its immutable leaves, so a provider
 * that keeps mutating its own argument object cannot change a snapshot (or a
 * `set` value taken from one) after it was diffed. Returns `undefined` when
 * `value` holds more than `maxNodes` containers and leaves; a caller should
 * then stop previewing that call.
 */
export function snapshotToolDraftArgs(value: unknown, maxNodes = 20_000): unknown {
  const budget = { remaining: maxNodes };
  const copy = snapshotInto(value, budget);
  return copy === TOOL_DRAFT_GAP ? undefined : copy;
}

function snapshotInto(value: unknown, budget: { remaining: number }): unknown {
  budget.remaining -= 1;
  if (budget.remaining < 0) return TOOL_DRAFT_GAP;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    for (const item of value) {
      const child = snapshotInto(item, budget);
      if (child === TOOL_DRAFT_GAP) return TOOL_DRAFT_GAP;
      copy.push(child);
    }
    return copy;
  }
  if (isPlainRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const child = snapshotInto(value[key], budget);
      if (child === TOOL_DRAFT_GAP) return TOOL_DRAFT_GAP;
      defineDataProperty(copy, key, child);
    }
    return copy;
  }
  return value;
}

function pathsEqual(
  left: readonly ToolDraftPathSegment[],
  right: readonly ToolDraftPathSegment[],
): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/** True when one path is a prefix of the other, so their order matters. */
function pathsOverlap(
  left: readonly ToolDraftPathSegment[],
  right: readonly ToolDraftPathSegment[],
): boolean {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** `earlier` followed by `later` as one change, when that is exact. */
function foldChange(earlier: ToolDraftChange, later: ToolDraftChange): ToolDraftChange | undefined {
  if (!pathsEqual(earlier.path, later.path)) return undefined;
  if (later.op === "set") return later;
  if (earlier.op === "append" && earlier.offset + earlier.text.length === later.offset) {
    return { ...earlier, text: earlier.text + later.text };
  }
  if (earlier.op === "set" && typeof earlier.value === "string" && earlier.value.length === later.offset) {
    return { ...earlier, value: earlier.value + later.text };
  }
  return undefined;
}

function appendChange(changes: ToolDraftChange[], change: ToolDraftChange): void {
  const stop = Math.max(0, changes.length - MERGE_LOOKBACK);
  for (let index = changes.length - 1; index >= stop; index -= 1) {
    const existing = changes[index]!;
    if (!pathsOverlap(existing.path, change.path)) continue;
    // The nearest overlapping change is the only one it may fold into: moving
    // past it would reorder two writes to the same location.
    const folded = foldChange(existing, change);
    if (folded) {
      changes[index] = folded;
      return;
    }
    break;
  }
  changes.push(change);
}

/**
 * Join two consecutive `streaming` frames of the same call into one, folding
 * contiguous appends to the same string. Returns `undefined` when the frames
 * must stay separate (different calls, or a lifecycle frame); the caller then
 * emits `previous` before `next`. Neither input is mutated.
 */
export function mergeToolDraftEvents(
  previous: ToolDraftAgentEvent,
  next: ToolDraftAgentEvent,
): ToolDraftAgentEvent | undefined {
  if (
    previous.toolCallId !== next.toolCallId ||
    previous.phase !== "streaming" ||
    next.phase !== "streaming"
  ) {
    return undefined;
  }
  const changes = [...(previous.changes ?? [])];
  for (const change of next.changes ?? []) appendChange(changes, change);
  return { ...next, changes };
}

/**
 * Characters a draft frame's changes carry, for frame-size gates and payload
 * benchmarks. Cheap on the hot path: string payloads are counted, not encoded.
 */
export function toolDraftPayloadChars(event: ToolDraftAgentEvent): number {
  let chars = 0;
  for (const change of event.changes ?? []) {
    for (const segment of change.path) chars += String(segment).length + 3;
    if (change.op === "append") {
      chars += change.text.length;
    } else if (typeof change.value === "string") {
      chars += change.value.length;
    } else {
      chars += JSON.stringify(change.value)?.length ?? 4;
    }
  }
  return chars;
}
