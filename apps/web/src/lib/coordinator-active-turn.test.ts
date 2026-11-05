import { describe, expect, test } from "bun:test";
import {
  coordinatorRuntimeId,
  type CoordinatorConversation,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import type {
  NativeAgentSessionProjection,
  NativeAgentTurnPhase,
} from "@orkestrator/protocol/native-agent";
import { createSessionKey } from "@/lib/utils";
import {
  activeCoordinatorTurnLabel,
  PROJECT_HOME_TURN_LABEL,
  projectHomeEnvironmentIds,
} from "./coordinator-active-turn";

const conversation = (
  id: string,
  overrides: Partial<CoordinatorConversation> = {},
): CoordinatorConversation =>
  ({
    id,
    tabId: `tab-${id}`,
    title: `Title ${id}`,
    agent: "claude",
    ...overrides,
  }) as CoordinatorConversation;

const workspace = (conversations: CoordinatorConversation[]) =>
  ({ id: "coordinator-1", conversations }) as unknown as CoordinatorWorkspace;

const projection = (environmentId: string, phase: NativeAgentTurnPhase) =>
  ({ environmentId, turn: { phase } }) as NativeAgentSessionProjection;

const projectionsOf = (phases: Record<string, NativeAgentTurnPhase>) =>
  new Map(
    Object.entries(phases).map(([id, phase]) => {
      const environmentId = coordinatorRuntimeId("coordinator-1", id);
      return [createSessionKey(environmentId, `tab-${id}`), projection(environmentId, phase)];
    }),
  );

const NO_HOME = new Set<string>();

describe("activeCoordinatorTurnLabel", () => {
  test.each(["running", "blocked", "cancelling", "recovering"] as const)(
    "names a conversation %s behind the focused one",
    (phase) => {
      expect(
        activeCoordinatorTurnLabel({
          workspace: workspace([conversation("main"), conversation("side")]),
          homeEnvironmentIds: NO_HOME,
          projections: projectionsOf({ side: "idle", main: phase }),
        }),
      ).toBe("Title main");
    },
  );

  test.each(["idle", "error"] as const)("a %s turn holds nothing", (phase) => {
    expect(
      activeCoordinatorTurnLabel({
        workspace: workspace([conversation("main")]),
        homeEnvironmentIds: NO_HOME,
        projections: projectionsOf({ main: phase }),
      }),
    ).toBeNull();
  });

  test("a closed or unassigned conversation does not count", () => {
    expect(
      activeCoordinatorTurnLabel({
        workspace: workspace([
          conversation("closed", { closedAt: new Date(0).toISOString() }),
          conversation("unassigned", { agent: undefined }),
        ]),
        homeEnvironmentIds: NO_HOME,
        projections: projectionsOf({ closed: "running", unassigned: "running" }),
      }),
    ).toBeNull();
  });

  test("the project home counts, and only this project's", () => {
    const projections = new Map([["home-key", projection("home-1", "running")]]);
    expect(
      activeCoordinatorTurnLabel({
        workspace: workspace([]),
        homeEnvironmentIds: new Set(["home-1"]),
        projections,
      }),
    ).toBe(PROJECT_HOME_TURN_LABEL);
    expect(
      activeCoordinatorTurnLabel({
        workspace: workspace([]),
        homeEnvironmentIds: new Set(["home-2"]),
        projections,
      }),
    ).toBeNull();
  });

  test("a scope leaves out conversations whose projections cannot be trusted", () => {
    expect(
      activeCoordinatorTurnLabel({
        workspace: workspace([conversation("main"), conversation("side")]),
        conversationIds: new Set(["side"]),
        homeEnvironmentIds: NO_HOME,
        projections: projectionsOf({ main: "running", side: "idle" }),
      }),
    ).toBeNull();
  });
});

describe("projectHomeEnvironmentIds", () => {
  test("picks this project's home only", () => {
    expect(
      Array.from(
        projectHomeEnvironmentIds(
          [
            { id: "home-1", projectId: "project-1", projectHome: true },
            { id: "worker", projectId: "project-1" },
            { id: "home-2", projectId: "project-2", projectHome: true },
          ],
          "project-1",
        ),
      ),
    ).toEqual(["home-1"]);
  });
});
