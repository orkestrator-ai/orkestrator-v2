import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  CreateEnvironmentFlowDialog,
  resolveEnvironmentAgentSettings,
  resolveEnvironmentCreateRequest,
} from "@/components/environments/CreateEnvironmentFlowDialog";
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

describe("CreateEnvironmentFlowDialog", () => {
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
