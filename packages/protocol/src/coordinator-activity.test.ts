import { describe, expect, test } from "bun:test";
import type { AgentActivityState } from "./agent-activity.js";
import type { CoordinatorConversation, CoordinatorWorkspace } from "./coordinator.js";
import {
  coordinatorActivityByProject,
  parseCoordinatorActivitySnapshot,
} from "./coordinator-activity.js";

function conversation(
  id: string,
  overrides: Partial<CoordinatorConversation> = {},
): CoordinatorConversation {
  return {
    id,
    tabId: `tab-${id}`,
    logicalSessionKey: `session-${id}`,
    agent: "claude",
    title: id,
    createdAt: new Date(0).toISOString(),
    mailboxIncarnationId: `mailbox-${id}`,
    ...overrides,
  };
}

function workspace(
  projectId: string,
  conversations: CoordinatorConversation[],
  lifecycleState: CoordinatorWorkspace["lifecycleState"] = "ready",
): CoordinatorWorkspace {
  return {
    version: 1,
    id: `coordinator-${projectId}`,
    projectId,
    executionPolicy: "coordinator-read-only",
    lifecycleState,
    conversations,
    selectedConversationId: null,
    repositoryContextRevision: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

/** Observes each session by its logical key. */
function observing(states: Record<string, AgentActivityState | "unknown">) {
  const seen: string[] = [];
  const observe = (
    _workspace: CoordinatorWorkspace,
    session: { conversationId: string; logicalSessionKey: string },
  ) => {
    seen.push(session.conversationId);
    return states[session.logicalSessionKey] ?? "unknown";
  };
  return { observe, seen };
}

describe("coordinatorActivityByProject", () => {
  test("reports a project working while any open conversation works", () => {
    const { observe } = observing({ "session-main": "idle", "session-side": "working" });
    expect(
      coordinatorActivityByProject(
        [workspace("project-1", [conversation("main"), conversation("side")])],
        observe,
      ),
    ).toEqual({ "project-1": "working" });
  });

  test("working outranks waiting, and waiting shows when nothing works", () => {
    const { observe } = observing({
      "session-a": "waiting",
      "session-b": "working",
      "session-c": "waiting",
      "session-d": "idle",
    });
    expect(
      coordinatorActivityByProject(
        [
          workspace("project-1", [conversation("a"), conversation("b")]),
          workspace("project-2", [conversation("c"), conversation("d")]),
        ],
        observe,
      ),
    ).toEqual({ "project-1": "working", "project-2": "waiting" });
  });

  test("leaves idle and unobserved coordinators out", () => {
    const { observe } = observing({ "session-a": "idle" });
    expect(
      coordinatorActivityByProject(
        [workspace("project-1", [conversation("a")]), workspace("project-2", [conversation("b")])],
        observe,
      ),
    ).toEqual({});
  });

  test("does not observe closed or unassigned conversations", () => {
    const { observe, seen } = observing({
      "session-closed": "working",
      "session-new": "working",
    });
    const unassigned = conversation("new");
    delete unassigned.agent;
    expect(
      coordinatorActivityByProject(
        [
          workspace("project-1", [
            conversation("closed", { closedAt: new Date(0).toISOString() }),
            unassigned,
          ]),
        ],
        observe,
      ),
    ).toEqual({});
    expect(seen).toEqual([]);
  });

  test("ignores a workspace the observer does not sweep", () => {
    const { observe } = observing({ "session-a": "working" });
    expect(
      coordinatorActivityByProject(
        [
          workspace("project-1", [conversation("a")], "paused"),
          workspace("project-2", [conversation("a")], "error"),
        ],
        observe,
      ),
    ).toEqual({});
  });
});

describe("parseCoordinatorActivitySnapshot", () => {
  test("keeps working and waiting projects", () => {
    expect(parseCoordinatorActivitySnapshot({ projects: { a: "working", b: "waiting" } })).toEqual({
      projects: { a: "working", b: "waiting" },
    });
  });

  test("drops unknown states and reads malformed answers as no activity", () => {
    expect(
      parseCoordinatorActivitySnapshot({ projects: { a: "idle", b: "busy", c: 1, "": "working" } }),
    ).toEqual({ projects: {} });
    expect(parseCoordinatorActivitySnapshot(null)).toEqual({ projects: {} });
    expect(parseCoordinatorActivitySnapshot({ projects: [] })).toEqual({ projects: {} });
    expect(parseCoordinatorActivitySnapshot("working")).toEqual({ projects: {} });
  });
});
