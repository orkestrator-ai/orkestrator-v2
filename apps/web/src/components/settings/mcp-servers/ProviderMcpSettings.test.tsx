import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type {
  McpManagementSnapshot,
  McpManagementTarget,
  McpTargetCapabilities,
} from "@orkestrator/protocol/mcp-management";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { requestMcpServerSettings } from "@/lib/mcp-settings-navigation";
import { expectDomAbsent } from "../../../../../../tests/bounded-test-diagnostics";

import { ProviderMcpSettings } from "./ProviderMcpSettings";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
const SECRET = "SENTINEL-UI-SECRET";

const flag = { supported: true };
const capabilities: McpTargetCapabilities = {
  management: flag,
  transports: { stdio: flag, http: flag, sse: { supported: false, reason: "No SSE here." } },
  operations: {
    add: flag,
    update: flag,
    rename: flag,
    remove: flag,
    setEnabled: { supported: false, reason: "No switch." },
  },
  fields: { env: flag, headers: flag, cwd: { supported: false, reason: "No cwd." }, advanced: [] },
  authentication: { staticHeaders: true, envReferences: true, runtimeSignIn: flag },
  apply: { strategy: "next-query", impact: "session", description: "Loads on the next message." },
  terminal: { readsNativeConfig: true, guidance: "Restart terminals." },
  nameRule: {
    pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$",
    description: "Letters and digits.",
    maxBytes: 128,
  },
};

const target: McpManagementTarget = {
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

function snapshot(overrides: Partial<McpManagementSnapshot> = {}): McpManagementSnapshot {
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
        sharedWith: ["grok"],
      },
    ],
    definitions: [
      {
        entryId: "claude:user/ZG9jcw",
        sourceId: "claude:user",
        name: "docs",
        transport: "stdio",
        enabled: null,
        status: "effective",
        shadows: [],
        command: { kind: "visible", value: "npx" },
        argCount: 1,
        actions: {
          edit: flag,
          rename: flag,
          remove: flag,
          setEnabled: { supported: false, reason: "No switch." },
        },
        preservedFields: [],
        secretCount: 1,
      },
    ],
    effective: { docs: "claude:user/ZG9jcw" },
    operations: [],
    catalogRevision: 1,
    freshness: "fresh",
    truncated: 0,
    generatedAt: "2026-09-23T00:00:00Z",
    ...overrides,
  };
}

const preview = {
  sourceId: "claude:user",
  sourceLabel: "Backend user",
  displayPath: "~/.claude.json",
  scope: "backend-user",
  changedFields: ["new server"],
  affectedEnvironments: [],
  sharedWith: ["grok"],
  apply: capabilities.apply,
  warnings: ["Existing container environments keep the copy they were created with."],
};

function install(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`Unexpected command ${command}`);
    return handler(args);
  });
}

const baseHandlers = {
  list_mcp_management_targets: () => ({ protocolVersion: 1, backendId: "b1", targets: [target] }),
  get_mcp_management_snapshot: () => snapshot(),
};

