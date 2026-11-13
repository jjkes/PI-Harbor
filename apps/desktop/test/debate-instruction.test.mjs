/**
 * A plan-debate launch carries its framing as a `<details>` block; the bubble
 * must show the requirement and the block must come out as a chip. The pure
 * split is what keeps the prompt and the transcript row in lockstep.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  splitDebateInstruction,
  joinDebateInstruction,
  debateInstructionBlock,
  DEBATE_INSTRUCTION_BODY,
} = await import("../src/features/plan-debate/debate-instruction.ts");
const { planDebateRequest } = await import(
  "../src/features/plan-debate/plan-debate-prompt.ts"
);

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const messageRow = await read("../src/features/chat/transcript/MessageRow.tsx");
const chip = await read("../src/features/plan-debate/DebateInstructionChip.tsx");

test("the launch prompt splits into requirement + instruction", () => {
  const { body, instruction } = splitDebateInstruction(
    planDebateRequest("  为单体应用设计缓存选型  "),
  );
  assert.equal(body, "为单体应用设计缓存选型");
  assert.equal(instruction, DEBATE_INSTRUCTION_BODY);
  assert.doesNotMatch(body, /<details>/);
});

test("a message with no block comes back untouched", () => {
  const text = "帮我写一个辩论练习的文案，用户之前说的也提到过辩论。";
  const split = splitDebateInstruction(text);
  assert.equal(split.body, text);
  assert.equal(split.instruction, undefined);
});

test("a details block whose summary is not a debate framing stays in the text", () => {
  const text = "req\n\n<details>\n<summary>背景说明</summary>\n\ncontext\n\n</details>";
  const split = splitDebateInstruction(text);
  assert.equal(split.body, text);
  assert.equal(split.instruction, undefined);
});

test("a block with no closing tag is malformed and stays untouched", () => {
  const text = "req\n\n<details>\n<summary>辩论指示 / Debate instruction</summary>\n\nPlanDebate";
  const split = splitDebateInstruction(text);
  assert.equal(split.body, text);
  assert.equal(split.instruction, undefined);
});

test("the first debate block is taken, the rest stays in the body", () => {
  const text =
    "a\n\n<details>\n<summary>辩论指示 / Debate instruction</summary>\n\nfirst\n\n</details>\n\nb\n\n<details>\n<summary>辩论指示 / Debate instruction</summary>\n\nsecond\n\n</details>";
  const { body, instruction } = splitDebateInstruction(text);
  assert.equal(instruction, "first");
  assert.match(body, /^a/);
  assert.match(body, /second/);
  assert.match(body, /<details>/);
});

test("whitespace and case do not matter to the match", () => {
  const text =
    "  中需求  \n\n  <details>\n  <summary>debate instruction</summary>\n\n Do the thing. \n\n  </details>\n ";
  const { body, instruction } = splitDebateInstruction(text);
  assert.equal(body, "中需求");
  assert.equal(instruction, "Do the thing.");
});

test("joining is the inverse of splitting", () => {
  const prompt = planDebateRequest("为单体应用设计缓存选型");
  const { body, instruction } = splitDebateInstruction(prompt);
  assert.equal(joinDebateInstruction(body, instruction), prompt);
  assert.equal(debateInstructionBlock(instruction).includes(instruction), true);
});

test("MessageRow renders the chip, never the raw block", () => {
  assert.match(messageRow, /splitDebateInstruction\(source\)/);
  assert.match(messageRow, /splitInlineContent\(\s*userText\.body/);
  assert.match(messageRow, /<DebateInstructionChip instruction=\{userText\.instruction\} \/>/);
  assert.doesNotMatch(messageRow, /splitInlineContent\(\s*String\(message\.content/);
  // the chip is mounted under the bubble (after its closing tag), not in it
  const bubbleEnd = messageRow.indexOf("</div>", messageRow.indexOf("message-user-text"));
  const chipIndex = messageRow.indexOf("<DebateInstructionChip");
  assert.ok(bubbleEnd > 0 && chipIndex > bubbleEnd, "chip sits below the bubble");
  assert.match(chip, /<details/);
  assert.match(chip, /<summary/);
  assert.match(chip, /t\("planning\.debateChip"\)/);
  assert.doesNotMatch(chip, /message\.content/);
});

test("editing edits the body and the resend keeps the framing", () => {
  assert.match(messageRow, /editSeed = \(editableUserMessage && message\.command\) \|\| userText\.body/);
  assert.match(messageRow, /setEditValue\(full\.command \|\| splitDebateInstruction\(full\.content \|\| ""\)\.body\)/);
  assert.match(messageRow, /joinDebateInstruction\(next, userText\.instruction\)/);
});
