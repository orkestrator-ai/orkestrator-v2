import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";

interface InteractionTarget {
  environmentId: string;
  tabId: string;
  interactionId: string;
}

/** One outstanding focus intent per node, including while its panes hydrate. */
export const interactionFocusStore = defineScopedStore<{
  target: (InteractionTarget & { expiresAt: number }) | null;
}>("native-interaction-focus", () => () => ({ target: null }));

export function requestInteractionFocus(scope: NodeScope, target: InteractionTarget | null): void {
  scope.store(interactionFocusStore).setState({
    target: target ? { ...target, expiresAt: Date.now() + 30_000 } : null,
  });
}
