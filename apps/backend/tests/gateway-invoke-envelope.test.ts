/**
 * The invoke envelope on the HTTP transport and through the command node's
 * relay (plan item 1003): `domain`, `version` and `critical` travel next to
 * `command` and `args`, reach the registry, and a refusal answers a typed
 * error with bounded details. A body with only `command` and `args` (every
 * older client) is today's call.
 */
import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { buildInvokeEnvelope, defineCommand } from "@orkestrator/protocol/contract/command";
import { defineDomain } from "@orkestrator/protocol/contract/domain";
import { fromWire, incompatibility, unknownCommand } from "@orkestrator/protocol/contract/errors";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import type { CommandContext } from "../src/core/commands-context.js";
import {
  CommandRegistry,
  createRegistryRegistrar,
} from "../src/core/commands-registry-contracts.js";
import type { BackendHelloIdentity } from "../src/gateway";
import { requestUrl, startGateway } from "./gateway-test-harness.js";

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

function contractBackend() {
  const commands = new CommandRegistry();
  const register = createRegistryRegistrar(commands, { validateResults: true });
  register(probe, (args) => ({ echoed: args.text, keys: Object.keys(args) }));
  register("get_plain_probe", (args) => ({ keys: Object.keys(args) }));
  const seen: unknown[][] = [];
  return {
    seen,
    backend: {
      invoke: (command: string, args: Record<string, unknown>, ...rest: unknown[]) => {
        seen.push([command, args, ...rest]);
        const handler = commands.get(command);
        // As `OrkestratorBackend.invoke` does (plan item 1005).
        if (!handler)
          throw unknownCommand(command, (rest[0] as { domain?: string } | undefined)?.domain);
        return handler(args, {} as CommandContext, rest[0] as never);
      },
      hasCommand: (command: string) => commands.has(command),
      commandAccess: (command: string) => commands.contracts.get(command)?.access,
    },
  };
}

async function invoke(url: string, token: string, body: unknown) {
  const response = await requestUrl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: response.json() as Record<string, unknown> };
}

describe("HTTP invoke envelope", () => {
  test("a defined command runs with the envelope; unknown fields are stripped", async () => {
    const { backend, seen } = contractBackend();
    const { info } = await startGateway({ backend });
    const url = new URL("/__orkestrator/invoke", info.url).toString();
    const envelope = buildInvokeEnvelope(probe, { text: "hi", extra: 1 } as never);
    const answer = await invoke(url, info.token, envelope);
    expect(answer).toEqual({ status: 200, body: { result: { echoed: "hi", keys: ["text"] } } });
    expect(seen[0]).toEqual([
      "get_contract_probe",
      { text: "hi", extra: 1 },
      { domain: "system", version: 2 },
    ]);
  });

  test("an older two-field body reaches the backend unchanged, with no invocation", async () => {
    const { backend, seen } = contractBackend();
    const { info } = await startGateway({ backend });
    const url = new URL("/__orkestrator/invoke", info.url).toString();
    const answer = await invoke(url, info.token, {
      command: "get_contract_probe",
      args: { text: "a" },
    });
    expect(answer.status).toBe(200);
    expect(seen[0]).toEqual(["get_contract_probe", { text: "a" }]);
    const plain = await invoke(url, info.token, { command: "get_plain_probe", args: { x: 1 } });
    expect(plain).toEqual({ status: 200, body: { result: { keys: ["x"] } } });
  });

  test("a version outside the range answers unsupported-version with the range", async () => {
    const { backend } = contractBackend();
    const { info } = await startGateway({ backend });
    const url = new URL("/__orkestrator/invoke", info.url).toString();
    const answer = await invoke(url, info.token, {
      command: "get_contract_probe",
      args: { text: "a" },
      domain: "system",
      version: 5,
    });
    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({
      error: expect.stringContaining("accepts versions 1 to 2"),
      code: "unsupported-version",
      details: { domain: "system", range: { min: 1, max: 2 }, command: "get_contract_probe" },
    });
    expect(incompatibility(fromWire(answer.body))).toEqual({
      code: "unsupported-version",
      domain: "system",
      range: { min: 1, max: 2 },
      command: "get_contract_probe",
    });
  });

  test("an unknown critical field answers unsupported-field naming it, never its value", async () => {
    const { backend } = contractBackend();
    const { info } = await startGateway({ backend });
    const url = new URL("/__orkestrator/invoke", info.url).toString();
    const answer = await invoke(url, info.token, {
      command: "get_contract_probe",
      args: { text: "a", steer: "secret-steer-value" },
      domain: "system",
      version: 1,
      critical: ["steer"],
    });
    expect(answer.status).toBe(500);
    expect(answer.body).toMatchObject({
      code: "unsupported-field",
      details: { domain: "system", field: "steer" },
    });
    expect(JSON.stringify(answer.body)).not.toContain("secret-steer-value");
  });

  test("an unknown command answers coded, with the legacy text and the envelope's domain", async () => {
    const { backend } = contractBackend();
    const { info } = await startGateway({ backend });
    const url = new URL("/__orkestrator/invoke", info.url).toString();
    const plain = await invoke(url, info.token, { command: "get_missing", args: {} });
    expect(plain).toEqual({
      status: 500,
      body: {
        error: unknownBackendCommandMessage("get_missing"),
        code: "unknown-command",
        details: { command: "get_missing" },
      },
    });
    const enveloped = await invoke(url, info.token, {
      command: "get_missing",
      args: {},
      domain: "system",
      version: 1,
    });
    expect(enveloped.body).toEqual({
      error: unknownBackendCommandMessage("get_missing"),
      code: "unknown-command",
      details: { domain: "system", command: "get_missing" },
    });
    expect(incompatibility(fromWire(enveloped.body), "get_missing")).toEqual({
      code: "unknown-command",
      domain: "system",
      command: "get_missing",
    });
  });

  test("a schema failure keeps the existing validation text and carries no code", async () => {
    const { backend } = contractBackend();
    const { info } = await startGateway({ backend });
    const url = new URL("/__orkestrator/invoke", info.url).toString();
    const answer = await invoke(url, info.token, {
      command: "get_contract_probe",
      args: { text: 4 },
    });
    expect(answer).toEqual({ status: 500, body: { error: "Expected text to be a string" } });
  });

  test("a malformed envelope is refused before the backend runs", async () => {
    const { backend, seen } = contractBackend();
    const { info } = await startGateway({ backend });
    const url = new URL("/__orkestrator/invoke", info.url).toString();
    const tooMany = Array.from({ length: 17 }, (_, index) => `field${index}`);
    for (const body of [
      { command: "get_contract_probe", args: {}, critical: tooMany },
      { command: "get_contract_probe", args: {}, critical: "steer" },
      { command: "get_contract_probe", args: {}, version: -1 },
      { command: "get_contract_probe", args: {}, domain: "Not A Domain" },
    ]) {
      const answer = await invoke(url, info.token, body);
      expect(answer.status).toBe(400);
      expect(typeof answer.body.error).toBe("string");
    }
    expect(seen).toHaveLength(0);
  });
});

