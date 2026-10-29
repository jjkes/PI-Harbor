/**
 * Focus containment shared by Team's modal layers: the narrow-window drawer
 * and the member sheet that can open above it.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) =>
      element.getAttribute("aria-hidden") !== "true" &&
      !element.closest("[inert]"),
  );
}

/**
 * Keep a Tab press inside `root`: wrap at either end, and pull focus back in
 * when it has left the layer. Moves between inner controls stay native.
 */
export function containTabFocus(event: KeyboardEvent, root: HTMLElement): void {
  const focusables = focusableWithin(root);
  if (focusables.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && root.contains(active);
  if (!inside) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  }
}
