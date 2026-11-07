/**
 * The invoke envelope over Electron IPC (plan item 1003): the renderer's
 * `invoke(command, args, { envelope })` reaches main as the third argument,
 * main hands it to the backend client, and the client sends its `domain`,
 * `version` and `critical` next to `command` and `args` to a real gateway in
 * front of a registry with a throwaway defined command. An older renderer's
 * two-argument call is today's `{ command, args }` body.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Schema from "effect/Schema";
import { buildInvokeEnvelope, defineCommand } from "@orkestrator/protocol/contract/command";
import { defineDomain } from "@orkestrator/protocol/contract/domain";
import { incompatibility, unknownCommand } from "@orkestrator/protocol/contract/errors";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import type { CommandContext } from "../../backend/src/core/commands-context";
import {
  CommandRegistry,
  createRegistryRegistrar,
} from "../../backend/src/core/commands-registry-contracts";
import { OrkestratorGateway } from "../../backend/src/gateway";
import { BackendHttpClient, invokeEnvelopeFields } from "../electron/backend-process";
import { ConnectionManager } from "../electron/connection-manager";
import { registerMainIpc } from "../electron/ipc";
import { createOrkestratorElectronApi, type IpcRendererLike } from "../electron/preload-api";

const TRUSTED = "file:///app/web/index.html";
const TOKEN = "test-token-123456";

// A throwaway definition: no real handler is converted in plan item 1003.
const system = defineDomain({ name: "system", version: 2, min: 1 });
const probe = defineCommand({
  domain: system,
  name: "get_contract_probe",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ text: Schema.String }),
  result: Schema.Struct({ echoed: Schema.String, keys: Schema.Array(Schema.String) }),
  critical: [],
});

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startContractGateway() {
  const commands = new CommandRegistry();
  const register = createRegistryRegistrar(commands, { validateResults: true });
  register(probe, (args) => ({ echoed: args.text, keys: Object.keys(args) }));
  const seen: unknown[][] = [];
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-envelope-ipc-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const rendererRoot = path.join(dataDir, "dist");
  await mkdir(rendererRoot);
  await writeFile(path.join(rendererRoot, "index.html"), '<div id="root"></div>');
  const gateway = new OrkestratorGateway({
    backend: {
      invoke: (command, args, invocation) => {
        seen.push(invocation === undefined ? [command, args] : [command, args, invocation]);
        const handler = commands.get(command);
        // As `OrkestratorBackend.invoke` does (plan item 1005).
        if (!handler) throw unknownCommand(command, invocation?.domain);
        return handler(args, {} as CommandContext, invocation);
      },
      hasCommand: (command) => commands.has(command),
    },
    dataDir,
    rendererRoot,
    bindAddress: "127.0.0.1",
    port: 0,
    env: { ORKESTRATOR_GATEWAY_TOKEN: TOKEN },
    allowNonTailscaleBind: true,
    legacyPreviewPortAccess: async () => "allowed" as const,
  });
  const info = await gateway.start();
  if (!info) throw new Error("Gateway did not start");
  cleanups.push(() => gateway.stop());
  return { url: info.url, seen };
}

/** Main's invoke handler over the backend client, and a renderer talking to it over fake IPC. */
type Handler = (event: unknown, ...args: unknown[]) => unknown;