const leafIdentity: BackendHelloIdentity = {
  installationId: "bk_leaf-node",
  generation: "generation-1",
  appVersion: "9.9.9-test",
  profile: {
    revision: 1,
    displayName: "Leaf",
    colorToken: "teal",
    updatedAt: "2026-10-21T00:00:00.000Z",
  },
  nodeMode: "leaf",
};

describe("relay through the command node", () => {
  test("forwards the envelope unchanged to the leaf's registry", async () => {
    const leafBackend = contractBackend();
    const leaf = await startGateway({ backend: leafBackend.backend });
    // The relay admits only commands the command node itself defines with
    // `access: "workspace"` (7012): it runs a build with the same probe.
    const commandNode = await startGateway({
      backend: contractBackend().backend,
      backendHello: async () => leafIdentity,
      nodeHooks: {
        isPortalOriginAllowed: () => false,
        noteControllerContact: () => undefined,
        relayTarget: (nodeId: string) =>
          nodeId === "bk_leaf"
            ? {
                baseUrl: leaf.info.url,
                headers: { authorization: `Bearer ${leaf.info.token}` },
              }
            : null,
      },
    });
    const url = new URL(
      "/__orkestrator/nodes/bk_leaf/__orkestrator/invoke",
      commandNode.info.url,
    ).toString();

    const accepted = await invoke(url, commandNode.info.token, {
      ...buildInvokeEnvelope(probe, { text: "relayed" }, 1),
    });
    expect(accepted).toEqual({
      status: 200,
      body: { result: { echoed: "relayed", keys: ["text"] } },
    });
    expect(leafBackend.seen[0]).toEqual([
      "get_contract_probe",
      { text: "relayed" },
      { domain: "system", version: 1 },
    ]);

    const refused = await invoke(url, commandNode.info.token, {
      command: "get_contract_probe",
      args: { text: "a" },
      domain: "system",
      version: 3,
    });
    expect(refused.status).toBe(500);
    expect(refused.body).toMatchObject({
      code: "unsupported-version",
      details: { domain: "system", range: { min: 1, max: 2 } },
    });

    // An older client's two-field body is relayed as it always was.
    const older = await invoke(url, commandNode.info.token, {
      command: "get_contract_probe",
      args: { text: "old" },
    });
    expect(older.status).toBe(200);
    expect(leafBackend.seen.at(-1)).toEqual(["get_contract_probe", { text: "old" }]);
  });
});
