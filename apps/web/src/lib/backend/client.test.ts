import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { invoke } from "@/lib/native/backend";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { portalStore } from "@/lib/portal/portal-store";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  backendApiForScope,
  clientInvoke,
  commandBackendClient,
  machineInvoker,
  scopeBackendClient,
  type BackendClient,
} from "./client";
import { createKanbanApi, readFileBase64 } from "./kanban";

const commandInvoke = invoke as unknown as ReturnType<typeof mock>;
const LEAF = "bk_backend-client-leaf" as BackendId;

let windowScope: WindowScope;
let leafClient: FakeNodeClient;

beforeEach(() => {
  commandInvoke.mockClear();
  windowScope = new WindowScope();
  leafClient = new FakeNodeClient({ nodeId: LEAF, invoke: { read_file_base64: "bGVhZg==" } });
});

afterEach(() => {
  windowScope.dispose();
  resetWindowScopeForTests();
  commandInvoke.mockClear();
});

describe("lib/backend clients", () => {
  test("the command client is the native invoke, with the arguments exactly as given", async () => {
    await commandBackendClient.invokeRaw("get_config");
    await clientInvoke(commandBackendClient)("set_config", { theme: "dark" });
    expect(commandInvoke.mock.calls).toEqual([["get_config"], ["set_config", { theme: "dark" }]]);
  });

  test("the app's command scope keeps the command path; another scope uses its own client", async () => {
    expect(scopeBackendClient(getWindowScope().commandScope())).toBe(commandBackendClient);

    const leaf = windowScope.open({ role: "leaf", client: leafClient });
    await expect(createKanbanApi(scopeBackendClient(leaf)).readFileBase64("/a")).resolves.toBe(
      "bGVhZg==",
    );
    expect(leafClient.invocations).toEqual([
      { command: "read_file_base64", args: { filePath: "/a" } },
    ]);
    expect(commandInvoke).not.toHaveBeenCalled();
  });

  test("a scope's client answers from that scope's prefetched cache", async () => {
    const leaf = windowScope.open({ role: "leaf", client: leafClient });
    leaf.prefetched.prime([
      { command: "read_file_base64", args: { filePath: "/p" }, snapshot: "cHJpbWVk" },
    ]);
    await expect(createKanbanApi(scopeBackendClient(leaf)).readFileBase64("/p")).resolves.toBe(
      "cHJpbWVk",
    );
    expect(leafClient.invocations).toEqual([]);
  });

  test("backendApiForScope: the named exports on the command scope, one factory per other scope", async () => {
    const command = { readFileBase64 };
    expect(backendApiForScope(getWindowScope().commandScope(), createKanbanApi, command)).toBe(
      command,
    );

    const leaf = windowScope.open({ role: "leaf", client: leafClient });
    const api = backendApiForScope(leaf, createKanbanApi, command);
    expect(backendApiForScope(leaf, createKanbanApi, command)).toBe(api);
    expect(api).not.toBe(command);
    await expect(api.readFileBase64("/b")).resolves.toBe("bGVhZg==");
    expect(leafClient.invocations.map((call) => call.command)).toEqual(["read_file_base64"]);
    expect(commandInvoke).not.toHaveBeenCalled();
  });

  test("machineInvoker: no machine is the client's node; null and a node id go by the command node", async () => {
    const invokeRaw = mock(() => Promise.resolve("own" as never));
    const client: BackendClient = { invokeRaw };
    const onNode = spyOn(portalStore, "invokeOnNode").mockResolvedValue("relayed" as never);
    try {
      const machineInvoke = machineInvoker(client);
      await expect(machineInvoke(undefined, "list_agent_accounts")).resolves.toBe("own");
      expect(invokeRaw).toHaveBeenCalledWith("list_agent_accounts", {});

      await machineInvoke(null, "list_agent_accounts", { a: 1 });
      // No portal channel in tests: the portal falls back to the command scope.
      expect(commandInvoke).toHaveBeenLastCalledWith("list_agent_accounts", { a: 1 });

      await expect(machineInvoke("bk_other", "list_agent_accounts")).resolves.toBe("relayed");
      expect(onNode).toHaveBeenCalledWith("bk_other", "list_agent_accounts", {});
      expect(invokeRaw).toHaveBeenCalledTimes(1);
    } finally {
      onNode.mockRestore();
    }
  });
});