function rendererOver(client: BackendHttpClient, { electronErrors = false } = {}) {
  const handlers = new Map<string, Handler>();
  const unused = () => {
    throw new Error("unused in this test");
  };
  const backendInvoke = mock(
    (command: string, args: Record<string, unknown>, options?: { envelope?: unknown }) =>
      options?.envelope
        ? client.invoke(command, args, options as { envelope: Record<string, unknown> })
        : client.invoke(command, args),
  );
  registerMainIpc({
    getBackend: () => ({ invoke: backendInvoke }),
    getMainWindow: () => null,
    ipc: { handle: (channel, listener) => void handlers.set(channel, listener as Handler) },
    clipboardApi: {} as never,
    createClipboardItem: unused as never,
    shellApi: { openExternal: async () => undefined },
    appApi: { exit: unused, quit: unused, relaunch: unused },
    nativeImageApi: {} as never,
    getMacOsPermissions: unused as never,
    getWebClientStatus: unused as never,
    setWebClientEnabled: unused as never,
    resetWebClientServe: unused as never,
    getGatewayTokenSettings: unused as never,
    setGatewayToken: unused as never,
    listConnections: unused as never,
    probeConnection: unused as never,
    connectToRemote: unused as never,
    updateConnectionToken: unused as never,
    renameConnection: unused as never,
    useConnection: unused as never,
    previewCommandHandover: unused as never,
    handOverCommandNode: unused as never,
    forgetConnection: unused as never,
    openConnectionWindow: unused as never,
    trustedRendererUrl: TRUSTED,
  });
  const sender = { sender: { id: 1 }, senderFrame: { url: TRUSTED } };
  const ipcRenderer: IpcRendererLike = {
    invoke: async <T>(channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`missing handler: ${channel}`);
      try {
        return (await handler(sender, ...args)) as T;
      } catch (error) {
        if (!electronErrors) throw error;
        // What Electron does: only the message crosses, behind its own wrapper.
        throw new Error(
          `Error invoking remote method '${channel}': Error: ${(error as Error).message}`,
        );
      }
    },
    on: () => undefined,
  };
  return {
    api: createOrkestratorElectronApi(ipcRenderer),
    raw: (...args: unknown[]) => handlers.get("orkestrator:invoke")!(sender, ...args),
    backendInvoke,
  };
}

describe("Electron IPC invoke envelope", () => {
  test("a defined command runs with the renderer's envelope, through main and the client", async () => {
    const gateway = await startContractGateway();
    const { api, backendInvoke } = rendererOver(new BackendHttpClient(gateway.url, TOKEN));
    const envelope = buildInvokeEnvelope(probe, { text: "hi" });

    await expect(
      api.invoke("get_contract_probe", { text: "hi", extra: 1 }, { envelope }),
    ).resolves.toEqual({ echoed: "hi", keys: ["text"] });
    expect(backendInvoke).toHaveBeenLastCalledWith(
      "get_contract_probe",
      { text: "hi", extra: 1 },
      { envelope },
    );
    // The backend saw the envelope's contract fields, and `args` from the call.
    expect(gateway.seen.at(-1)).toEqual([
      "get_contract_probe",
      { text: "hi", extra: 1 },
      { domain: "system", version: 2 },
    ]);
  });

  test("an older two-argument call keeps the plain body", async () => {
    const gateway = await startContractGateway();
    const { raw, backendInvoke } = rendererOver(new BackendHttpClient(gateway.url, TOKEN));

    await expect(raw("get_contract_probe", { text: "old" })).resolves.toEqual({
      echoed: "old",
      keys: ["text"],
    });
    expect(backendInvoke).toHaveBeenLastCalledWith("get_contract_probe", { text: "old" });
    expect(gateway.seen.at(-1)).toEqual(["get_contract_probe", { text: "old" }]);
  });

  test("an out-of-range version and an unknown critical field are refused by the backend", async () => {
    const gateway = await startContractGateway();
    const { api } = rendererOver(new BackendHttpClient(gateway.url, TOKEN));

    await expect(
      api.invoke(
        "get_contract_probe",
        { text: "a" },
        { envelope: { domain: "system", version: 9 } },
      ),
    ).rejects.toThrow("accepts versions 1 to 2");
    await expect(
      api.invoke(
        "get_contract_probe",
        { text: "a", steer: true },
        { envelope: { domain: "system", version: 1, critical: ["steer"] } },
      ),
    ).rejects.toThrow("Critical field steer");
  });
});

