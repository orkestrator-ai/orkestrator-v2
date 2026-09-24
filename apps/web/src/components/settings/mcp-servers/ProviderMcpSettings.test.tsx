import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  MCP_MANAGEMENT_CHANGED_EVENT,
  type McpEditableDefinition,
  type McpManagementSnapshot,
  type McpManagementTarget,
  type McpTargetCapabilities,
} from "@orkestrator/protocol/mcp-management";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { listen as nativeListen } from "@/lib/native/events";
import { requestMcpServerSettings } from "@/lib/mcp-settings-navigation";
import { expectDomAbsent } from "../../../../../../tests/bounded-test-diagnostics";

import { ProviderMcpSettings } from "./ProviderMcpSettings";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
const listenMock = nativeListen as unknown as ReturnType<typeof mock>;
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

/** Deliver the backend's "something changed" event to the mounted section. */
async function emitMcpChanged() {
  const registration = listenMock.mock.calls.findLast(
    (call: unknown[]) => call[0] === MCP_MANAGEMENT_CHANGED_EVENT,
  );
  if (!registration) throw new Error("No MCP change listener registered");
  const handler = registration[1] as () => void;
  await act(async () => handler());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function environmentTarget(environmentId: string): McpManagementTarget {
  return {
    ...target,
    targetId: `mcp1~pi~env~${environmentId}~x`,
    provider: "pi",
    providerLabel: "Pi",
    context: { ...target.context, kind: "environment", environmentId },
  };
}

const editableDocs: McpEditableDefinition = {
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
  preservedFields: [],
};

async function reviewNewServer(name = "files") {
  fireEvent.click(await screen.findByRole("button", { name: /Add server/ }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Executable"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Review change" }));
  await screen.findByLabelText("Change preview");
}

