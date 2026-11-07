import { beforeEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import {
  resetConversationScrollTargets,
  useConversationScrollTargetStore,
} from "@/stores/conversationScrollTargetStore";
import { openConversationAtMessage } from "./conversation-navigation";
import { appCommandStore } from "@/test/app-command-store";

const NODE = "bk_node-a" as BackendId;
const at = (environmentId: string, tabId: string) => ({ nodeId: NODE, environmentId, tabId });

function seedLayout() {
  appCommandStore(paneLayoutStore).setState({
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
  return appCommandStore(paneLayoutStore)
    .getState()
    .findPaneWithTab(paneId === "pane-2" ? "agent-1" : "browser-1", "env-1");
}

describe("openConversationAtMessage", () => {
  beforeEach(() => {
    resetConversationScrollTargets();
    seedLayout();
  });

  test("activates the chat tab and parks the scroll target", () => {
    expect(
      openConversationAtMessage(at("env-1", "agent-1"), { messageId: "m-1", turnId: "t-1" }),
    ).toBe(true);

    expect(leaf("pane-2")?.activeTabId).toBe("agent-1");
    expect(appCommandStore(paneLayoutStore).getState().getActivePaneId("env-1")).toBe("pane-2");
    expect(useConversationScrollTargetStore.getState().peek(at("env-1", "agent-1"))).toMatchObject({
      messageId: "m-1",
      turnId: "t-1",
    });
  });

  test("parks the target for the node that asked", () => {
    openConversationAtMessage(at("env-1", "agent-1"), { messageId: "m-1" });
    const other = { ...at("env-1", "agent-1"), nodeId: "bk_node-b" as BackendId };
    expect(useConversationScrollTargetStore.getState().peek(other)).toBeNull();
  });

  test("returns false and parks nothing when the tab is not in the layout", () => {
    expect(openConversationAtMessage(at("env-1", "gone"), { messageId: "m-1" })).toBe(false);
    expect(openConversationAtMessage(at("env-2", "agent-1"), { messageId: "m-1" })).toBe(false);
    expect(useConversationScrollTargetStore.getState().targets.size).toBe(0);
    expect(appCommandStore(paneLayoutStore).getState().getActivePaneId("env-1")).toBe("pane-1");
  });

  test("focuses the tab without a target when no id is known", () => {
    expect(openConversationAtMessage(at("env-1", "agent-1"), {})).toBe(true);
    expect(leaf("pane-2")?.activeTabId).toBe("agent-1");
    expect(useConversationScrollTargetStore.getState().peek(at("env-1", "agent-1"))).toBeNull();
  });
});
