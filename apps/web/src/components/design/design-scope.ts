import { designApiFor, type DesignV2Api } from "@/lib/design-client";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useShimNodeScope } from "@/lib/node-scope/scoped-store-shim";
import { designStore } from "@/stores/designStore";

/**
 * The node a design surface works on (plan item 4007): the nearest node
 * scope, as `useDesignCanvas` reads it, so a canvas's tab, dialogs, library,
 * history and export all send to the one node that holds the canvas.
 */
export function useDesignScope(): NodeScope {
  return useShimNodeScope(designStore.name);
}

/** The v2 design commands of {@link useDesignScope}'s node. Stable for a scope. */
export function useDesignApi(): DesignV2Api {
  return designApiFor(useDesignScope());
}
