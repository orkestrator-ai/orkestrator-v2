/**
 * The checkout-turn hook reads the environment store only for the project's
 * home environments, so a write to any other environment renders nothing.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Profiler } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { CoordinatorWorkspace } from "@orkestrator/protocol/coordinator";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";
import type { Environment } from "@/types";
import * as realBackend from "@/lib/backend";
import { PROJECT_HOME_TURN_LABEL } from "@/lib/coordinator-active-turn";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { environmentStore } from "@/stores/environmentStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";

const backendSnapshot = { ...realBackend };
// An older backend: only the projections answer.
mock.module("@/lib/backend", () => ({
  ...backendSnapshot,
  getCoordinatorCheckoutTurn: async () => {
    throw new Error("Unknown backend command: get_coordinator_checkout_turn");
  },
}));

import { useCoordinatorActiveTurn } from "./useCoordinatorActiveTurn";
import { appCommandStore } from "@/test/app-command-store";

const workspace = {
  version: 1,
  id: "coordinator-1",
  projectId: "project-1",
  conversations: [],
} as unknown as CoordinatorWorkspace;
const NO_CONVERSATIONS: ReadonlySet<string> = new Set();

/** Commits under the probe, which renders nothing but the hook. */
let renders = 0;
function Probe() {
  const label = useCoordinatorActiveTurn("project-1", workspace, NO_CONVERSATIONS);
  return <output aria-label="Active turn">{label ?? "none"}</output>;
}

const home = { id: "home-env", projectId: "project-1", name: "Home" } as Environment;
const other = { id: "other-env", projectId: "project-2", name: "Other" } as Environment;

describe("useCoordinatorActiveTurn", () => {
  const previousEnvironments = appCommandStore(environmentStore).getState().environments;
  beforeEach(() => {
    renders = 0;
    appCommandStore(nativeAgentProjectionStore).getState().reset();
    appCommandStore(environmentStore).setState({ environments: [home, other] });
    appCommandStore(nativeAgentProjectionStore)
      .getState()
      .setProjection("home-env:home-tab", {
        environmentId: "home-env",
        turn: { phase: "running" },
        messages: [],
        interactions: [],
      } as unknown as NativeAgentSessionProjection);
  });
  afterEach(() => {
    cleanup();
    resetReadCoordinatorForTests();
    appCommandStore(nativeAgentProjectionStore).getState().reset();
    appCommandStore(environmentStore).setState({ environments: previousEnvironments });
  });
  afterAll(() => {
    mock.module("@/lib/backend", () => backendSnapshot);
  });

  test("a write to another environment renders nothing; a new project home is followed", async () => {
    render(
      <Profiler id="probe" onRender={() => (renders += 1)}>
        <Probe />
      </Profiler>,
    );
    const output = screen.getByRole("status", { name: "Active turn" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(output.textContent).toBe("none");
    const settled = renders;

    for (const status of ["stopped", "running", "stopped"]) {
      act(() =>
        appCommandStore(environmentStore).setState((state) => ({
          environments: state.environments.map((item) =>
            item.id === other.id ? ({ ...item, status } as Environment) : item,
          ),
        })),
      );
    }
    expect(renders).toBe(settled);

    act(() =>
      appCommandStore(environmentStore).setState((state) => ({
        environments: state.environments.map((item) =>
          item.id === home.id ? { ...item, projectHome: true } : item,
        ),
      })),
    );
    expect(output.textContent).toBe(PROJECT_HOME_TURN_LABEL);
  });
});
