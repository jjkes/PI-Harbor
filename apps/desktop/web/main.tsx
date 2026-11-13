/**
 * Entry point of the plan-debate web harness — a verification page, not a
 * product surface.
 *
 * It renders the real `PlanDebateTab` with the real app store, the real i18n
 * catalogs and the real stylesheet, and replaces only the one thing a browser
 * cannot have: the Electron preload bridge (`./mock-bridge.ts`). Anything wrong
 * on this page is therefore a renderer bug; a host, IPC or persistence bug
 * cannot be reproduced here.
 *
 * Run it with `pnpm --filter @pi-harbor/desktop web` and read
 * `docs/design/plan-debate-web-harness.md`.
 */
import "./install";
import { useState } from "react";
import ReactDOM from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { flattenCatalog } from "@pi-harbor/i18n/locale-info";
import { en } from "@pi-harbor/i18n/locales/en";
import { zhCN } from "@pi-harbor/i18n/locales/zh-CN";
import { PlanDebateTab } from "../src/components/workpanel/PlanDebateTab";
import { useAppStore } from "../src/stores/app-store";
import {
  SCENARIO_LABEL,
  HARNESS_SCENARIOS,
  HARNESS_SESSION_ID,
  artifactsFor,
  sessionFixture,
  transcriptFor,
  type HarnessScenario,
} from "./fixtures";
import { mockCallLog, setMockArtifacts } from "./mock-bridge";
import "../src/styles/globals.css";
import "./harness.css";

// The product's stylesheet is written against a themed document element; the
// desktop window sets these before first paint (src/main.tsx).
document.documentElement.dataset.theme = "dark";
document.documentElement.dataset.platform = "darwin";

/**
 * The catalogs, flattened the way the renderer flattens them, so the page reads
 * the same keys the app reads. There is no backend to wait for, but the render
 * still starts from the init's resolution: a half-initialised i18n paints
 * raw keys.
 */
const i18nReady = i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: {
    en: { translation: flattenCatalog(en as unknown as Record<string, unknown>) },
    "zh-CN": { translation: flattenCatalog(zhCN as unknown as Record<string, unknown>) },
  },
  interpolation: { escapeValue: false },
});

const DEFAULT_SCENARIO: HarnessScenario = "transcript-only";

/**
 * Seed the store with the scenario: one session, its transcript, and the action
 * stubs the panel calls. Seeding is synchronous and happens before the render
 * that reads it, so the panel never paints a half-applied scenario.
 */
function seed(scenario: HarnessScenario): void {
  setMockArtifacts(artifactsFor(scenario));
  useAppStore.setState({
    ready: true,
    activeSessionId: HARNESS_SESSION_ID,
    sessions: [sessionFixture()],
    messages: transcriptFor(scenario),
    retainedSessionIds: [],
    retainedTranscripts: {},
    transcriptViews: {},
    sessionHistory: {},
    sessionCompactions: {},
    runningSessions: {},
    agentStatuses: {},
    isRunning: false,
    // The hand-off and re-debate paths send a prompt; here it is only logged.
    sendPrompt: async (content) => {
      console.info("[harness] sendPrompt", content);
      return true;
    },
    configureActiveSession: async () => undefined,
    openSubagentTab: (delegationId, agentName) => {
      console.info("[harness] openSubagentTab", delegationId, agentName);
    },
  });
}

seed(DEFAULT_SCENARIO);

function HarnessBar({
  scenario,
  locale,
  onScenario,
  onLocale,
  onRemount,
}: {
  scenario: HarnessScenario;
  locale: "en" | "zh-CN";
  onScenario: (next: HarnessScenario) => void;
  onLocale: (next: "en" | "zh-CN") => void;
  onRemount: () => void;
}) {
  const calls = mockCallLog();
  return (
    <header className="harness-bar">
      <div className="harness-row">
        <strong className="harness-title">plan-debate web harness</strong>
        <span className="harness-note">
          debug page · mocked IPC · nothing here is packaged
        </span>
      </div>
      <div className="harness-row">
        <span className="harness-label">fixture</span>
        {HARNESS_SCENARIOS.map((item) => (
          <button
            key={item}
            type="button"
            className={`harness-button${item === scenario ? " is-active" : ""}`}
            aria-pressed={item === scenario}
            title={SCENARIO_LABEL[item]}
            data-harness-scenario={item}
            onClick={() => onScenario(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="harness-row">
        <span className="harness-label">locale</span>
        {(["en", "zh-CN"] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={`harness-button${item === locale ? " is-active" : ""}`}
            aria-pressed={item === locale}
            data-harness-locale={item}
            onClick={() => onLocale(item)}
          >
            {item}
          </button>
        ))}
        <span className="harness-label">state</span>
        <button type="button" className="harness-button" onClick={onRemount}>
          remount panel
        </button>
      </div>
      <p className="harness-proves">{SCENARIO_LABEL[scenario]}</p>
      <p className="harness-ipc">
        last IPC channels: {calls.length === 0 ? "(none yet)" : calls.join(" · ")}
      </p>
    </header>
  );
}

function Harness() {
  const [scenario, setScenario] = useState<HarnessScenario>(DEFAULT_SCENARIO);
  const [locale, setLocale] = useState<"en" | "zh-CN">("en");
  // Bumped on every switch so the panel remounts and re-reads its artifacts,
  // which is what a real session does when the tab is opened.
  const [generation, setGeneration] = useState(0);

  function selectScenario(next: HarnessScenario): void {
    seed(next);
    setScenario(next);
    setGeneration((value) => value + 1);
  }

  function selectLocale(next: "en" | "zh-CN"): void {
    void i18n.changeLanguage(next);
    setLocale(next);
  }

  return (
    <>
      <HarnessBar
        scenario={scenario}
        locale={locale}
        onScenario={selectScenario}
        onLocale={selectLocale}
        onRemount={() => setGeneration((value) => value + 1)}
      />
      <main className="harness-panel">
        <PlanDebateTab
          key={`${scenario}:${locale}:${generation}`}
          sessionId={HARNESS_SESSION_ID}
        />
      </main>
    </>
  );
}

function start(): void {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("harness root element missing");
  ReactDOM.createRoot(rootElement).render(<Harness />);
}

i18nReady.then(start, (error: unknown) => {
  console.error("[harness] i18n failed to initialise", error);
});
