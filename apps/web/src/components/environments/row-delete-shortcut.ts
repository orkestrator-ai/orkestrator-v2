/**
 * ⌘⌫ / Ctrl+Backspace asks to delete an environment row, either while the
 * row has keyboard focus or straight after it was clicked.
 *
 * Clicking a row opens its environment, whose terminal or composer then takes
 * focus, so a key handler on the row alone would never see the chord. A click
 * therefore arms the shortcut at the window, in the capture phase so the
 * focused terminal or composer never receives it, until the user does
 * anything else: presses another key, presses a pointer, or leaves the window.
 * Arming expires after 1.5 seconds so a later editing chord keeps its meaning.
 */

export interface DeleteChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Backspace or Delete with ⌘ or Ctrl, and nothing else. Either modifier is
 * accepted on every platform, as with ⌘K, because a desktop shell may keep
 * the Super key for itself.
 */
export function isDeleteRowChord(event: DeleteChordEvent): boolean {
  return (
    (event.key === "Backspace" || event.key === "Delete") &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

export const DELETE_ROW_KEYSHORTCUTS =
  "Meta+Backspace Control+Backspace Meta+Delete Control+Delete";

/** Keys pressed on the way to the chord; they leave the shortcut armed. */
const MODIFIER_KEYS = new Set([
  "Meta",
  "Control",
  "Shift",
  "Alt",
  "AltGraph",
  "OS",
  "Super",
  "Hyper",
  "CapsLock",
]);

export const ROW_DELETE_ARM_MS = 1500;

/** At most one row is armed: arming another disarms it. */
let disarmCurrent: (() => void) | null = null;

/**
 * Arms the shortcut for the row just clicked. `onDelete` runs at most once,
 * on the next chord, unless something else happens first. Returns the disarm
 * function, which the row calls when it unmounts or can no longer delete.
 */
export function armRowDeleteShortcut(onDelete: () => void, target: Window = window): () => void {
  disarmCurrent?.();
  const deadline = Date.now() + ROW_DELETE_ARM_MS;
  let expiry: ReturnType<Window["setTimeout"]> | undefined;
  const disarm = () => {
    target.clearTimeout(expiry);
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("pointerdown", disarm, true);
    target.removeEventListener("blur", disarm);
    if (disarmCurrent === disarm) disarmCurrent = null;
  };
  function onKeyDown(event: KeyboardEvent) {
    // Check the deadline too: a delayed timer must not extend input interception.
    if (Date.now() >= deadline) {
      disarm();
      return;
    }
    if (MODIFIER_KEYS.has(event.key)) return;
    disarm();
    if (!isDeleteRowChord(event) || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    onDelete();
  }
  target.addEventListener("keydown", onKeyDown, true);
  // Pressing anywhere, the row included, ends this arming; a click on a row arms it again.
  target.addEventListener("pointerdown", disarm, true);
  target.addEventListener("blur", disarm);
  expiry = target.setTimeout(disarm, ROW_DELETE_ARM_MS);
  disarmCurrent = disarm;
  return disarm;
}
