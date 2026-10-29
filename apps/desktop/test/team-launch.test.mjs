import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capabilitiesFromModelConfig, modelConfigWithBinding } from "@pi-harbor/agent-runtime";
import { subagentCanMutate } from "@pi-harbor/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");
const { composeTeamLaunch, readSessionTeamConfig } = await import("../electron/main/runtime/team-launch.ts");

const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };

function provider(id, models) {
  return {
    id,
    vendorKey: id,
    name: id,
    enabled: true,
    authKind: "api-key",
    baseUrl: "http://127.0.0.1:1/v1",
    apiStyle: "openai-chat",
    models: models.map((model) => ({
      id: typeof model === "string" ? model : model.id,
      availableForSubagents: typeof model === "object" && model.availableForSubagents === true,
      thinkingLevels: ["off"],
    })),
  };
}

function launchHarness(t, initialTeam, { disabledBuiltins = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-team-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let team = initialTeam;
  const documents = [
    ["first", "provider-one/original", "provider-two/original-backup"],
    ["second", "provider-two/default", "provider-three/default-backup"],
    ["unresolved", null, null],
    ["broken-default", "missing-provider/default", null],
  ];
  const records = documents.map(([name, model, fallback]) => {
    const path = join(root, `${name}.md`);
    writeFileSync(path, [
      "---",
      `name: ${name}`,
      `description: Fixture ${name}`,
      ...(model ? [`model: ${model}`] : []),
      ...(fallback ? [`fallbackModels: [${fallback}]`] : []),
      "---",
      `Run ${name}.`,
    ].join("\n"));
    return { id: name, path };
  });
  const providers = [
    provider("session-provider", ["parent"]),
    provider("provider-one", ["original", "card", { id: "override", availableForSubagents: true }]),
    provider("provider-two", ["original-backup", "default"]),
    provider("provider-three", ["default-backup"]),
  ];
  const logs = [];
  const hostCalls = [];
  const runtime = createSessionLaunchRuntime({
    runtimeState: {
      host: {
        isAvailable: () => true,
        call: async (method, input) => {
          hostCalls.push({ method, input });
          if (method === "commandShells.list") {
            return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
          }
          if (method === "providers.list") return { providers };
          if (method === "providers.getSecret") return { value: `secret-${input.id}` };
          if (method === "session.team.get") return team;
          if (method === "agents.active") return { subagents: records };
          if (method === "agents.disabledBuiltins") return { disabled: disabledBuiltins };
          if (method === "skills.disabledBuiltins") return { disabled: [] };
          if (method === "skills.active") return { skills: [] };
          if (method === "mcp.active") return { servers: [] };
          if (method === "project.group.context") {
            return { context: { roots: [{ path: root }] } };
          }
          throw new Error(`Unexpected host call ${method}`);
        },
      },
      sidecar: { setVendorAuthBindings() {} },
    },
    logger: { app: (...args) => logs.push(args) },
    userMcp: { setRecords() {}, toolsForProject: async () => [] },
    plugins: { listLoaded: () => [], getSkills: () => [], getTools: () => [], getAgentExtensions: () => [] },
    sessionProjects: new Map(),
    dataDir: root,
    vendorOAuth: { bindingFor: async () => undefined },
    modelsDevCatalog: { configureAccount() {}, ensureLoaded: async () => {}, findModel: () => undefined },
    getWorkspacePath: () => root,
    pluginActiveInProject: () => true,
    bindingForModel: (row, id) => row.models.find((model) => model.id === id),
    effectiveSubagentModelConfig: (row, id, catalog) => {
      const modelConfig = modelConfigWithBinding(catalog, row.models.find((model) => model.id === id));
      return { modelConfig, capabilities: capabilitiesFromModelConfig(modelConfig) };
    },
    normalizeThinkingLevel: () => "off",
  });
  return {
    root,
    logs,
    hostCalls,
    setTeam: (next) => { team = next; },
    launch: async () => (await runtime.resolveAgentRuntimeLaunch("session-1", {
      providerId: "session-provider",
      modelId: "parent",
      projectPath: root,
    }, {})).sidecarParams,
  };
}

test("team launch uses roster order, card pins and existing credential resolution", async (t) => {
  const harness = launchHarness(t, {
    sessionId: "session-1",
    enabled: true,
    revision: 12,
    members: [
      { agent: "second" },
      { agent: "first", model: { providerId: "provider-one", modelId: "card" } },
      { agent: "unresolved", model: { providerId: "missing-provider", modelId: "card" } },
      { agent: "broken-default" },
      { agent: "code-reviewer" },
      { agent: "not-installed" },
    ],
  }, { disabledBuiltins: ["code-reviewer"] });
  const params = await harness.launch();

  assert.deepEqual(params.subagents.map((definition) => definition.name), ["second", "first"]);
  const second = params.subagents[0];
  assert.deepEqual(second.model, { providerId: "provider-two", modelId: "default" });
  assert.deepEqual(second.fallbackModels, [{ providerId: "provider-three", modelId: "default-backup" }]);
  const first = params.subagents[1];
  assert.deepEqual(first.model, { providerId: "provider-one", modelId: "card" });
  assert.deepEqual(first.fallbackModels, []);
  assert.deepEqual(Object.keys(params.subagentProviders), [
    "provider-two/default",
    "provider-three/default-backup",
    "provider-one/card",
  ]);
  assert.equal(params.subagentProviders["provider-one/card"].apiKey, "secret-provider-one");
  assert.deepEqual(params.team, { enabled: true, revision: 12 });
  assert.equal("subagentModelKeys" in params, false);

  // Effective definitions are launch-only copies; their Markdown is untouched.
  const source = readFileSync(join(harness.root, "first.md"), "utf8");
  assert.match(source, /model: provider-one\/original/);
  assert.match(source, /fallbackModels: \[provider-two\/original-backup\]/);
  const diagnostics = JSON.stringify(harness.logs);
  for (const excluded of ["unresolved", "broken-default", "code-reviewer", "not-installed"]) {
    assert.ok(diagnostics.includes(excluded), `${excluded} exclusion was not diagnosed`);
  }
});

test("an enabled empty roster launches without Task definitions or AI override keys", async (t) => {
  const harness = launchHarness(t, {
    sessionId: "session-1",
    enabled: true,
    revision: 3,
    members: [],
  });
  const params = await harness.launch();
  assert.deepEqual(params.subagents, []);
  assert.deepEqual(params.subagentProviders, {});
  assert.deepEqual(params.team, { enabled: true, revision: 3 });
  assert.equal("subagentModelKeys" in params, false);
});

test("disabled and missing team config preserve the existing launch payload", async (t) => {
  const harness = launchHarness(t, {
    sessionId: "session-1",
    enabled: false,
    revision: 9,
    members: [{ agent: "first", model: { providerId: "provider-one", modelId: "card" } }],
  });
  const disabled = await harness.launch();
  assert.equal("team" in disabled, false);
  assert.deepEqual(disabled.subagentModelKeys, ["provider-one/override"]);
  const first = disabled.subagents.find((definition) => definition.name === "first");
  assert.deepEqual(first.model, { providerId: "provider-one", modelId: "original" });
  assert.deepEqual(first.fallbackModels, [{ providerId: "provider-two", modelId: "original-backup" }]);

  harness.setTeam(null);
  const missing = await harness.launch();
  assert.deepEqual(missing, disabled);
});

test("team composition enforces the provider cap before resolving pins", async () => {
  const definitions = Array.from({ length: 9 }, (_, index) => ({
    name: `agent-${index}`,
    description: `Agent ${index}`,
    tools: [],
    prompt: "Work",
    source: "user",
    model: { providerId: `provider-${index}`, modelId: "model" },
  }));
  const resolvedNames = [];
  const result = await composeTeamLaunch({
    sessionId: "session-1",
    enabled: true,
    revision: 4,
    members: definitions.map((definition) => ({ agent: definition.name })),
  }, definitions, async (roster) => {
    resolvedNames.push(...roster.map((definition) => definition.name));
    return {
      providers: Object.fromEntries(roster.map((definition) => [
        `${definition.model.providerId}/${definition.model.modelId}`,
        { id: definition.model.providerId, name: definition.model.providerId, modelId: "model", apiKey: "" },
      ])),
      diagnostics: [],
    };
  });
  assert.deepEqual(resolvedNames, definitions.slice(0, 8).map((definition) => definition.name));
  assert.deepEqual(result.definitions.map((definition) => definition.name), resolvedNames);
  assert.equal(Object.keys(result.providers).length, 8);
  assert.match(result.diagnostics.join("\n"), /agent-8: too many pinned providers/);
});

test("remote launch never reads or applies a stale local team row", async () => {
  const calls = [];
  const host = {
    call: async (method, input) => {
      calls.push({ method, input });
      return { sessionId: "session-1", enabled: true, revision: 8, members: [{ agent: "first" }] };
    },
  };
  assert.equal(await readSessionTeamConfig(host, "session-1", true), null);
  assert.deepEqual(calls, []);
  assert.deepEqual(await readSessionTeamConfig(host, "session-1", false), {
    sessionId: "session-1",
    enabled: true,
    revision: 8,
    members: [{ agent: "first" }],
  });
  assert.deepEqual(calls, [{ method: "session.team.get", input: { sessionId: "session-1" } }]);
});

function teamDefinition(name, overrides = {}) {
  return {
    name,
    description: `${name} role`,
    tools: ["Read", "Grep"],
    prompt: "Work",
    source: "user",
    ...overrides,
  };
}

async function composeWithoutPins(members, definitions) {
  return composeTeamLaunch(
    { sessionId: "session-1", enabled: true, revision: 6, members },
    definitions,
    async () => ({ providers: {}, diagnostics: [] }),
  );
}

test("members switched off for the session are excluded without a diagnostic", async () => {
  const result = await composeWithoutPins(
    [
      { agent: "explorer" },
      { agent: "fixer", enabled: false, thinkingLevel: "high" },
      { agent: "code-reviewer", enabled: true },
    ],
    [teamDefinition("explorer"), teamDefinition("fixer"), teamDefinition("code-reviewer")],
  );
  assert.deepEqual(result.definitions.map((definition) => definition.name), ["explorer", "code-reviewer"]);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.team, { enabled: true, revision: 6 });
});

