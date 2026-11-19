import { useEffect, useRef, type ReactNode } from "react";
import { useNodeScope } from "@/lib/node-scope/providers";
import { useScopedStore } from "@/lib/node-scope/scoped-store";
import { interactionFocusStore } from "@/lib/native-interaction-navigation";

/** Reveals a linked card when the authoritative transcript or composer renders it. */
export function NativeInteractionAnchor({
  environmentId,
  tabId,
  interactionId,
  active,
  children,
}: {
  environmentId: string;
  tabId: string;
  interactionId: string;
  active: boolean;
  children: ReactNode;
}) {
  const scope = useNodeScope();
  const ref = useRef<HTMLDivElement>(null);
  const target = useScopedStore(interactionFocusStore, (state) => {
    const current = state.target;
    return current?.environmentId === environmentId &&
      current.tabId === tabId &&
      current.interactionId === interactionId
      ? current
      : null;
  });

  useEffect(() => {
    if (!active || !target) return;
    const store = scope.store(interactionFocusStore);
    const frame = requestAnimationFrame(() => {
      const card = ref.current;
      if (!card || store.getState().target !== target) return;
      store.setState({ target: null });
      if (target.expiresAt < Date.now()) return;
      card.scrollIntoView({ block: "center", inline: "nearest" });
      card.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, scope, target]);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-interaction-id={interactionId}
      className="rounded-md focus:focus-hairline-frame"
    >
      {children}
    </div>
  );
}
