import { useMemo, useRef } from "react";

/** Share the original opener across notices that overlap or replace one another. */
export function useDialogFocusReturnGroup() {
  const state = useRef<{ opener: HTMLElement | null }>({ opener: null });
  return useMemo(() => {
    const dialogs = new Set<symbol>();
    return {
      open(id: symbol, active: Element | null, allowDialogOpener: boolean) {
        if (dialogs.size === 0) {
          state.current.opener =
            active instanceof HTMLElement &&
            active !== document.body &&
            (allowDialogOpener || !active.closest('[role="alertdialog"]'))
              ? active
              : null;
        }
        dialogs.add(id);
      },
      close(id: symbol) {
        dialogs.delete(id);
        if (dialogs.size > 0) return { pending: true, target: null };
        const target = state.current.opener;
        state.current.opener = null;
        return { pending: false, target };
      },
    };
  }, []);
}

/**
 * Return focus to the control that opened a controlled Radix dialog.
 *
 * Radix's modal `DialogContent` returns focus only to a `DialogTrigger`; a
 * dialog opened from an ordinary toolbar button (open state held by the
 * block) would otherwise leave focus on `<body>` when it closes. Spread the
 * returned handlers onto `DialogContent`: the element focused when the dialog
 * opened is remembered and focused again on close, if it is still mounted.
 */
export function useDialogFocusReturn(group?: ReturnType<typeof useDialogFocusReturnGroup>): {
  onOpenAutoFocus: (event: Event) => void;
  onCloseAutoFocus: (event: Event) => void;
} {
  const localGroup = useDialogFocusReturnGroup();
  const session = group ?? localGroup;
  const id = useRef(Symbol("dialog"));
  return useMemo(
    () => ({
      onOpenAutoFocus: () => {
        // Runs before Radix moves focus into the dialog.
        const active = typeof document === "undefined" ? null : document.activeElement;
        session.open(id.current, active, group === undefined);
      },
      onCloseAutoFocus: (event: Event) => {
        const { pending, target } = session.close(id.current);
        // Never return focus behind another notice (or let Radix return it to body).
        if (pending) {
          event.preventDefault();
          return;
        }
        if (!target?.isConnected) return;
        event.preventDefault();
        target.focus();
      },
    }),
    [session, group],
  );
}
