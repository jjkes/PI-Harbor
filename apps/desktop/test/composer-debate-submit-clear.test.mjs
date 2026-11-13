import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { submitWithLatestDraftRestore } from "../src/features/chat/composer/hooks/submit-with-latest-draft-restore.mjs";

// The submit orchestration is what clearing depends on, so it is loaded for
// real and only its collaborators are faked: the draft controller it clears
// through, and the store actions it sends through. Every other import of the
// hook would be a dependency this harness has to know about.
function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected composer-submit dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

// The real rewrite the debate button passes: the test must fail on the actual
// prompt the composer sends, not on a stand-in. The prompt composes the one
// instruction block the transcript row also splits, so that module is loaded
// for real too.
const debateInstruction = load(
  "../src/features/plan-debate/debate-instruction.ts",
  {},
);
const { planDebateRequest } = load(
  "../src/features/plan-debate/plan-debate-prompt.ts",
  { "./debate-instruction": debateInstruction },
);
const { useComposerSubmit } = load(
  "../src/features/chat/composer/hooks/useComposerSubmit.ts",
  {
    "@pi-harbor/shared": {
      serializeComposerFileReferences: (text) => text,
      serializeInlineComposerFileReferences: (text) => text,
    },
    "../../../../lib/api": { api: { executeCommand: async () => {} } },
    "../../../../lib/commands": {
      runExtensionCommand: async () => {},
      runPaletteCommand: async () => {},
    },
    "../../../../hooks/use-composer-autocomplete": {
      resolveComposerCommand: async () => null,
    },
    "../slash-dispatch": {
      parseSlashSubmission: () => null,
      resolveSlashDispatch: () => ({ action: "prompt" }),
    },
    "../editor": { readEditorValue: () => "" },
    "../../../../lib/queued-prompts": { nextSendableQueuedPrompt: () => undefined },
    "./submit-with-latest-draft-restore.mjs": { submitWithLatestDraftRestore },
    "../../btw/btw-controller": { btwController: { runCommand: async () => false } },
    "../../btw/btw-model": { parseBtwCommand: () => null },
  },
);

const TYPED = "Add a dark mode to the composer";

/**
 * The composer with one draft in its editor.
 *
 * `clearDraftForKey` mirrors `useComposerDraft`: it clears only while the live
 * editor still holds the submitted snapshot, and `restoreDraftForKey` puts that
 * snapshot back after a rejected send. Both compare the *text*, so a submit
 * that snapshots a rewritten prompt leaves the editor holding the original —
 * which is exactly the regression these tests exist for.
 */
function harness({
  typed = TYPED,
  sendBlocked = false,
  modelReady = true,
  accepted = true,
} = {}) {
  const state = { editor: typed, cleared: [], restored: [], sent: [], toasts: [], history: [] };
  const draft = {
    // No mounted editor: the composer reads its `value` prop instead, which is
    // the same text the controller would read out of the DOM.
    ref: { current: null },
    draftSnapshot: (text) => ({ text: text.trim(), fileReferences: [] }),
    draftRevision: () => 7,
    clearDraftForKey: (key, revision, submitted) => {
      if (revision !== 7) return;
      if (state.editor.trim() !== submitted.text) return;
      state.cleared.push(submitted.text);
      state.editor = "";
    },
    restoreDraftForKey: (key, snapshot) => {
      if (state.editor.trim()) return;
      state.restored.push(snapshot.text);
      state.editor = snapshot.text;
    },
  };
  const { submit } = useComposerSubmit({
    value: typed,
    draftKey: "session-1",
    activeSessionId: "session-1",
    modelReady,
    sendBlocked,
    invalidateComposerTransforms: () => {},
    pasting: false,
    activeFileReferences: [],
    t: (key) => key,
    sendPrompt: async (content, snapshot, sessionId, onAccepted) => {
      state.sent.push({ content, snapshot });
      if (accepted) onAccepted?.(sessionId);
      return accepted;
    },
    steerPrompt: async (content, snapshot) => {
      state.sent.push({ content, snapshot });
      return accepted;
    },
    sendQueuedNow: async () => {},
    queuedPrompts: [],
    showToast: (message) => state.toasts.push(message),
    recordHistory: (snapshot) => state.history.push(snapshot),
    draft,
  });
  return { submit, state };
}

test("a debate request clears the editor although its rewrite changes the text", async () => {
  const { submit, state } = harness();
  await submit(false, planDebateRequest);

  const sent = state.sent.at(-1);
  assert.ok(sent, "the debate request was sent");
  // The prompt is the rewritten instruction, not the typed text.
  assert.ok(sent.content.startsWith(TYPED), "the requirement leads the prompt");
  assert.match(sent.content, /PlanDebate/);
  assert.notEqual(sent.content, TYPED, "the rewrite must differ from the typed text");

  // The editor is empty, and it was cleared against the typed text: the fake
  // controller only clears while the live editor equals the submitted snapshot.
  assert.equal(state.editor, "", "a debate request must not leave the requirement behind");
  assert.deepEqual(state.cleared, [TYPED]);
  // Recall keeps the user's words, not the wrapping instruction.
  assert.deepEqual(state.history, [{ text: TYPED, fileReferences: [] }]);
});

test("an ordinary send still clears, snapshotting the typed text", async () => {
  const { submit, state } = harness();
  await submit();

  assert.equal(state.sent.at(-1).content, TYPED);
  assert.equal(state.editor, "");
  assert.deepEqual(state.cleared, [TYPED]);
});

test("a blocked or unready submission keeps the draft", async () => {
  const blocked = harness({ sendBlocked: true });
  await blocked.submit(false, planDebateRequest);
  assert.equal(blocked.state.sent.length, 0);
  assert.deepEqual(blocked.state.cleared, []);
  assert.equal(blocked.state.editor, TYPED);

  const unready = harness({ modelReady: false });
  await unready.submit(false, planDebateRequest);
  assert.equal(unready.state.sent.length, 0);
  assert.deepEqual(unready.state.cleared, []);
  assert.equal(unready.state.editor, TYPED);
  assert.deepEqual(unready.state.toasts, ["errors.MODEL_NOT_CONFIGURED"]);
});

test("a rejected send restores the typed text, for a debate request too", async () => {
  const plain = harness({ accepted: false });
  await plain.submit();
  assert.deepEqual(plain.state.cleared, [TYPED], "the draft clears before the round trip");
  assert.deepEqual(plain.state.restored, [TYPED]);
  assert.equal(plain.state.editor, TYPED);

  const debate = harness({ accepted: false });
  await debate.submit(false, planDebateRequest);
  assert.deepEqual(debate.state.restored, [TYPED], "the user's words come back, not the instruction");
  assert.equal(debate.state.editor, TYPED);
  assert.match(debate.state.sent.at(-1).content, /PlanDebate/);
});
