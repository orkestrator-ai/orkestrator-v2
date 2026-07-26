import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Environment } from "@/types";

// Snapshot the real module before replacing it, and restore it afterwards, so
// other suites that need the genuine backend wrappers are unaffected.
import * as realBackend from "@/lib/backend";
const realBackendSnapshot = { ...realBackend };

const updateEnvironmentAgentSettingsMock = mock(
  async (environmentId: string, ..._rest: unknown[]) => ({ id: environmentId }) as Environment,
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  updateEnvironmentAgentSettings: updateEnvironmentAgentSettingsMock,
}));

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const {
  CreateEnvironmentFlowDialog,
  resolveEnvironmentAgentSettings,
  resolveEnvironmentCreateRequest,
} = await import("@/components/environments/CreateEnvironmentFlowDialog");
import type { ClaudeOptions } from "@/components/environments/CreateEnvironmentDialog";

const baseOptions: ClaudeOptions = {
  environmentType: "containerized",
  environmentName: "",
  launchAgent: true,
  agentType: "claude",
  claudeMode: "terminal",
  opencodeMode: "terminal",
  codexMode: "native",
  initialPrompt: "",
  initialPromptAttachments: [],
  networkAccessMode: "restricted",
  portMappings: [],
};

afterEach(cleanup);

/**
 * Drive the real create dialog to submission and return the agent-settings call
 * the flow made, so the durable launch intent is asserted end to end rather than
 * only through the pure helpers.
 */
async function submitCreateFlow(options: { turnOffLaunchAgent?: boolean } = {}) {
  const created = { id: "env-created" } as Environment;
  const startEnvironment = mock(async () => {});
  render(
    <CreateEnvironmentFlowDialog
      open
      onOpenChange={() => {}}
      projectId="project-1"
      createEnvironment={mock(async () => created)}
      updateEnvironment={() => {}}
      startEnvironment={startEnvironment}
    />,
  );

  if (options.turnOffLaunchAgent) {
    fireEvent.click(screen.getByLabelText("Launch Agent"));
  }
  fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

  await waitFor(() => expect(updateEnvironmentAgentSettingsMock).toHaveBeenCalled());
  return updateEnvironmentAgentSettingsMock.mock.calls[0]!;
}

describe("CreateEnvironmentFlowDialog", () => {
  beforeEach(() => {
    updateEnvironmentAgentSettingsMock.mockClear();
  });

  test("persists the durable launch intent when the agent will be launched", async () => {
    const call = await submitCreateFlow();
    expect(call[0]).toBe("env-created");
    expect(call[6]).toBe(true);
  });

  test("persists a cleared launch intent when the user turns the agent off", async () => {
    const call = await submitCreateFlow({ turnOffLaunchAgent: true });
    // Recording `false` explicitly is what stops an environment created with the
    // agent off from ever being treated as awaiting a launch.
    expect(call[6]).toBe(false);
  });

  test("does not submit without a selected project", () => {
    const createEnvironment = mock(async () => {
      throw new Error("must not be called");
    });
    render(
      <CreateEnvironmentFlowDialog
        open
        onOpenChange={() => {}}
        projectId={null}
        createEnvironment={createEnvironment}
        updateEnvironment={() => {}}
        startEnvironment={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Environment" }));

    expect(createEnvironment).not.toHaveBeenCalled();
    expect(screen.getByText("Create Ork (Environment)")).toBeTruthy();
  });

  test("maps optional create fields and derives naming intent only for unnamed environments", () => {
    expect(resolveEnvironmentCreateRequest({
      ...baseOptions,
      initialPrompt: "  repair stale sessions  ",
    })).toEqual({
      name: undefined,
      networkAccessMode: "restricted",
      initialPrompt: "  repair stale sessions  ",
      portMappings: undefined,
      environmentType: "containerized",
      namingPrompt: "repair stale sessions",
    });

    expect(resolveEnvironmentCreateRequest({
      ...baseOptions,
      environmentName: "Manual Name",
      initialPrompt: "Do not use this for naming",
      portMappings: [{ containerPort: 8080, hostPort: 48080, protocol: "tcp" }],
    })).toEqual(expect.objectContaining({
      name: "Manual Name",
      namingPrompt: undefined,
      portMappings: [{ containerPort: 8080, hostPort: 48080, protocol: "tcp" }],
    }));
  });

  test("maps each agent mode to its backend slot", () => {
    expect(resolveEnvironmentAgentSettings(baseOptions)).toEqual({
      defaultAgent: "claude",
      claudeMode: "terminal",
      opencodeMode: null,
      codexMode: null,
    });
    expect(resolveEnvironmentAgentSettings({
      ...baseOptions,
      agentType: "opencode",
      opencodeMode: "native",
    })).toEqual({
      defaultAgent: "opencode",
      claudeMode: null,
      opencodeMode: "native",
      codexMode: null,
    });
    expect(resolveEnvironmentAgentSettings({
      ...baseOptions,
      agentType: "codex",
      codexMode: "terminal",
    })).toEqual({
      defaultAgent: "codex",
      claudeMode: null,
      opencodeMode: null,
      codexMode: "terminal",
    });
  });
});
