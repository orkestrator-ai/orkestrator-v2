import { beforeEach, describe, expect, test } from "bun:test";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  resetConversationScrollTargets,
  useConversationScrollTargetStore,
} from "@/stores/conversationScrollTargetStore";
import { openConversationAtMessage } from "./conversation-navigation";

function seedLayout() {
  usePaneLayoutStore.setState({
    activeEnvironmentId: "env-1",
    environments: new Map([
      [
        "env-1",
        {
          root: {
            kind: "split",
            id: "split-1",
            direction: "horizontal",
            children: [
              {
                kind: "leaf",
                id: "pane-1",
                tabs: [{ id: "browser-1", type: "browser", browserData: { url: "" } }],
                activeTabId: "browser-1",
              },
              {
                kind: "leaf",
                id: "pane-2",
                tabs: [
                  { id: "terminal-1", type: "terminal" },
                  {
                    id: "agent-1",
                    type: "agent-native",
                    nativeAgentData: { environmentId: "env-1", platform: "claude" },
                  },
                ],
                activeTabId: "terminal-1",
              },
            ],
            sizes: [50, 50],
          },
          activePaneId: "pane-1",
          containerId: null,
        },
      ],
    ]),
  } as never);
}

function leaf(paneId: string) {
  return usePaneLayoutStore
    .getState()
    .findPaneWithTab(paneId === "pane-2" ? "agent-1" : "browser-1", "env-1");
}

describe("openConversationAtMessage", () => {
  beforeEach(() => {
    resetConversationScrollTargets();
    seedLayout();
  });

  test("activates the chat tab and parks the scroll target", () => {
    expect(openConversationAtMessage("env-1", "agent-1", { messageId: "m-1", turnId: "t-1" })).toBe(
      true,
    );

    expect(leaf("pane-2")?.activeTabId).toBe("agent-1");
    expect(usePaneLayoutStore.getState().getActivePaneId("env-1")).toBe("pane-2");
    expect(useConversationScrollTargetStore.getState().peek("env-1", "agent-1")).toMatchObject({
      messageId: "m-1",
      turnId: "t-1",
    });
  });

  test("returns false and parks nothing when the tab is not in the layout", () => {
    expect(openConversationAtMessage("env-1", "gone", { messageId: "m-1" })).toBe(false);
    expect(openConversationAtMessage("env-2", "agent-1", { messageId: "m-1" })).toBe(false);
    expect(useConversationScrollTargetStore.getState().targets.size).toBe(0);
    expect(usePaneLayoutStore.getState().getActivePaneId("env-1")).toBe("pane-1");
  });

  test("focuses the tab without a target when no id is known", () => {
    expect(openConversationAtMessage("env-1", "agent-1", {})).toBe(true);
    expect(leaf("pane-2")?.activeTabId).toBe("agent-1");
    expect(useConversationScrollTargetStore.getState().peek("env-1", "agent-1")).toBeNull();
  });
});