const TRANSPORT_FAILURE = "Failed to fetch";

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

  test("switching environment never shows or acts on the previous environment's servers", async () => {
    const snapshots: string[] = [];
    const pendingE2 = deferred<unknown>();
    install({
      list_mcp_management_targets: (args) =>
        args.environmentId === "e2"
          ? pendingE2.promise
          : { protocolVersion: 1, backendId: "b1", targets: [target, environmentTarget("e1")] },
      get_mcp_management_snapshot: (args) => {
        snapshots.push(String(args.targetId));
        const environmentId = String(args.targetId).split("~")[3]!;
        return snapshot({
          target: environmentTarget(environmentId),
          definitions: [{ ...snapshot().definitions[0]!, name: `docs-${environmentId}` }],
        });
      },
    });
    requestMcpServerSettings({ provider: "pi", environmentId: "e1" });
    render(<ProviderMcpSettings />);
    expect(await screen.findByText("docs-e1")).toBeTruthy();

    act(() => requestMcpServerSettings({ provider: "pi", environmentId: "e2" }));
    // The e2 target list is still loading: nothing from e1 may remain usable.
    expect(await screen.findByRole("status", { name: "Loading MCP servers" })).toBeTruthy();
    expectDomAbsent(screen.queryByText("docs-e1"), "previous environment row");
    expectDomAbsent(screen.queryByRole("button", { name: "Edit docs-e1" }), "previous edit");
    expectDomAbsent(screen.queryByRole("button", { name: /Add server/ }), "add for e1");
    expect(snapshots).toEqual(["mcp1~pi~env~e1~x"]);

    await act(async () =>
      pendingE2.resolve({
        protocolVersion: 1,
        backendId: "b1",
        targets: [target, environmentTarget("e2")],
      }),
    );
    expect(await screen.findByText("docs-e2")).toBeTruthy();
    expect(snapshots).toEqual(["mcp1~pi~env~e1~x", "mcp1~pi~env~e2~x"]);
  });

  test("a save retried after a lost response reuses its request id and revision", async () => {
    const mutations: any[] = [];
    let revision = "r1.one";
    install({
      ...baseHandlers,
      get_mcp_management_snapshot: () =>
        snapshot({ sources: [{ ...snapshot().sources[0]!, revision }] }),
      validate_mcp_mutation: (args) => {
        mutations.push(args.mutation);
        return { valid: true, fieldErrors: [], preview };
      },
      mutate_mcp_definition: (args) => {
        mutations.push(args.mutation);
        if (mutations.length === 2) throw new Error(TRANSPORT_FAILURE);
        return { operation: {}, replayed: true, savedRevision: "r1.two", entryId: "x" };
      },
    });
    render(<ProviderMcpSettings />);
    await reviewNewServer();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(TRANSPORT_FAILURE)).toBeTruthy();

    // The lost save did land: the change event refreshes the snapshot underneath.
    revision = "r1.two";
    const reads = invokeMock.mock.calls.length;
    await emitMcpChanged();
    await waitFor(() => expect(invokeMock.mock.calls.length).toBeGreaterThan(reads));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutations.length).toBe(3));
    const [validated, lost, retried] = mutations;
    expect(retried.requestId).toBe(lost.requestId);
    expect(retried.operation.expectedRevision).toBe("r1.one");
    expect(lost.operation.expectedRevision).toBe("r1.one");
    expect(validated.operation.expectedRevision).toBe("r1.one");
  });

  test("a remove retried after a lost response reuses its request id and revision", async () => {
    const mutations: any[] = [];
    let revision = "r1.one";
    install({
      ...baseHandlers,
      get_mcp_management_snapshot: () =>
        snapshot({ sources: [{ ...snapshot().sources[0]!, revision }] }),
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
      mutate_mcp_definition: (args) => {
        mutations.push(args.mutation);
        if (mutations.length === 1) throw new Error(TRANSPORT_FAILURE);
        return { operation: {}, replayed: true, savedRevision: "r1.two", entryId: "x" };
      },
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove docs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText(TRANSPORT_FAILURE)).toBeTruthy();

    revision = "r1.two";
    const reads = invokeMock.mock.calls.length;
    await emitMcpChanged();
    await waitFor(() => expect(invokeMock.mock.calls.length).toBeGreaterThan(reads));

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mutations.length).toBe(2));
    expect(mutations[1].requestId).toBe(mutations[0].requestId);
    expect(mutations[1].operation.expectedRevision).toBe("r1.one");
  });

  test("a structured backend failure ends the request: the next attempt has a new id", async () => {
    const mutations: any[] = [];
    install({
      ...baseHandlers,
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
      mutate_mcp_definition: (args) => {
        mutations.push(args.mutation);
        if (mutations.length === 1)
          throw new Error("McpManagementError:busy: Another change is in progress.");
        return { operation: {}, replayed: false, savedRevision: "r1.two", entryId: "x" };
      },
    });
    render(<ProviderMcpSettings />);
    await reviewNewServer();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Another change is in progress.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutations.length).toBe(2));
    expect(mutations[1].requestId).not.toBe(mutations[0].requestId);
  });

  test("a structured failure in the remove dialog also mints a new id", async () => {
    const mutations: any[] = [];
    install({
      ...baseHandlers,
      validate_mcp_mutation: () => ({ valid: true, fieldErrors: [], preview }),
      mutate_mcp_definition: (args) => {
        mutations.push(args.mutation);
        if (mutations.length === 1)
          throw new Error("McpManagementError:busy: Another change is in progress.");
        return { operation: {}, replayed: false, savedRevision: "r1.two", entryId: "x" };
      },
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove docs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Another change is in progress.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mutations.length).toBe(2));
    expect(mutations[1].requestId).not.toBe(mutations[0].requestId);
  });

  test("a failed background refresh keeps the open editor and its draft", async () => {
    let failRefresh = false;
    install({
      ...baseHandlers,
      get_mcp_management_snapshot: () => {
        if (failRefresh) throw new Error("The backend is restarting.");
        return snapshot();
      },
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /Add server/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "files" } });

    failRefresh = true;
    await emitMcpChanged();
    expect(await screen.findByText("The backend is restarting.")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("files");
  });

  test("advanced list and number fields keep what is typed and send parsed values", async () => {
    const advancedTarget: McpManagementTarget = {
      ...target,
      capabilities: {
        ...capabilities,
        fields: {
          ...capabilities.fields,
          advanced: [
            { id: "timeout", label: "Timeout", type: "number", transports: ["stdio"] },
            { id: "tools", label: "Tools", type: "string-list", transports: ["stdio"] },
          ],
        },
      },
    };
    const validated: any[] = [];
    install({
      list_mcp_management_targets: () => ({
        protocolVersion: 1,
        backendId: "b1",
        targets: [advancedTarget],
      }),
      get_mcp_management_snapshot: () => snapshot({ target: advancedTarget }),
      validate_mcp_mutation: (args) => {
        validated.push(args.mutation);
        return { valid: true, fieldErrors: [], preview };
      },
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /Add server/ }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "files" } });
    fireEvent.change(screen.getByLabelText("Executable"), { target: { value: "files" } });
    const tools = screen.getByLabelText("Tools") as HTMLInputElement;
    const timeout = screen.getByLabelText("Timeout") as HTMLInputElement;
    for (const typed of ["a", "a,", "a, ", "a, b"]) {
      fireEvent.change(tools, { target: { value: typed } });
      expect(tools.value).toBe(typed);
    }
    fireEvent.change(timeout, { target: { value: "abc" } });
    expect(screen.getByText("Enter a number.")).toBeTruthy();
    for (const typed of ["1", "1.", "1.5"]) {
      fireEvent.change(timeout, { target: { value: typed } });
      expect(timeout.value).toBe(typed);
    }
    expectDomAbsent(screen.queryByText("Enter a number."), "number problem");
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await waitFor(() => expect(validated.length).toBe(1));
    expect(validated[0].operation.definition.advanced).toEqual({ timeout: 1.5, tools: ["a", "b"] });
  });

  test("reloading after a conflict keeps another writer's changes to untouched fields", async () => {
    const validated: any[] = [];
    let definition = editableDocs;
    install({
      ...baseHandlers,
      get_mcp_definition: () => definition,
      validate_mcp_mutation: (args) => {
        validated.push(args.mutation);
        if (validated.length === 1)
          throw new Error("McpManagementError:revision-conflict: The configuration changed.");
        return { valid: true, fieldErrors: [], preview };
      },
    });
    render(<ProviderMcpSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit docs" }));
    await screen.findByText("Value saved");
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.change(screen.getByLabelText("Environment variables value 1"), {
      target: { value: "typed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));

    // Meanwhile another writer changed the executable.
    definition = {
      ...editableDocs,
      sourceRevision: "r1.two",
      command: { kind: "visible", value: "bunx" },
    };
    fireEvent.click(await screen.findByRole("button", { name: "Reload latest and review again" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Executable") as HTMLInputElement).value).toBe("bunx"),
    );
    expect((screen.getByLabelText("Environment variables value 1") as HTMLInputElement).value).toBe(
      "typed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await waitFor(() => expect(validated.length).toBe(2));
    expect(validated[1].operation).toEqual({
      kind: "update",
      entryId: "claude:user/ZG9jcw",
      expectedRevision: "r1.two",
      patch: { env: [{ key: "API_KEY", edit: { kind: "set", value: "typed" } }] },
    });
  });
});
