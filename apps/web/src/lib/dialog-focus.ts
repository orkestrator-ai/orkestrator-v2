import { useMemo, useRef } from "react";

/**
 * Return focus to the control that opened a controlled Radix dialog.
 *
 * Radix's modal `DialogContent` returns focus only to a `DialogTrigger`; a
 * dialog opened from an ordinary toolbar button (open state held by the
 * block) would otherwise leave focus on `<body>` when it closes. Spread the
 * returned handlers onto `DialogContent`: the element focused when the dialog
 * opened is remembered and focused again on close, if it is still mounted.
 */
export function useDialogFocusReturn(): {
  onOpenAutoFocus: (event: Event) => void;
  onCloseAutoFocus: (event: Event) => void;
} {
  const opener = useRef<HTMLElement | null>(null);
  return useMemo(
    () => ({
      onOpenAutoFocus: () => {
        // Runs before Radix moves focus into the dialog.
        const active = typeof document === "undefined" ? null : document.activeElement;
        opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      },
      onCloseAutoFocus: (event: Event) => {
        const target = opener.current;
        opener.current = null;
        if (!target?.isConnected) return;
        event.preventDefault();
        target.focus();
      },
    }),
    [],
  );
}
