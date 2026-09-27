import { describe, expect, test } from "bun:test";
import type { PaneNode, PersistedPaneLayoutInput, TabInfo } from "@/types/paneLayout";
import { PANE_LAYOUT_VERSION } from "@/types/paneLayout";
import { isPaneNode, mergePersistedPaneLayouts } from "./pane-layout-merge";

function input(tab: TabInfo): PersistedPaneLayoutInput {
  return {
    version: PANE_LAYOUT_VERSION,
    containerId: null,
    activePaneId: "default",
    root: { kind: "leaf", id: "default", tabs: [tab], activeTabId: tab.id },
  };
}

describe("renderer pane-layout merge adapter", () => {
  test("merges renderer-owned native tab metadata through the shared protocol implementation", () => {
    const base: TabInfo = {
      id: "native",
      type: "agent-native",
      displayTitle: "Original",
      initialAgentModel: "gpt-5.6-sol",
      nativeAgentData: {
        environmentId: "env-1",
        containerId: "container-1",
        sessionId: "session-old",
      },
    };
    const { initialAgentModel: _removed, ...local } = base;
    const remote: TabInfo = {
      ...base,
      displayTitle: "Remote title",
      nativeAgentData: { ...base.nativeAgentData!, sessionId: "session-new" },
    };

    const merged = mergePersistedPaneLayouts(input(base), input(local), input(remote));
    expect(merged.root).toMatchObject({
      kind: "leaf",
      tabs: [
        {
          id: "native",
          type: "agent-native",
          displayTitle: "Remote title",
          nativeAgentData: {
            environmentId: "env-1",
            containerId: "container-1",
            sessionId: "session-new",
          },
        },
      ],
    });
  });

  test("narrows representative renderer nodes with the shared validator", () => {
    const valid: PaneNode = {
      kind: "leaf",
      id: "default",
      tabs: [{ id: "terminal", type: "plain", displayTitle: "Terminal" }],
      activeTabId: "terminal",
    };
    expect(isPaneNode(valid)).toBe(true);
    expect(isPaneNode({ ...valid, tabs: [{ id: "terminal" }] })).toBe(false);
  });
});
