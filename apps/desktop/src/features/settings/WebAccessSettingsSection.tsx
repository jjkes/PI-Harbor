import {
  validateWebAccessInput,
  WEB_ACCESS_MAX_PORT,
  WEB_ACCESS_MIN_PORT,
  WEB_ACCESS_PASSWORD_MAX_LENGTH,
  WEB_ACCESS_PASSWORD_MIN_LENGTH,
  WEB_ACCESS_USERNAME_MAX_LENGTH,
  type WebAccessBind,
  type WebAccessConfigureInput,
  type WebAccessInputProblem,
  type WebAccessState,
  type WebAccessStatus,
  type WebAccessTlsMode,
} from "@pi-harbor/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, PasswordInput, Select, SettingsToggle } from "../../components/ui";
import { api } from "../../lib/api";
import { isWebAccessClient, signOutOfWebAccess } from "../../lib/web-access/mode";
import { SettingsCard, SettingsRow } from "./primitives";

/** The editable form; the port stays text until it is validated. */
export type WebAccessDraft = {
  enabled: boolean;
  bind: WebAccessBind;
  port: string;
  username: string;
  password: string;
  tlsMode: WebAccessTlsMode;
  certPath: string;
  keyPath: string;
};

export function draftFromStatus(status: WebAccessStatus): WebAccessDraft {
  return {
    enabled: status.enabled,
    bind: status.bind,
    port: String(status.port),
    username: status.username,
    password: "",
    tlsMode: status.tls.mode,
    certPath: status.tls.certPath,
    keyPath: status.tls.keyPath,
  };
}

export function inputFromDraft(draft: WebAccessDraft): WebAccessConfigureInput {
  const portText = draft.port.trim();
  return {
    enabled: draft.enabled,
    bind: draft.bind,
    port: /^\d+$/.test(portText) ? Number(portText) : Number.NaN,
    username: draft.username.trim(),
    ...(draft.password ? { password: draft.password } : {}),
    tls:
      draft.tlsMode === "custom"
        ? { mode: "custom", certPath: draft.certPath.trim(), keyPath: draft.keyPath.trim() }
        : { mode: "self-signed" },
  };
}

const PROBLEM_KEYS: Record<WebAccessInputProblem, string> = {
  port: "webAccess.settings.problems.port",
  usernameRequired: "webAccess.settings.problems.usernameRequired",
  usernameInvalid: "webAccess.settings.problems.usernameInvalid",
  passwordRequired: "webAccess.settings.problems.passwordRequired",
  passwordLength: "webAccess.settings.problems.passwordLength",
  certPathRequired: "webAccess.settings.problems.certPathRequired",
  keyPathRequired: "webAccess.settings.problems.keyPathRequired",
};

const STATE_KEYS: Record<WebAccessState, string> = {
  disabled: "webAccess.settings.state.disabled",
  starting: "webAccess.settings.state.starting",
  running: "webAccess.settings.state.running",
  error: "webAccess.settings.state.error",
};

function problemValues(problem: WebAccessInputProblem): Record<string, number> {
  switch (problem) {
    case "port":
      return { min: WEB_ACCESS_MIN_PORT, max: WEB_ACCESS_MAX_PORT };
    case "passwordLength":
      return { min: WEB_ACCESS_PASSWORD_MIN_LENGTH, max: WEB_ACCESS_PASSWORD_MAX_LENGTH };
    case "usernameInvalid":
      return { max: WEB_ACCESS_USERNAME_MAX_LENGTH };
    default:
      return {};
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Notice = { tone: "error" | "status"; text: string } | null;

/**
 * Browser web access (ADR 0342). The desktop window owns the settings; a
 * signed-in browser only sees that it is one and can sign itself out.
 */
export function WebAccessSettingsSection() {
  return isWebAccessClient() ? <WebAccessClientCard /> : <WebAccessOwnerCard />;
}

function WebAccessClientCard() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  return (
    <SettingsCard title={t("webAccess.settings.title")}>
      <SettingsRow title={t("webAccess.client.signedIn")} detail={t("webAccess.client.manageOnDesktop")}>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void signOutOfWebAccess();
          }}
        >
          {t("webAccess.client.signOut")}
        </Button>
      </SettingsRow>
    </SettingsCard>
  );
}

function WebAccessOwnerCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WebAccessStatus | null>(null);
  const [draft, setDraft] = useState<WebAccessDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const mounted = useRef(true);
  // Status pushes must not overwrite what the owner is typing.
  const dirtyRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const accept = useCallback((next: WebAccessStatus) => {
    setStatus(next);
    if (!dirtyRef.current) setDraft(draftFromStatus(next));
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const next = await api.getWebAccessStatus();
      if (mounted.current) accept(next);
    } catch (error) {
      if (mounted.current) setLoadError(errorText(error));
    }
  }, [accept]);

  useEffect(() => {
    void load();
    return api.onWebAccessChanged((next) => {
      if (mounted.current) accept(next);
    });
  }, [accept, load]);

  const update = (patch: Partial<WebAccessDraft>) => {
    dirtyRef.current = true;
    setDirty(true);
    setNotice(null);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const discard = () => {
    if (!status) return;
    dirtyRef.current = false;
    setDirty(false);
    setNotice(null);
    setDraft(draftFromStatus(status));
  };

  const save = async () => {
    if (!draft || !status) return;
    const input = inputFromDraft(draft);
    const problem = validateWebAccessInput(input, status.hasPassword);
    if (problem) {
      setNotice({ tone: "error", text: t(PROBLEM_KEYS[problem], problemValues(problem)) });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const next = await api.configureWebAccess(input);
      if (!mounted.current) return;
      dirtyRef.current = false;
      setDirty(false);
      setStatus(next);
      setDraft(draftFromStatus(next));
      setNotice({ tone: "status", text: t("webAccess.settings.saved") });
    } catch (error) {
      if (mounted.current) {
        setNotice({
          tone: "error",
          text: t("webAccess.settings.saveFailed", { error: errorText(error) }),
        });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const next = await api.revokeWebAccessSessions();
      if (!mounted.current) return;
      setStatus(next);
      setNotice({ tone: "status", text: t("webAccess.settings.revoked") });
    } catch (error) {
      if (mounted.current) {
        setNotice({
          tone: "error",
          text: t("webAccess.settings.revokeFailed", { error: errorText(error) }),
        });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  if (!status || !draft) {
    return (
      <SettingsCard title={t("webAccess.settings.title")}>
        <SettingsRow
          title={
            loadError
              ? t("webAccess.settings.loadFailed", { error: loadError })
              : t("webAccess.settings.loading")
          }
        >
          {loadError ? (
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t("webAccess.settings.retry")}
            </Button>
          ) : null}
        </SettingsRow>
      </SettingsCard>
    );
  }

  let statusDetail: string | undefined;
  if (status.state === "error" && status.error) {
    statusDetail = t("webAccess.settings.errorDetail", { error: status.error });
  } else if (status.state === "running") {
    statusDetail = t("webAccess.settings.runningDetail", { urls: status.urls.join("  ") });
  }

  return (
    <SettingsCard title={t("webAccess.settings.title")} description={t("webAccess.settings.description")}>
      <SettingsRow title={t("webAccess.settings.enable")} detail={t("webAccess.settings.warning")}>
        <SettingsToggle
          checked={draft.enabled}
          label={t("webAccess.settings.enable")}
          disabled={busy}
          onChange={() => update({ enabled: !draft.enabled })}
        />
      </SettingsRow>

      <SettingsRow title={t("webAccess.settings.status")} detail={statusDetail}>
        <span>{t(STATE_KEYS[status.state])}</span>
      </SettingsRow>

      <SettingsRow
        title={t("webAccess.settings.network")}
        detail={
          draft.bind === "all"
            ? t("webAccess.settings.networkAllDetail")
            : t("webAccess.settings.networkLoopbackDetail")
        }
      >
        <Select
          value={draft.bind}
          disabled={busy}
          aria-label={t("webAccess.settings.network")}
          onChange={(event) => update({ bind: event.target.value === "loopback" ? "loopback" : "all" })}
        >
          <option value="all">{t("webAccess.settings.networkAll")}</option>
          <option value="loopback">{t("webAccess.settings.networkLoopback")}</option>
        </Select>
      </SettingsRow>

      <SettingsRow
        title={t("webAccess.settings.port")}
        detail={t("webAccess.settings.portDetail", { min: WEB_ACCESS_MIN_PORT, max: WEB_ACCESS_MAX_PORT })}
      >
        <Input
          value={draft.port}
          inputMode="numeric"
          disabled={busy}
          aria-label={t("webAccess.settings.port")}
          onChange={(event) => update({ port: event.target.value })}
        />
      </SettingsRow>

      <SettingsRow title={t("webAccess.settings.username")}>
        <Input
          value={draft.username}
          autoComplete="off"
          maxLength={WEB_ACCESS_USERNAME_MAX_LENGTH}
          disabled={busy}
          aria-label={t("webAccess.settings.username")}
          onChange={(event) => update({ username: event.target.value })}
        />
      </SettingsRow>

      <SettingsRow
        title={t("webAccess.settings.password")}
        detail={
          status.hasPassword
            ? t("webAccess.settings.passwordKeep", { min: WEB_ACCESS_PASSWORD_MIN_LENGTH })
            : t("webAccess.settings.passwordNew", { min: WEB_ACCESS_PASSWORD_MIN_LENGTH })
        }
      >
        <PasswordInput
          value={draft.password}
          autoComplete="new-password"
          maxLength={WEB_ACCESS_PASSWORD_MAX_LENGTH}
          disabled={busy}
          aria-label={t("webAccess.settings.password")}
          showLabel={t("webAccess.settings.showPassword")}
          hideLabel={t("webAccess.settings.hidePassword")}
          onChange={(event) => update({ password: event.target.value })}
        />
      </SettingsRow>

      <SettingsRow
        title={t("webAccess.settings.certificate")}
        detail={
          draft.tlsMode === "custom"
            ? t("webAccess.settings.certificateCustomDetail")
            : t("webAccess.settings.certificateSelfSignedDetail")
        }
      >
        <Select
          value={draft.tlsMode}
          disabled={busy}
          aria-label={t("webAccess.settings.certificate")}
          onChange={(event) => update({ tlsMode: event.target.value === "custom" ? "custom" : "self-signed" })}
        >
          <option value="self-signed">{t("webAccess.settings.certificateSelfSigned")}</option>
          <option value="custom">{t("webAccess.settings.certificateCustom")}</option>
        </Select>
      </SettingsRow>

      {draft.tlsMode === "custom" ? (
        <>
          <SettingsRow title={t("webAccess.settings.certPath")}>
            <Input
              value={draft.certPath}
              disabled={busy}
              aria-label={t("webAccess.settings.certPath")}
              onChange={(event) => update({ certPath: event.target.value })}
            />
          </SettingsRow>
          <SettingsRow title={t("webAccess.settings.keyPath")}>
            <Input
              value={draft.keyPath}
              disabled={busy}
              aria-label={t("webAccess.settings.keyPath")}
              onChange={(event) => update({ keyPath: event.target.value })}
            />
          </SettingsRow>
        </>
      ) : null}

      {status.tls.fingerprint256 ? (
        <SettingsRow title={t("webAccess.settings.fingerprint")} detail={status.tls.fingerprint256}>
          {null}
        </SettingsRow>
      ) : null}

      <SettingsRow
        title={t("webAccess.settings.sessions")}
        detail={t("webAccess.settings.sessionsDetail", {
          sessions: status.activeSessions,
          clients: status.connectedClients,
        })}
      >
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || status.activeSessions === 0}
          onClick={() => void revoke()}
        >
          {t("webAccess.settings.revoke")}
        </Button>
      </SettingsRow>

      {notice ? (
        <p className="settings-row-detail" role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </p>
      ) : null}

      <SettingsRow title={t("webAccess.settings.changes")}>
        <>
          {dirty ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={discard}>
              {t("webAccess.settings.discard")}
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            disabled={busy || (!dirty && status.state !== "error")}
            onClick={() => void save()}
          >
            {t("webAccess.settings.save")}
          </Button>
        </>
      </SettingsRow>
    </SettingsCard>
  );
}
