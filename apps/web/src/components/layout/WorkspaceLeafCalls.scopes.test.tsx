/**
 * Every workspace call goes to the workspace's node (plan item 4007).
 *
 * For a representative component of each workspace area, rendered in a leaf
 * node's scope next to the window's command scope (as an in-tree leaf's
 * workspace is), every command reaches the leaf's client and none reaches
 * the command node: neither the window's command scope's client nor the
 * app's command path (`@/lib/native/backend` `invoke`, which every
 * `@/lib/backend` named export ends in). A store hook outside the leaf's
 * provider would throw (plan item 3018), so no read can fall back either.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { MailboxDescriptor } from "@orkestrator/protocol/agent-mail";
import { invoke } from "@/lib/native/backend";
import { claudeTmuxClientFor } from "@/lib/claude-tmux-scope";
import { requestGraphRunView, onGraphRunViewRequested } from "@/lib/graph-run-navigation";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { NodeScopeProvider, WindowScopeProvider } from "@/lib/node-scope/providers";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import { UserCommandCard } from "@/components/chat/UserCommandCard";
import { ContainerLogViewer } from "@/components/environments/ContainerLogViewer";
import { PreviewFrameworkHints } from "@/components/browser/PreviewFrameworkHints";
import { DesignEnvironmentDeletionNotice } from "@/components/design/DesignEnvironmentDeletionNotice";
import { ResumeTmuxSessionDialog } from "@/components/claude/ResumeTmuxSessionDialog";
import { MailboxDeliverySettings } from "@/components/agent-mail/MailboxDeliverySettings";
import { useTicketSyncStatus } from "@/components/kanban/TicketSyncStrip";
import { usePullRequest } from "@/hooks/usePullRequest";
import { useFileSave } from "@/hooks/useFileSave";
import { resetCapabilities } from "@/lib/design-client";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const LEAF = "bk_leaf-node" as BackendId;

let windowScope: WindowScope;
let commandClient: FakeNodeClient;
let leafClient: FakeNodeClient;
let leafScope: NodeScope;

/** A leaf client answering `responses`; anything else rejects, as an unknown command would. */
function openLeaf(responses: Record<string, unknown>): void {
  leafClient = new FakeNodeClient({ nodeId: LEAF, invoke: responses });
  leafScope = windowScope.open({ role: "leaf", client: leafClient });
}

function renderInLeaf(ui: ReactNode) {
  return renderInNodeScope(<>{ui}</>, {
    windowScope,
    client: leafClient,
    role: "leaf",
  });
}

function leafHook<T>(hook: () => T) {
  return renderHook(hook, {
    wrapper: ({ children }) => (
      <WindowScopeProvider windowScope={windowScope}>
        <NodeScopeProvider scope={leafScope}>{children}</NodeScopeProvider>
      </WindowScopeProvider>
    ),
  });
}

/** The commands the leaf received, in order. */
const leafCommands = () => leafClient.invocations.map((call) => call.command);

/** Nothing reached the command node, by either path. */
function expectNothingOnTheCommandNode(): void {
  expect(commandClient.invocations.map((call) => call.command)).toEqual([]);
  expect(invokeMock.mock.calls.map((call) => call[0])).toEqual([]);
}

beforeEach(() => {
  invokeMock.mockClear();
  resetCapabilities();
  windowScope = new WindowScope();
  commandClient = new FakeNodeClient();
  windowScope.open({ role: "command", client: commandClient });
});

afterEach(() => {
  cleanupNodeScopes();
  windowScope.dispose();
});

