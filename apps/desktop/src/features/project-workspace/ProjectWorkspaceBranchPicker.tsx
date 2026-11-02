import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { IconCheck } from "../../components/icons";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { Input } from "../../components/ui";

/**
 * Searchable source-branch combobox for the create dialog (design §4.8).
 *
 * Feature-local on purpose: `components/ui.tsx` has no searchable select, and
 * one call site does not justify a new shared primitive (renderer AGENTS.md:
 * add a primitive at three or more call sites). The ARIA wiring and keyboard
 * contract follow the existing `SearchDialog` combobox.
 *
 * The option list is the shared anchored surface: the dialog body scrolls,
 * so a list drawn inside it is clipped by the scroll container, and the UI
 * design system (§6.3) asks every renderer dropdown to be a viewport-fixed
 * floating layer that never squeezes its parent. The combobox keeps the
 * focus and points at the popup with `aria-controls`, so the list may live
 * outside the dialog subtree.
 */
export function ProjectWorkspaceBranchPicker({
  id,
  branches,
  value,
  disabled = false,
  loading = false,
  invalid = false,
  describedBy,
  onChange,
}: {
  id: string;
  branches: string[];
  value: string;
  disabled?: boolean;
  loading?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onChange: (branch: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const blurTimer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return branches;
    return branches.filter((branch) => branch.toLowerCase().includes(needle));
  }, [branches, query]);

  // The active option must stay inside the current result list, otherwise
  // Enter would commit a branch the user can no longer see.
  const activeIndex = matches.length ? Math.min(active, matches.length - 1) : 0;
  const listId = `${id}-list`;
  const activeId = matches.length ? `${id}-option-${activeIndex}` : undefined;

  /* The highlighted row must stay visible in the scrolling list. */
  useEffect(() => {
    if (!open || !activeId) return;
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId, open]);

  const commit = (branch: string) => {
    onChange(branch);
    setQuery("");
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // An IME candidate window owns these keys while composing.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, Math.max(matches.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Home" && open) {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === "End" && open) {
      event.preventDefault();
      setActive(Math.max(matches.length - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      // Only intercept Enter while a list is open, so it still submits the form.
      if (!open || !matches.length) return;
      event.preventDefault();
      commit(matches[activeIndex]);
      return;
    }
    if (event.key === "Escape" && open) {
      // Closing the list is the local meaning of Esc; the dialog keeps its own.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <AnchoredMenu
      className="project-workspace-combobox"
      open={open}
      onClose={() => setOpen(false)}
      anchorRef={inputRef}
      menuClassName="project-workspace-listbox"
      id={listId}
      label={t("projectWorkspace.create.branchList")}
      role="listbox"
      // The combobox keeps the focus; the rows are reached with
      // `aria-activedescendant`, so the menu must not take it.
      initialFocus="none"
      matchAnchorWidth
      restoreFocus={false}
      trigger={() => (
        <>
          <Input
            ref={inputRef}
            id={id}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={open ? activeId : undefined}
            aria-autocomplete="list"
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            autoComplete="off"
            disabled={disabled}
            placeholder={t("projectWorkspace.create.branchPlaceholder")}
            value={open ? query : value}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => {
              if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
              setQuery("");
              setOpen(true);
            }}
            onBlur={() => {
              // Let a pointer-down on an option land before the list unmounts.
              blurTimer.current = window.setTimeout(() => setOpen(false), 120);
            }}
            onKeyDown={onKeyDown}
          />
          {loading ? (
            <span
              className="project-workspace-spinner"
              role="status"
              aria-label={t("projectWorkspace.create.branchLoading")}
            />
          ) : null}
        </>
      )}
    >
      {matches.map((branch, index) => (
        <button
          key={branch}
          id={`${id}-option-${index}`}
          type="button"
          role="option"
          aria-selected={branch === value}
          className={`project-workspace-option ${index === activeIndex ? "active" : ""}`}
          tabIndex={-1}
          onMouseEnter={() => setActive(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => commit(branch)}
        >
          <span className="project-workspace-option-name">{branch}</span>
          {branch === value ? (
            <IconCheck size={13} className="project-workspace-option-check" />
          ) : null}
        </button>
      ))}
      {!matches.length ? (
        <div className="project-workspace-option-empty" role="status">
          {branches.length
            ? t("projectWorkspace.create.branchEmpty")
            : t("projectWorkspace.create.branchNone")}
        </div>
      ) : null}
    </AnchoredMenu>
  );
}
