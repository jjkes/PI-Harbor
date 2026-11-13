/**
 * The project's own norm instructions: what every agent working in this project
 * — the main agent and every delegate it starts — is told before it plans.
 *
 * The text lives on the app settings row keyed by the project's absolute path,
 * so it is project-scoped by construction: another project never sees it. The
 * main process appends it to the instruction chain it already loads at session
 * launch, which is where the main prompt and every subagent's guidance read it
 * from, so this editor only has to save one string.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Textarea } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";

export function ProjectNormsEditor({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const projectPath = useAppStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.projectPath,
  );
  const stored = projectPath ? (settings?.projectNorms?.[projectPath] ?? "") : "";
  const [draft, setDraft] = useState(stored);
  const [baseline, setBaseline] = useState(stored);
  const [saving, setSaving] = useState(false);

  // Reloaded settings win over an untouched draft; a draft the user already
  // edited is kept until they save it or leave the field alone.
  useEffect(() => {
    if (stored === baseline) return;
    setBaseline(stored);
    setDraft((current) => (current === baseline ? stored : current));
  }, [baseline, stored]);

  if (!projectPath) return null;

  const dirty = draft.trim() !== stored;

  const save = async () => {
    const current = useAppStore.getState().settings;
    if (!current || !projectPath) return;
    const projectNorms = { ...(current.projectNorms ?? {}) };
    const text = draft.trim();
    if (text) projectNorms[projectPath] = text;
    else delete projectNorms[projectPath];
    const updated = { ...current, projectNorms };
    setSaving(true);
    try {
      await api.setSettings(updated);
      useAppStore.setState({ settings: updated });
      setBaseline(text);
    } catch (error) {
      useAppStore.getState().showToast(
        error instanceof Error ? error.message : String(error),
        { variant: "error" },
      );
    } finally {
      setSaving(false);
    }
  };

  const label = t("team.normsLabel", { defaultValue: "Project norms" });

  return (
    <div className="team-roster-picker-norms">
    <Field
      label={label}
      hint={t("team.normsHint", {
        defaultValue:
          "Told to the main agent and every subagent it starts, in this project only.",
      })}
    >
      <Textarea
        className="team-roster-picker-norms-input"
        aria-label={label}
        placeholder={t("team.normsPlaceholder", {
          defaultValue: "Rules every agent in this project must follow",
        })}
        value={draft}
        rows={3}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={saving || !dirty}
        onClick={() => void save()}
      >
        {t("team.normsSave", { defaultValue: "Save norms" })}
      </Button>
      </Field>
    </div>
  );
}
