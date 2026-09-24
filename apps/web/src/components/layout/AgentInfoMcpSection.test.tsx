import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MCP_MANAGEMENT_CHANGED_EVENT } from "@orkestrator/protocol/mcp-management";
import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";

import { McpServersSettingsLink } from "@/components/settings/mcp-servers/McpServersSettingsLink";
import { onMcpSettingsIntent, type McpSettingsIntent } from "@/lib/mcp-settings-navigation";
import { listen as nativeListen } from "@/lib/native/events";
import { onResourceChanged } from "@/lib/resource-sync";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";

import { AgentInfoMcpSection } from "./AgentInfoMcpSection";

const listenMock = nativeListen as unknown as ReturnType<typeof mock>;

const servers: NativeAgentMcpServer[] = [
  { id: "github", name: "github", status: "connected", toolCount: 12, actions: [] },
  {
    id: "db",
    name: "db",
    status: "needs-auth",
    scope: "project",
    toolCount: 0,
    actions: ["sign-in"],
  },
  {
    id: "orkestrator",
    name: "orkestrator",
    status: "connected",
    scope: "orkestrator",
    toolCount: 9,
    actions: [],
  },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const stop of cleanups.splice(0)) stop();
});

function captureIntents(): McpSettingsIntent[] {
  const intents: McpSettingsIntent[] = [];
  cleanups.push(onMcpSettingsIntent((intent) => intents.push(intent)));
  return intents;
}

function renderSection(list: NativeAgentMcpServer[] | undefined) {
  return render(
    <AgentInfoMcpSection
      environmentId="env-1"
      provider="codex"
      sessionKey="env-1:tab-1"
      servers={list}
      busyAction={null}
      onAction={() => undefined}
    />,
  );
}

describe("AgentInfoMcpSection links into saved configuration", () => {
  test("each runtime row links to its server by name, provider and environment", () => {
    const intents = captureIntents();
    renderSection(servers);
    fireEvent.click(screen.getByRole("button", { name: /Tools 21/ }));
    const links = screen.getAllByRole("button", { name: "Saved configuration" });
    // Orkestrator's own server is not user configuration.
    expect(links.length).toBe(2);
    const dbLink = screen.getByRole("button", { name: "Saved configuration", description: "db" });
    fireEvent.click(dbLink);
    expect(intents).toEqual([{ provider: "codex", environmentId: "env-1", serverName: "db" }]);
  });

  test("the panel-level link is visible while the inventory is collapsed", () => {
    const intents = captureIntents();
    renderSection(servers);
    expect(screen.getByRole("button", { name: /Tools 21/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage saved MCP servers…" }));
    expect(intents).toEqual([{ provider: "codex", environmentId: "env-1" }]);
  });

  test("an empty runtime list still offers the link and says nothing is loaded", () => {
    const intents = captureIntents();
    renderSection([]);
    expect(screen.getByText("This session has not loaded any MCP servers.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Manage saved MCP servers…" }));
    expect(intents).toEqual([{ provider: "codex", environmentId: "env-1" }]);
  });

  test("a session that reports no inventory shows only the link, not a false empty state", () => {
    renderSection(undefined);
    expect(screen.getByRole("button", { name: "Manage saved MCP servers…" })).toBeTruthy();
    expectDomAbsent(screen.queryByText(/has not loaded any MCP servers/), "empty claim");
  });

  test("platform settings link opens that platform's servers", () => {
    const intents = captureIntents();
    render(<McpServersSettingsLink platform="pi" />);
    fireEvent.click(screen.getByRole("button", { name: "Manage Pi MCP servers" }));
    expect(intents).toEqual([{ provider: "pi" }]);
  });
});

describe("AgentInfoMcpSection refreshes after management changes", () => {
  test("a management change refetches this session's projection through resource sync", async () => {
    const changes: ResourceChange[] = [];
    cleanups.push(onResourceChanged("native-agent-session", (change) => changes.push(change)));
    listenMock.mockClear();
    renderSection(servers);
    const registration = listenMock.mock.calls.find(
      (call: unknown[]) => call[0] === MCP_MANAGEMENT_CHANGED_EVENT,
    );
    expect(registration).toBeTruthy();
    const handler = registration![1] as (event: { payload: unknown }) => void;
    await act(async () => handler({ payload: { revision: 4, targetIds: [], operationIds: [] } }));
    await waitFor(() => expect(changes.length).toBe(1));
    expect(changes[0]).toMatchObject({
      resource: "native-agent-session",
      id: "env-1",
      agent: "codex",
      logicalSessionKey: "env-1:tab-1",
    });
  });

  test("unmounting stops listening", async () => {
    const unlisten = mock(() => undefined);
    listenMock.mockClear();
    listenMock.mockImplementation(() => Promise.resolve(unlisten));
    try {
      const view = renderSection(servers);
      await act(async () => undefined);
      view.unmount();
      expect(unlisten).toHaveBeenCalledTimes(1);
    } finally {
      listenMock.mockImplementation(() => Promise.resolve(() => {}));
    }
  });
});
