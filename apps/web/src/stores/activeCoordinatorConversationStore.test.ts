import { afterEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { getNativeAgentData } from "@/types/paneLayout";
import {
  coordinatorConversationTab,
  useActiveCoordinatorConversationStore,
  type ActiveCoordinatorConversation,
} from "./activeCoordinatorConversationStore";

const NODE_A = "bk_node-a" as BackendId;
const NODE_B = "bk_node-b" as BackendId;

const conversation: ActiveCoordinatorConversation = {
  nodeId: NODE_A,
  projectId: "project-1",
  tabId: "coordinator-tab",
  data: {
    platform: "claude",
    environmentId: "coordinator:workspace-1:conversation-1",
    isLocal: true,
    sessionId: "session-1",
  },
};

afterEach(() => {
  useActiveCoordinatorConversationStore.setState({ active: null });
});

describe("activeCoordinatorConversationStore", () => {
  test("reads the shown coordinator conversation as a native agent tab", () => {
    const tab = coordinatorConversationTab(
      conversation,
      { nodeId: NODE_A, projectId: "project-1" },
      "coordinator",
    );
    expect(tab?.id).toBe("coordinator-tab");
    expect(tab && getNativeAgentData(tab)).toEqual(conversation.data);
  });

  test("falls back when another project or board tab is shown", () => {
    expect(
      coordinatorConversationTab(
        conversation,
        { nodeId: NODE_A, projectId: "project-2" },
        "coordinator",
      ),
    ).toBe(null);
    expect(
      coordinatorConversationTab(
        conversation,
        { nodeId: NODE_A, projectId: "project-1" },
        "kanban",
      ),
    ).toBe(null);
    expect(
      coordinatorConversationTab(conversation, { nodeId: NODE_A, projectId: "project-1" }, "home"),
    ).toBe(null);
    expect(
      coordinatorConversationTab(null, { nodeId: NODE_A, projectId: "project-1" }, "coordinator"),
    ).toBe(null);
  });

  test("a conversation on node A is not the tab while node B's project is selected", () => {
    expect(
      coordinatorConversationTab(
        conversation,
        { nodeId: NODE_B, projectId: "project-1" },
        "coordinator",
      ),
    ).toBe(null);
  });

  test("a conversation on another node is a different entry", () => {
    const store = useActiveCoordinatorConversationStore.getState();
    store.publish(conversation);
    const onB = { ...conversation, nodeId: NODE_B };
    store.publish(onB);
    expect(useActiveCoordinatorConversationStore.getState().active).toBe(onB);
  });

  test("keeps the same entry for an unchanged conversation", () => {
    const store = useActiveCoordinatorConversationStore.getState();
    store.publish(conversation);
    const first = useActiveCoordinatorConversationStore.getState().active;
    store.publish({ ...conversation, data: { ...conversation.data } });
    expect(useActiveCoordinatorConversationStore.getState().active).toBe(first);
  });

  test("follows conversation focus, provider assignment and session creation", () => {
    const store = useActiveCoordinatorConversationStore.getState();
    store.publish(conversation);
    const sideAgent: ActiveCoordinatorConversation = {
      ...conversation,
      tabId: "side-agent-tab",
      data: {
        platform: "codex",
        environmentId: "coordinator:workspace-1:side-agent",
        isLocal: true,
      },
    };
    store.publish(sideAgent);
    // Cleanup from the previously focused conversation must not erase the new one.
    store.clear(NODE_A, conversation.projectId, conversation.tabId);
    expect(useActiveCoordinatorConversationStore.getState().active).toEqual(sideAgent);

    const attached = {
      ...sideAgent,
      data: { ...sideAgent.data, sessionId: "side-agent-session" },
    };
    store.publish(attached);
    const tab = coordinatorConversationTab(
      useActiveCoordinatorConversationStore.getState().active,
      { nodeId: NODE_A, projectId: "project-1" },
      "coordinator",
    );
    expect(tab?.id).toBe("side-agent-tab");
    expect(tab && getNativeAgentData(tab)).toEqual(attached.data);
  });

  test("clears only its own entry", () => {
    const store = useActiveCoordinatorConversationStore.getState();
    store.publish(conversation);
    store.clear(NODE_A, "project-2");
    store.clear(NODE_A, "project-1", "another-tab");
    // The same project and tab ids on another node are another page.
    store.clear(NODE_B, "project-1", "coordinator-tab");
    expect(useActiveCoordinatorConversationStore.getState().active).toEqual(conversation);
    store.clear(NODE_A, "project-1", "coordinator-tab");
    expect(useActiveCoordinatorConversationStore.getState().active).toBe(null);
  });
});