describe("typed incompatibility errors over IPC (plan item 1005)", () => {
  /** What reaches the renderer: the context bridge passes only the message. */
  const overTheBridge = (error: unknown) => new Error((error as Error).message);

  test("keep their code and details from the gateway, through main and the preload", async () => {
    const gateway = await startContractGateway();
    const { api } = rendererOver(new BackendHttpClient(gateway.url, TOKEN), {
      electronErrors: true,
    });

    const version = await api
      .invoke("get_contract_probe", { text: "a" }, { envelope: { domain: "system", version: 9 } })
      .catch((error: unknown) => error);
    // The preload rebuilds the error with its code and details...
    expect((version as { code?: unknown }).code).toBe("unsupported-version");
    expect((version as { details?: unknown }).details).toEqual({
      domain: "system",
      range: { min: 1, max: 2 },
      command: "get_contract_probe",
    });
    // ...and the message form carries them across the context bridge.
    expect(incompatibility(overTheBridge(version), "get_contract_probe")).toEqual({
      code: "unsupported-version",
      domain: "system",
      range: { min: 1, max: 2 },
      command: "get_contract_probe",
    });
    expect((version as Error).message).toContain("accepts versions 1 to 2");

    const field = await api
      .invoke(
        "get_contract_probe",
        { text: "a", steer: "secret-steer-value" },
        { envelope: { domain: "system", version: 1, critical: ["steer"] } },
      )
      .catch((error: unknown) => error);
    expect(incompatibility(overTheBridge(field))).toEqual({
      code: "unsupported-field",
      domain: "system",
      field: "steer",
      command: "get_contract_probe",
    });
    expect((field as Error).message).not.toContain("secret-steer-value");

    const unknown = await api.invoke("get_missing", {}).catch((error: unknown) => error);
    expect((unknown as { code?: unknown }).code).toBe("unknown-command");
    expect(incompatibility(overTheBridge(unknown), "get_missing")?.code).toBe("unknown-command");
    // An older renderer's text matcher still finds the legacy answer.
    expect((unknown as Error).message).toContain(unknownBackendCommandMessage("get_missing"));
  });

  test("leave every other error as it was", async () => {
    const gateway = await startContractGateway();
    const { api } = rendererOver(new BackendHttpClient(gateway.url, TOKEN), {
      electronErrors: true,
    });
    const failure = await api.invoke("get_contract_probe", {}).catch((error: unknown) => error);
    expect((failure as Error).message).toBe("Expected text to be a string");
    expect((failure as { code?: unknown }).code).toBeUndefined();
    expect(incompatibility(failure, "get_contract_probe")).toBeNull();
  });
});

describe("backend client envelope fields", () => {
  test("only domain, version and critical are taken from an envelope", () => {
    expect(invokeEnvelopeFields(undefined)).toBeNull();
    expect(invokeEnvelopeFields({})).toBeNull();
    expect(invokeEnvelopeFields({ command: "other", args: { a: 1 }, extra: true })).toBeNull();
    expect(
      invokeEnvelopeFields({
        command: "other",
        args: {},
        domain: "system",
        version: 1,
        critical: ["steer"],
        version2: 3,
      }),
    ).toEqual({ domain: "system", version: 1, critical: ["steer"] });
  });
});

describe("connection manager", () => {
  test("hands the envelope to the local backend client only when there is one", async () => {
    const invoke = mock(async (..._args: unknown[]) => "ok");
    const manager = new ConnectionManager({
      localBackend: { invoke } as never,
      secureStorage: {
        isAsyncEncryptionAvailable: async () => false,
        encryptStringAsync: async (value: string) => Buffer.from(value),
        decryptStringAsync: async (value: Buffer) => ({
          result: value.toString(),
          shouldReEncrypt: false,
        }),
        getSelectedStorageBackend: () => "basic_text",
      },
      onEvent: () => undefined,
    });
    const envelope = { domain: "system", version: 1 };
    await manager.invoke("get_contract_probe", { text: "a" }, undefined, { envelope });
    expect(invoke).toHaveBeenLastCalledWith("get_contract_probe", { text: "a" }, { envelope });
    await manager.invoke("get_contract_probe", { text: "b" });
    expect(invoke).toHaveBeenLastCalledWith("get_contract_probe", { text: "b" });
  });
});
