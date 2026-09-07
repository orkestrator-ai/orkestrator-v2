import { describe, expect, test } from "bun:test";
import {
  COORDINATOR_CONTEXT_CLOSE_TAG,
  COORDINATOR_CONTEXT_OPEN_TAG,
  coordinatorConversationIdFromRuntimeId,
  coordinatorIdFromRuntimeId,
  coordinatorRuntimeId,
  isCoordinatorWorkspace,
  stripCoordinatorContext,
} from "./coordinator.js";

describe("coordinator runtime identities", () => {
  test("keeps workspace and conversation identity explicit", () => {
    const runtime = coordinatorRuntimeId("workspace-id", "conversation-id");
    expect(runtime).toBe("coordinator:workspace-id:conversation-id");
    expect(coordinatorIdFromRuntimeId(runtime)).toBe("workspace-id");
    expect(coordinatorConversationIdFromRuntimeId(runtime)).toBe("conversation-id");
  });

  test("rejects ambiguous identity separators", () => {
    expect(() => coordinatorRuntimeId("workspace:other", "conversation")).toThrow();
    expect(() => coordinatorRuntimeId("workspace", "conversation:other")).toThrow();
  });

  test("validates a persisted repository-context acknowledgement", () => {
    const workspace = {
      version: 1,
      id: "workspace-id",
      projectId: "project-id",
      executionPolicy: "coordinator-read-only",
      lifecycleState: "ready",
      conversations: [
        {
          id: "conversation-id",
          tabId: "tab-id",
          logicalSessionKey: "session-key",
          agent: "codex",
          title: "Coordinator",
          createdAt: new Date(0).toISOString(),
          mailboxIncarnationId: "incarnation-id",
          repositoryContextRevisionAcknowledged: 2,
        },
      ],
      selectedConversationId: "conversation-id",
      repositoryContextRevision: 2,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    expect(isCoordinatorWorkspace(workspace)).toBe(true);
    expect(
      isCoordinatorWorkspace({
        ...workspace,
        conversations: [
          { ...workspace.conversations[0], repositoryContextRevisionAcknowledged: -1 },
        ],
      }),
    ).toBe(false);
  });
});

describe("coordinator context stripping", () => {
  const preamble = [
    COORDINATOR_CONTEXT_OPEN_TAG,
    "Project: project-id",
    "Coordinator: coordinator-id",
    "Role: read-only coordinator.",
    COORDINATOR_CONTEXT_CLOSE_TAG,
  ].join("\n");

  test("removes the injected preamble and leaves the user's prompt", () => {
    expect(stripCoordinatorContext(`${preamble}\n\nMove the dropdown`)).toBe("Move the dropdown");
  });

  test("leaves an ordinary prompt untouched", () => {
    expect(stripCoordinatorContext("Move the dropdown")).toBe("Move the dropdown");
  });

  test("never truncates a prompt whose block is unterminated or not leading", () => {
    const unterminated = `${COORDINATOR_CONTEXT_OPEN_TAG}\nProject: project-id`;
    expect(stripCoordinatorContext(unterminated)).toBe(unterminated);

    const quoted = `Why does this render?\n${preamble}`;
    expect(stripCoordinatorContext(quoted)).toBe(quoted);
  });
});
