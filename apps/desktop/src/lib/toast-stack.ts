import type { ToastItem } from "../stores/app-state";

/** Most toasts visible at once. */
export const TOAST_STACK_LIMIT = 4;

/** Two toasts announce the same thing, so the newer one replaces the older. */
function sameNotice(a: ToastItem, b: ToastItem): boolean {
  if (a.inputRequest || b.inputRequest) {
    return (
      a.inputRequest === b.inputRequest && a.sessionId === b.sessionId
    );
  }
  return (
    a.message === b.message &&
    a.variant === b.variant &&
    a.sessionId === b.sessionId
  );
}

/**
 * Add `next` to the visible stack, newest last.
 *
 * A repeat replaces its earlier card: the same message, variant, and target
 * conversation, or for an input reminder the same conversation and request
 * kind. Past the limit the oldest ordinary toast leaves first. Input reminders
 * stay until their request settles or the user acts on them, so one is
 * dropped only when every other visible toast is also a reminder. The newest
 * toast is always shown.
 */
export function stackToast(
  toasts: readonly ToastItem[],
  next: ToastItem,
): ToastItem[] {
  const stack = [...toasts.filter((item) => !sameNotice(item, next)), next];
  while (stack.length > TOAST_STACK_LIMIT) {
    const ordinary = stack.findIndex(
      (item) => item !== next && !item.inputRequest,
    );
    stack.splice(ordinary >= 0 ? ordinary : 0, 1);
  }
  return stack;
}
