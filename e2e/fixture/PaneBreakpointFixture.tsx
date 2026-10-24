import { useState } from "react";
import { DndContext } from "@dnd-kit/core";
import "@xterm/xterm/css/xterm.css";
import {
  nativeAgentCapabilities,
  type NativeAgentSessionStateUpdate,
  type NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { AppShell } from "../../apps/web/src/components/layout/AppShell";
import { TooltipProvider } from "../../apps/web/src/components/ui/tooltip";
import { TerminalProvider } from "../../apps/web/src/contexts";
import { DockerAvailabilityProvider } from "../../apps/web/src/contexts/DockerAvailabilityContext";
import { PaneTree } from "../../apps/web/src/components/pane-layout/PaneTree";
import { TerminalPortalHost } from "../../apps/web/src/components/terminal/TerminalPortalHost";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import { usePaneLayoutStore } from "../../apps/web/src/stores/paneLayoutStore";
import { useTerminalPortalStore } from "../../apps/web/src/stores/terminalPortalStore";
import type { PaneSplit } from "../../apps/web/src/types/paneLayout";

const ENVIRONMENT_ID = "breakpoint-environment";
const TERMINAL_TAB_ID = "breakpoint-terminal";
const AGENT_TAB_ID = "breakpoint-agent";

const identity: NativeAgentViewIdentity = {
  backendInstanceId: "breakpoint-fixture",
  environmentId: ENVIRONMENT_ID,
  platform: "codex",
  logicalSessionKey: `env-${ENVIRONMENT_ID}:${AGENT_TAB_ID}`,
  providerSessionId: "breakpoint-session",
  sourceGeneration: "generation-1",
};

const root: PaneSplit = {
  kind: "split",
  id: "breakpoint-split",
  direction: "horizontal",
  sizes: [50, 50],
  depth: 1,
  children: [
    {
      kind: "leaf",
      id: "terminal-pane",
      tabs: [{ id: TERMINAL_TAB_ID, type: "plain", displayTitle: "Shell" }],
      activeTabId: TERMINAL_TAB_ID,
    },
    {
      kind: "leaf",
      id: "agent-pane",
      tabs: [
        {
          id: AGENT_TAB_ID,
          type: "agent-native",
          displayTitle: "Codex",
          nativeAgentData: {
            platform: "codex",
            environmentId: ENVIRONMENT_ID,
            sessionId: identity.providerSessionId,
            isLocal: true,
          },
        },
      ],
      activeTabId: AGENT_TAB_ID,
    },
  ],
};

declare global {
  interface Window {
    /** Commands the fixture backend left pending, for diagnosing a stuck pane. */
    paneBreakpointPendingCommands?: string[];
    /** Writes into the shell pane's real xterm instance. */
    writeBreakpointTerminal?: (text: string) => Promise<void>;
    /** Scrolls the shell pane's terminal so a given buffer line is at the top. */
    scrollBreakpointTerminal?: (line: number) => void;
    /** Where the shell pane's terminal is scrolled, and what its scrollback holds. */
    breakpointTerminalState?: () => {
      cols: number;
      rows: number;
      viewportY: number;
      baseY: number;
      firstLine: string;
      lastLine: string;
    } | null;
  }
}

/** Long enough to scroll in either layout; short lines, so the width does not rewrap them. */
const transcript = Array.from({ length: 60 }, (_, index) => {
  const content = `Transcript message ${index}.`;
  return {
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content,
    createdAt: "2026-10-16T00:00:00.000Z",
    parts: [{ type: "text", content }],
  };
});

function sessionSnapshot(): NativeAgentSessionStateUpdate {
  return {
    viewVersion: 1,
    status: "snapshot",
    token: "state-1",
    value: {
      identity,
      connection: "connected",
      turn: { phase: "idle" },
      interactions: [],
      composerControls: [],
      capabilities: nativeAgentCapabilities("codex"),
      notices: [],
    },
  };
}

/**
 * Answers what the native agent tab asks for and leaves the terminal's session
 * requests pending. The terminal still opens its real xterm instance; the
 * fixture writes output into it directly instead of through a PTY.
 */
function installBackend() {
  const pending: string[] = [];
  window.paneBreakpointPendingCommands = pending;
  const drafts = new Map<string, unknown>();
  useEnvironmentStore.setState({
    environments: [
      {
        id: ENVIRONMENT_ID,
        projectId: "breakpoint-project",
        name: "Breakpoint fixture",
        order: 0,
        environmentType: "local",
        status: "running",
        setupPhase: "ready",
      } as never,
    ],
  });
  usePaneLayoutStore.setState({
    activeEnvironmentId: ENVIRONMENT_ID,
    environments: new Map([
      [ENVIRONMENT_ID, { containerId: null, activePaneId: "agent-pane", root }],
    ]),
  });
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      let result: unknown;
      switch (command) {
        case "get_native_agent_sync_capabilities":
          result = {
            projectionSyncVersions: [1],
            historyPagingVersions: [1],
            progressiveViewVersions: [1],
          };
          break;
        case "adopt_native_agent_session":
          result = {};
          break;
        case "get_native_agent_session_state_update":
          result = sessionSnapshot();
          break;
        case "get_native_agent_transcript_update":
          result = {
            viewVersion: 1,
            status: "snapshot",
            token: "transcript-1",
            value: {
              identity,
              freshness: "current",
              messages: transcript,
              historyEpoch: "epoch-1",
              historyComplete: true,
            },
          };
          break;
        case "get_native_agent_discovery_update":
          result = {
            viewVersion: 1,
            status: "snapshot",
            token: "discovery-1",
            value: { identity, sections: {} },
          };
          break;
        case "get_compose_draft":
          result = drafts.get(String(args?.draftKey)) ?? null;
          break;
        case "save_compose_draft":
          result = { revision: 1, value: args?.value };
          drafts.set(String(args?.draftKey), result);
          break;
        case "delete_compose_draft":
          drafts.delete(String(args?.draftKey));
          break;
        case "get_native_agent_model_catalog":
        case "get_file_tree":
        case "get_local_file_tree":
          result = [];
          break;
        // The agent information panel names the session's account.
        case "get_native_agent_session_account":
          result = null;
          break;
        case "list_agent_accounts":
          result = { accounts: [], active: { claude: "default", codex: "default" } };
          break;
        case "get_native_agent_auth_status":
          result = { authenticated: true };
          break;
        default:
          pending.push(command);
          return new Promise<T>(() => {});
      }
      return result as T;
    },
  } as Window["orkestrator"];

  const terminal = () =>
    useTerminalPortalStore.getState().getTerminal(ENVIRONMENT_ID, TERMINAL_TAB_ID)?.terminal;
  window.writeBreakpointTerminal = (text) =>
    new Promise((resolve, reject) => {
      const instance = terminal();
      if (!instance) reject(new Error("The shell pane has no terminal yet"));
      else instance.write(text, resolve);
    });
  window.scrollBreakpointTerminal = (line) => terminal()?.scrollToLine(line);
  window.breakpointTerminalState = () => {
    const instance = terminal();
    const buffer = instance?.buffer.active;
    if (!instance || !buffer) return null;
    const line = (index: number) => buffer.getLine(index)?.translateToString(true) ?? "";
    let last = buffer.length - 1;
    while (last > 0 && line(last) === "") last -= 1;
    return {
      cols: instance.cols,
      rows: instance.rows,
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      firstLine: line(0),
      lastLine: line(last),
    };
  };
}