afterEach(() => {
  cleanup();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("ProviderMcpSettings", () => {
  test("lists servers by source with status text, and links to Control MCP separately", async () => {
    install(baseHandlers);
    render(<ProviderMcpSettings />);
    expect(await screen.findByText("docs")).toBeTruthy();
    expect(screen.getByText("In use")).toBeTruthy();
    expect(screen.getByText("~/.claude.json")).toBeTruthy();
    expect(screen.getByText("Also read by Grok Build")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Control MCP" })).toBeTruthy();
  });

  test("a malformed source shows its own error, not an empty list", async () => {
    install({
      ...baseHandlers,
      get_mcp_management_snapshot: () =>
        snapshot({
          sources: [
            {
              ...snapshot().sources[0]!,
              state: "invalid",
              writable: false,
              error: "~/.claude.json could not be parsed",
              revision: null,
            },
          ],
          definitions: [],
          freshness: "incomplete",
        }),
    });
    render(<ProviderMcpSettings />);
    expect(await screen.findByText(/Could not be read/)).toBeTruthy();
    expect(screen.getByText(/cannot be listed until it is repaired/)).toBeTruthy();
    expectDomAbsent(screen.queryByText("No servers."), "empty-source text");
  });

  test("an older backend is reported as unsupported", async () => {
    install({
      list_mcp_management_targets: () => {
        throw new Error("Unknown backend command: list_mcp_management_targets");
      },
    });
    render(<ProviderMcpSettings />);
    expect(await screen.findByText(/does not support managing MCP servers/)).toBeTruthy();
  });

  test("add reviews an impact preview, then saves with an expected revision", async () => {
    const mutations: unknown[] = [];
    install({
      ...baseHandlers,
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
      mutate_mcp_definition: (args) => {
        mutations.push(args.mutation);
        return { operation: {}, replayed: false, savedRevision: "r1.two", entryId: "x" };
      },
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /Add server/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "files" } });
    fireEvent.change(screen.getByLabelText("Executable"), {
      target: { value: "/opt/My Tools/files" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add argument/ }));
    fireEvent.change(screen.getByLabelText("Argument 1"), { target: { value: "a b; c" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    expect(await screen.findByLabelText("Change preview")).toBeTruthy();
    expect(screen.getByText(/keep the copy they were created with/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save and apply" }));
    await waitFor(() => expect(mutations.length).toBe(1));
    expect(mutations[0]).toMatchObject({
      targetId: "mcp1~claude~backend",
      applyIntent: "save-and-apply",
      operation: {
        kind: "add",
        sourceId: "claude:user",
        expectedRevision: "r1.one",
        definition: {
          name: "files",
          transport: "stdio",
          command: "/opt/My Tools/files",
          args: ["a b; c"],
        },
      },
    });
  });

  test("edit shows saved secrets as present only, and keep/replace produce a minimal patch", async () => {
    const mutations: any[] = [];
    install({
      ...baseHandlers,
      get_mcp_definition: () => ({
        entryId: "claude:user/ZG9jcw",
        sourceId: "claude:user",
        sourceRevision: "r1.one",
        name: "docs",
        transport: "stdio",
        enabled: null,
        command: { kind: "visible", value: "npx" },
        args: [{ index: 0, value: { kind: "redacted", display: "(retained value)" } }],
        env: [{ key: "API_KEY", presence: "literal" }],
        headers: [],
        advanced: {},
        preservedFields: ["custom"],
      }),
      validate_mcp_mutation: (args) => {
        mutations.push(args.mutation);
        return {
          valid: true,
          fieldErrors: [],
          preview: { ...preview, changedFields: ["environment"] },
        };
      },
      mutate_mcp_definition: (args) => {
        mutations.push(args.mutation);
        return { operation: {}, replayed: false, savedRevision: "r1.two", entryId: "x" };
      },
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit docs" }));
    expect(await screen.findByText("Value saved")).toBeTruthy();
    expect(screen.getByText("(retained value)")).toBeTruthy();
    expect(screen.getByText(/Kept as they are: custom/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.change(screen.getByLabelText("Environment variables value 1"), {
      target: { value: SECRET },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByLabelText("Change preview");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutations.length).toBe(2));
    expect(mutations[1].operation).toEqual({
      kind: "update",
      entryId: "claude:user/ZG9jcw",
      expectedRevision: "r1.one",
      patch: { env: [{ key: "API_KEY", edit: { kind: "set", value: SECRET } }] },
    });
    // The typed secret is gone from the DOM once the dialog closes.
    await waitFor(() => expect(document.body.innerHTML).not.toContain(SECRET));
  });

  test("a revision conflict keeps the draft and offers a reload", async () => {
    install({
      ...baseHandlers,
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
      mutate_mcp_definition: () => {
        throw new Error(
          "McpManagementError:revision-conflict: The configuration changed since it was loaded. Reload and try again.",
        );
      },
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /Add server/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "files" } });
    fireEvent.change(screen.getByLabelText("Executable"), { target: { value: "files" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByLabelText("Change preview");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload latest and review again" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("files");
  });

  test("remove previews the fallback that becomes effective", async () => {
    install({
      ...baseHandlers,
      validate_mcp_mutation: () => ({
        valid: true,
        fieldErrors: [],
        preview: {
          ...preview,
          changedFields: ["removed"],
          revealsEntryId: "claude:project/x",
          revealsSourceLabel: "Project (this worktree)",
        },
      }),
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove docs" }));
    expect(
      await screen.findByText(
        /same-name server from Project \(this worktree\) will become effective/,
      ),
    ).toBeTruthy();
  });

  test("a deep link selects the provider and environment", async () => {
    const snapshots: string[] = [];
    const environmentTarget = {
      ...target,
      targetId: "mcp1~pi~env~e1~x",
      provider: "pi" as const,
      providerLabel: "Pi",
      context: { ...target.context, kind: "environment" as const, environmentId: "e1" },
    };
    install({
      list_mcp_management_targets: (args) => ({
        protocolVersion: 1,
        backendId: "b1",
        targets: args.environmentId ? [target, environmentTarget] : [target],
      }),
      get_mcp_management_snapshot: (args) => {
        snapshots.push(String(args.targetId));
        return snapshot({ target: environmentTarget });
      },
    });
    requestMcpServerSettings({ provider: "pi", environmentId: "e1" });
    render(<ProviderMcpSettings />);
    await waitFor(() => expect(snapshots).toContain("mcp1~pi~env~e1~x"));
  });
});
