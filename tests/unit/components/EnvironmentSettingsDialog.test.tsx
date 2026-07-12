import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useConfigStore } from "@/stores/configStore";
import { useClaudeStore } from "@/stores/claudeStore";
import type { Environment } from "@/types";

let mockSection = "agent";
const mockUpdateEnvironmentAgentSettings = mock(async (
  environmentId: string,
  defaultAgent: string | null,
  claudeMode: string | null,
  claudeNativeBackend: string | null,
  opencodeMode: string | null,
  codexMode: string | null,
) => ({
  ...makeEnvironment(),
  id: environmentId,
  defaultAgent: defaultAgent ?? undefined,
  claudeMode: claudeMode ?? undefined,
  claudeNativeBackend: claudeNativeBackend ?? undefined,
  opencodeMode: opencodeMode ?? undefined,
  codexMode: codexMode ?? undefined,
}));
const mockToastSuccess = mock(() => {});
const mockToastError = mock(() => {});
const actualBackend = await import("../../../apps/web/src/lib/backend");

mock.module("@/lib/backend", () => ({
  ...actualBackend,
  updateEnvironmentAgentSettings: mockUpdateEnvironmentAgentSettings,
  renameEnvironment: mock(async (_id: string, name: string) => ({ ...makeEnvironment(), name })),
  updateEnvironmentAllowedDomains: mock(async () => makeEnvironment()),
  updatePortMappings: mock(async () => makeEnvironment()),
  syncEnvironmentStatus: mock(async () => makeEnvironment()),
  testDomainResolution: mock(async () => []),
}));

mock.module("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

mock.module("@/components/settings/FullscreenSettingsLayout", () => ({
  FullscreenSettingsLayout: ({
    open,
    children,
    footer,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    menuItems: unknown[];
    children: (section: string) => React.ReactNode;
    footer?: React.ReactNode;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="settings-layout">
        <div data-testid="settings-content">{children(mockSection)}</div>
        {footer && <div data-testid="settings-footer">{footer}</div>}
      </div>
    );
  },
}));

const { EnvironmentSettingsDialog } = await import("../../../apps/web/src/components/environments/EnvironmentSettingsDialog");

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "test-env",
    branch: "main",
    containerId: "container-1",
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "full",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

describe("EnvironmentSettingsDialog", () => {
  beforeEach(() => {
    cleanup();
    mockSection = "agent";
    mockUpdateEnvironmentAgentSettings.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();

    useConfigStore.setState({
      config: {
        version: "1.0",
        global: {
          containerResources: { cpuCores: 2, memoryGb: 4 },
          envFilePatterns: [],
          allowedDomains: [],
          defaultAgent: "claude",
          opencodeModel: "opencode/grok-code",
          codexModel: "gpt-5.3-codex",
          codexReasoningEffort: "medium",
          opencodeMode: "terminal",
          claudeMode: "terminal",
          claudeNativeBackend: "sdk",
          codexMode: "native",
          terminalAppearance: {
            fontFamily: "Fira Code",
            fontSize: 14,
            backgroundColor: "#000000",
          },
          terminalScrollback: 5000,
        },
        repositories: {},
      },
      isLoading: false,
      error: null,
    });

    useClaudeStore.setState({
      sessions: new Map(),
      sessionInitData: new Map(),
      serverStatuses: new Map(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("saves a codex mode override", async () => {
    const onUpdate = mock(() => {});

    render(
      <EnvironmentSettingsDialog
        open={true}
        onOpenChange={() => {}}
        environment={makeEnvironment()}
        onUpdate={onUpdate}
      />
    );

    const codexSection = screen.getByText("Codex Mode").parentElement;
    if (!codexSection) {
      throw new Error("Expected Codex Mode section");
    }

    fireEvent.click(within(codexSection).getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateEnvironmentAgentSettings).toHaveBeenCalledWith(
        "env-1",
        null,
        null,
        null,
        null,
        "terminal",
      );
    });

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        codexMode: "terminal",
      })
    );
  });
});