test("session tool and thinking settings apply only to the launch copy", async () => {
  const reviewer = teamDefinition("code-reviewer", { thinkingLevel: "low" });
  const original = structuredClone(reviewer);
  const result = await composeWithoutPins(
    [{ agent: "code-reviewer", tools: ["Read", "Edit"], thinkingLevel: "high" }],
    [reviewer],
  );
  const [effective] = result.definitions;
  assert.deepEqual(effective.tools, ["Read", "Edit"]);
  assert.equal(effective.inheritTools, false);
  assert.equal(effective.thinkingLevel, "high");
  // The added write tool makes the member write-capable for locks, worktrees
  // and nested capability filtering, while the role itself stays read-only.
  assert.equal(subagentCanMutate(effective), true);
  assert.equal(subagentCanMutate(reviewer), false);
  assert.deepEqual(reviewer, original);
  assert.deepEqual(result.diagnostics, []);
});

test("an inherit grant and an unusable tool override are composed safely", async () => {
  const result = await composeWithoutPins(
    [
      { agent: "worker", tools: ["inherit"] },
      { agent: "code-reviewer", tools: ["Nope"] },
    ],
    [teamDefinition("worker"), teamDefinition("code-reviewer")],
  );
  const [worker, reviewer] = result.definitions;
  assert.deepEqual(worker.tools, []);
  assert.equal(worker.inheritTools, true);
  assert.deepEqual(reviewer.tools, ["Read", "Grep"]);
  assert.equal(reviewer.inheritTools, undefined);
  assert.match(result.diagnostics.join("\n"), /code-reviewer: session tool override has no usable tool/);
});