/**
 * An environment's real pane tree, composed as `TerminalContainer` composes it:
 * a shell pane served by the terminal portal host beside a native Codex pane.
 *
 * With `?shell=app` it renders inside the real `AppShell`, as the app does, so
 * a breakpoint crossing moves the shell's content host between its layouts at
 * the same time as the pane tree moves its own pane hosts.
 */
export function PaneBreakpointFixture() {
  useState(installBackend);
  const node = usePaneLayoutStore((state) => state.environments.get(ENVIRONMENT_ID)?.root);
  if (!node) return null;
  const panes = (
    <div className="relative h-full min-h-0 flex-1 overflow-hidden bg-background">
      <DndContext>
        <PaneTree node={node} containerId={null} environmentId={ENVIRONMENT_ID} isActive />
        <TerminalPortalHost containerId={null} environmentId={ENVIRONMENT_ID} />
      </DndContext>
    </div>
  );
  if (new URLSearchParams(window.location.search).get("shell") === "app") {
    return (
      <div className="h-screen w-screen bg-background text-foreground">
        <TooltipProvider>
          <TerminalProvider>
            <DockerAvailabilityProvider available={false}>
              <AppShell>{panes}</AppShell>
            </DockerAvailabilityProvider>
          </TerminalProvider>
        </TooltipProvider>
      </div>
    );
  }
  return (
    <main className="flex h-screen w-screen flex-col bg-background text-foreground">{panes}</main>
  );
}
