import { afterEach, expect, test } from "bun:test";
import { act, fireEvent, screen } from "@testing-library/react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { environmentStore } from "@/stores/environmentStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";
import { LaunchSetupStatus } from "./LaunchSetupStatus";

afterEach(cleanupNodeScopes);

test("opens the scoped setup log and retries a failed skip after confirmation", async () => {
  const environment: Environment = {
    id: "env-setup",
    projectId: "project-1",
    name: "Fixture",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    setupPhase: "running",
  };
  const client = new FakeNodeClient({
    invoke: {
      override_environment_setup: () => {
        throw new Error("Setup override unavailable");
      },
    },
  });
  const { scope } = renderInNodeScope(
    <LaunchSetupStatus environmentId={environment.id} setupPhase="running" />,
    { client },
  );
  const environments = scope.store(environmentStore);
  const layouts = scope.store(paneLayoutStore);
  act(() => {
    environments.setState({ environments: [environment] });
    layouts.setState({
      environments: new Map([
        [
          environment.id,
          {
            containerId: null,
            activePaneId: "pane",
            root: {
              kind: "leaf",
              id: "pane",
              activeTabId: "startup-agent",
              tabs: [
                { id: "startup-agent", type: "agent-native" },
                { id: "setup", type: "plain", isSetupTab: true },
              ],
            },
          },
        ],
      ]),
    });
  });
  fireEvent.click(await screen.findByRole("button", { name: "View setup log" }));
  expect(layouts.getState().environments.get(environment.id)?.root).toMatchObject({
    activeTabId: "setup",
  });

  fireEvent.click(screen.getByRole("button", { name: "Skip setup wait" }));
  expect(client.calls("override_environment_setup")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("button", { name: "Skip anyway" }) === null).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Skip setup wait" }));
  fireEvent.click(screen.getByRole("button", { name: "Skip anyway" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Setup override unavailable");
  expect(environments.getState().getEnvironmentById(environment.id)?.setupPhase).toBe("running");

  client.respond("override_environment_setup", {
    ...environment,
    setupPhase: "ready",
    setupOverride: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Skip anyway" }));
  expect(await screen.findByRole("button", { name: "Skip setup wait" })).toBeTruthy();
  expect(screen.queryByRole("alert") === null).toBe(true);
  expect(client.calls("override_environment_setup").map(({ args }) => args)).toEqual([
    { environmentId: environment.id },
    { environmentId: environment.id },
  ]);
  expect(environments.getState().getEnvironmentById(environment.id)?.setupPhase).toBe("ready");
});
