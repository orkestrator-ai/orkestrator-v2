/**
 * Shared fixtures for the MCP settings workflow tests. Test-only: nothing in
 * the application imports this module.
 */

import { mock } from "bun:test";
import { act } from "@testing-library/react";

import {
  MCP_MANAGEMENT_CHANGED_EVENT,
  type McpDefinitionSummary,
  type McpEditableDefinition,
  type McpImpactPreview,
  type McpManagementSnapshot,
  type McpManagementTarget,
  type McpOperationSnapshot,
  type McpTargetCapabilities,
} from "@orkestrator/protocol/mcp-management";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { listen as nativeListen } from "@/lib/native/events";

export const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
export const listenMock = nativeListen as unknown as ReturnType<typeof mock>;
export const SECRET = "SENTINEL-UI-SECRET";
export const TRANSPORT_FAILURE = "Failed to fetch";

export const flag = { supported: true };

export const capabilities: McpTargetCapabilities = {
  management: flag,
  transports: { stdio: flag, http: flag, sse: { supported: false, reason: "No SSE here." } },
  operations: { add: flag, update: flag, rename: flag, remove: flag, setEnabled: flag },
  fields: { env: flag, headers: flag, cwd: { supported: false, reason: "No cwd." }, advanced: [] },
  authentication: { staticHeaders: true, envReferences: true, runtimeSignIn: flag },
  apply: { strategy: "next-query", impact: "session", description: "Loads on the next message." },
  terminal: { readsNativeConfig: true, guidance: "Restart terminals." },
  nameRule: {
    pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$",
    description: "Letters, digits, dots, dashes and underscores.",
    maxBytes: 128,
  },
};

export const target: McpManagementTarget = {
  targetId: "mcp1~claude~backend",
  backendId: "b1",
  provider: "claude",
  providerLabel: "Claude Code",
  context: {
    kind: "backend",
    location: "backend-host",
    locationLabel: "This backend's user account",
  },
  defaultSourceId: "claude:user",
  capabilities,
};

export function environmentTarget(environmentId: string): McpManagementTarget {
  return {
    ...target,
    targetId: `mcp1~pi~env~${environmentId}~x`,
    provider: "pi",
    providerLabel: "Pi",
    context: { ...target.context, kind: "environment", environmentId },
  };
}

export function definition(overrides: Partial<McpDefinitionSummary> = {}): McpDefinitionSummary {
  return {
    entryId: "claude:user/ZG9jcw",
    sourceId: "claude:user",
    name: "docs",
    transport: "stdio",
    enabled: true,
    status: "effective",
    shadows: [],
    command: { kind: "visible", value: "npx" },
    argCount: 1,
    actions: { edit: flag, rename: flag, remove: flag, setEnabled: flag },
    preservedFields: [],
    secretCount: 0,
    ...overrides,
  };
}

export function snapshot(overrides: Partial<McpManagementSnapshot> = {}): McpManagementSnapshot {
  return {
    protocolVersion: 1,
    target,
    sources: [
      {
        sourceId: "claude:user",
        scope: "backend-user",
        owner: "native-user",
        format: "json",
        label: "Backend user",
        displayPath: "~/.claude.json",
        precedence: 10,
        state: "ok",
        writable: true,
        revision: "r1.one",
        sharedWith: [],
      },
    ],
    definitions: [definition()],
    effective: { docs: "claude:user/ZG9jcw" },
    operations: [],
    catalogRevision: 1,
    freshness: "fresh",
    truncated: 0,
    generatedAt: "2026-09-23T00:00:00Z",
    ...overrides,
  };
}

export const editableDocs: McpEditableDefinition = {
  entryId: "claude:user/ZG9jcw",
  sourceId: "claude:user",
  sourceRevision: "r1.one",
  name: "docs",
  transport: "stdio",
  enabled: true,
  command: { kind: "visible", value: "npx" },
  args: [{ index: 0, value: { kind: "visible", value: "docs-server" } }],
  env: [],
  headers: [],
  advanced: {},
  preservedFields: [],
};

export const preview: McpImpactPreview = {
  sourceId: "claude:user",
  sourceLabel: "Backend user",
  displayPath: "~/.claude.json",
  scope: "backend-user",
  changedFields: ["new server"],
  affectedEnvironments: [],
  sharedWith: [],
  apply: capabilities.apply,
  warnings: [],
};

export function operation(overrides: Partial<McpOperationSnapshot> = {}): McpOperationSnapshot {
  return {
    operationId: "op-1",
    requestId: "mcpreq-1",
    targetId: target.targetId,
    provider: "claude",
    kind: "update",
    entryName: "docs",
    sourceId: "claude:user",
    phase: "saved",
    savedRevision: "r1.two",
    applyIntent: "save-and-apply",
    apply: { state: "applied", runtimes: [], omitted: 0 },
    createdAt: "2026-09-23T00:00:00Z",
    updatedAt: "2026-09-23T00:00:00Z",
    ...overrides,
  };
}

export type Handlers = Record<string, (args: Record<string, unknown>) => unknown>;

export const baseHandlers: Handlers = {
  list_mcp_management_targets: () => ({ protocolVersion: 1, backendId: "b1", targets: [target] }),
  get_mcp_management_snapshot: () => snapshot(),
};

/** Route backend commands to handlers; an unexpected command fails the call. */
export function install(handlers: Handlers): void {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`Unexpected command ${command}`);
    return handler(args);
  });
}

export function resetInvoke(): void {
  invokeMock.mockImplementation(() => Promise.resolve());
}

/** Every argument object a command was invoked with, in order. */
export function callsOf(command: string): Array<Record<string, any>> {
  return invokeMock.mock.calls
    .filter((call: unknown[]) => call[0] === command)
    .map((call: unknown[]) => (call[1] ?? {}) as Record<string, any>);
}

/** Deliver the backend's "something changed" event to the latest listener. */
export async function emitMcpChanged(): Promise<void> {
  const registration = listenMock.mock.calls.findLast(
    (call: unknown[]) => call[0] === MCP_MANAGEMENT_CHANGED_EVENT,
  );
  if (!registration) throw new Error("No MCP change listener registered");
  const handler = registration[1] as (event: { payload: unknown }) => void;
  await act(async () => handler({ payload: { revision: 2, targetIds: [], operationIds: [] } }));
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Keyboard activation of a focused button: the browser synthesizes the click. */
export function pressEnter(
  element: HTMLElement,
  fire: { keyDown: (el: Element, init: object) => void; click: (el: Element) => void },
): void {
  element.focus();
  fire.keyDown(element, { key: "Enter", code: "Enter" });
  fire.click(element);
}