describe("a leaf's workspace calls the leaf (plan item 4007)", () => {
  test("agent tab: cancelling a user command goes to the leaf", async () => {
    openLeaf({ cancel_user_command: null });
    renderInLeaf(
      <UserCommandCard
        command={
          {
            id: "cmd-1",
            environmentId: "env-1",
            command: "bun test",
            target: "worktree",
            cwd: "/repo",
            status: "running",
            output: "",
          } as never
        }
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    await waitFor(() => expect(leafCommands()).toContain("cancel_user_command"));
    expectNothingOnTheCommandNode();
  });

  test("terminal: container logs are read from the leaf", async () => {
    openLeaf({
      open_container_logs: { subscriptionId: "sub-1", sources: [] },
      read_container_logs: { records: [], cursor: null },
      close_container_logs: null,
    });
    renderInLeaf(<ContainerLogViewer containerId="container-1" />);
    await waitFor(() => expect(leafCommands()).toContain("open_container_logs"));
    expectNothingOnTheCommandNode();
  });

  test("files: saving a file writes it on the leaf", async () => {
    openLeaf({ write_local_file: "/repo/a.txt" });
    const { result } = leafHook(() =>
      useFileSave({
        tabId: "tab-1",
        filePath: "a.txt",
        worktreePath: "/repo",
        isLocalEnvironment: true,
      }),
    );
    await act(async () => {
      await result.current.saveFile("hello");
    });
    expect(leafCommands()).toContain("write_local_file");
    expectNothingOnTheCommandNode();
  });

  test("previews: a service's public origin is read from the leaf", async () => {
    openLeaf({ get_preview_public_origin: { origin: "https://app.leaf.example" } });
    renderInLeaf(<PreviewFrameworkHints serviceId="svc-1" applicationPort={3000} />);
    await waitFor(() => expect(leafCommands()).toContain("get_preview_public_origin"));
    expectNothingOnTheCommandNode();
  });

  test("design: the canvas library is read from the leaf", async () => {
    openLeaf({
      design_capabilities: { ok: true, value: { library: true } },
      design_library: { ok: true, value: { entries: [], total: 0 } },
    });
    renderInLeaf(<DesignEnvironmentDeletionNotice environmentId="env-1" open />);
    await waitFor(() => expect(leafCommands()).toContain("design_capabilities"));
    expectNothingOnTheCommandNode();
  });

  test("tmux: the resume picker lists the leaf's sessions, and events are the leaf's", async () => {
    openLeaf({ claude_tmux_list_previous_sessions: [] });
    renderInLeaf(
      <ResumeTmuxSessionDialog
        open
        onOpenChange={() => {}}
        environmentId="env-1"
        onResume={() => {}}
      />,
    );
    await waitFor(() => expect(leafCommands()).toContain("claude_tmux_list_previous_sessions"));

    const seen: string[] = [];
    const unlisten = await claudeTmuxClientFor(leafScope).subscribe((event) =>
      seen.push(event.tab_id),
    );
    try {
      leafClient.emit("claude-tmux:event", {
        kind: "stopped",
        tab_id: "leaf-tab",
        environment_id: "env-1",
      });
      commandClient.emit("claude-tmux:event", {
        kind: "stopped",
        tab_id: "command-tab",
        environment_id: "env-1",
      });
      expect(seen).toEqual(["leaf-tab"]);
    } finally {
      unlisten();
    }
    expectNothingOnTheCommandNode();
  });

  test("mail: muting a mailbox goes to the leaf", async () => {
    const mailbox = {
      environmentId: "env-1",
      tabId: "tab-1",
      address: "env-1/tab-1",
      injectPolicy: "idle",
      injectOverride: null,
      mutedInbound: false,
      mutedOutbound: false,
      capabilities: { canInject: true },
    } as unknown as MailboxDescriptor;
    openLeaf({ mute_agent_mail: null, get_agent_mail_mailbox: null });
    renderInLeaf(<MailboxDeliverySettings mailbox={mailbox} />);
    fireEvent.click(screen.getByRole("button", { name: "Mute inbound" }));
    await waitFor(() => expect(leafCommands()).toContain("mute_agent_mail"));
    expectNothingOnTheCommandNode();
  });

  test("Kanban: the board's ticket sync status is read from the leaf", async () => {
    openLeaf({ get_ticket_sync_status: null });
    leafHook(() => useTicketSyncStatus("project-1", true));
    await waitFor(() => expect(leafCommands()).toContain("get_ticket_sync_status"));
    expectNothingOnTheCommandNode();
  });

  test("PRs: resetting an environment's pull request clears it on the leaf", async () => {
    openLeaf({ clear_environment_pr: null });
    const { result } = leafHook(() => usePullRequest({ environmentId: "env-1" }));
    await act(async () => {
      await result.current.resetPR();
    });
    expect(leafCommands()).toContain("clear_environment_pr");
    expectNothingOnTheCommandNode();
  });

  test("graph runs: a run targeted in the leaf opens in the leaf's pane only", () => {
    openLeaf({});
    const commandOpened: string[] = [];
    const leafOpened: string[] = [];
    const offCommand = onGraphRunViewRequested((request) => {
      commandOpened.push(request.runId);
      return true;
    }, windowScope.commandScope());
    const offLeaf = onGraphRunViewRequested((request) => {
      leafOpened.push(request.runId);
      return true;
    }, leafScope);
    try {
      requestGraphRunView(
        { runId: "run-1", projectId: "p1", environmentId: "env-1", mock: false },
        leafScope,
      );
      expect(leafOpened).toEqual(["run-1"]);
      expect(commandOpened).toEqual([]);
    } finally {
      offCommand();
      offLeaf();
    }
  });
});
