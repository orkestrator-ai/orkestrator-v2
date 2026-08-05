export {
  mergePersistedPaneLayouts,
  type PaneLayoutMergeOptions,
  type PaneLayoutSelectionIntent,
} from "@orkestrator/protocol/pane-layout-merge";

import { isPaneNode as isProtocolPaneNode } from "@orkestrator/protocol/pane-layout-merge";
import type { PaneNode } from "@/types/paneLayout";

export function isPaneNode(value: unknown): value is PaneNode {
  return isProtocolPaneNode(value);
}
