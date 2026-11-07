/**
 * The `native-sessions` domain (plan item 7001): its definitions classify
 * reads as the routing classifier does, keep model records open (every key
 * the backend sends survives a tolerant decode), and its client sends typed,
 * enveloped calls to a node with the domain while a pre-contract node gets
 * today's untyped calls and capability reads.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { openRecord } from "../../model-schema.js";
import { isNodeReadCommand } from "../../../command-nodes.js";
import type { NegotiatedDomains } from "../../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { DOMAIN_CLIENTS } from "../../client-adapters.js";
import {
  decodeCommandArgs,
  decodeCommandResult,
  validateCommandResult,
  type AnyCommandDef,
} from "../../command.js";
import { unknownCommand } from "../../errors.js";
import {
  LEGACY_HANDOFF_CAPABILITIES,
  NATIVE_SESSIONS_COMMANDS,
  NATIVE_SESSIONS_HANDOFF_CAPABILITIES,
  NATIVE_SESSIONS_SYNC_CAPABILITIES,
  NativeAgentSessionSchema,
  dispatchNativeAgentIntentCommand,
  getNativeAgentSessionCommand,
  getNativeAgentTranscriptUpdateCommand,
  nativeSessionsClient,
  nativeSessionsDomain,
} from "./index.js";

/** Commands no workspace client calls: the interaction monitor's diagnostics. */
const ADMIN = new Set([
  "get_agent_interaction_observations",
  "reconcile_agent_interactions",
  "set_agent_interaction_monitor_adoption",
]);

/** Results the gateway splices pre-encoded (`markSpliceableResult`). */
const ENCODED = new Set([
  "get_native_agent_transcript_update",
  "get_native_agent_live_update",
  "get_native_agent_projection_update",
  "get_native_agent_message_page",
]);

describe("native-sessions definitions", () => {
  it("defines the domain's 87 commands once each, at version 1", () => {
    const names = NATIVE_SESSIONS_COMMANDS.map((def) => def.name);
    expect(names).toHaveLength(87);
    expect(new Set(names).size).toBe(87);
    expect(nativeSessionsDomain).toMatchObject({ name: "native-sessions", version: 1, min: 1 });
    for (const def of NATIVE_SESSIONS_COMMANDS) {
      expect(def.domain).toBe(nativeSessionsDomain);
      expect(def.since).toBe(1);
    }
  });

  it("classifies reads with the routing classifier, access and encoding as recorded", () => {
    for (const def of NATIVE_SESSIONS_COMMANDS) {
      expect({ name: def.name, read: def.read }).toEqual({
        name: def.name,
        read: isNodeReadCommand(def.name),
      });
      expect({ name: def.name, access: def.access }).toEqual({
        name: def.name,
        access: ADMIN.has(def.name) ? "admin" : "workspace",
      });
      expect({ name: def.name, encoded: def.encoded }).toEqual({
        name: def.name,
        encoded: ENCODED.has(def.name),
      });
    }
  });

  it("exports every schema as JSON Schema", () => {
    for (const def of NATIVE_SESSIONS_COMMANDS) {
      expect(() => Schema.toJsonSchemaDocument(def.args)).not.toThrow();
      expect(() => Schema.toJsonSchemaDocument(def.result)).not.toThrow();
    }
  });

  it("drops unknown argument keys and refuses an unknown critical one", () => {
    const decoded = decodeCommandArgs(getNativeAgentSessionCommand, {
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "tab-1",
      future: true,
    });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).not.toHaveProperty("future");
    const refused = decodeCommandArgs(
      getNativeAgentSessionCommand,
      { environmentId: "env-1", agent: "codex", logicalSessionKey: "tab-1", future: true },
      { critical: ["future"] },
    );
    expect(refused._tag).toBe("Failure");
  });

  it("keeps every key of an open record through a tolerant decode", () => {
    const session = {
      version: 1 as const,
      key: "env-1:codex:tab-1",
      environmentId: "env-1",
      agent: "codex" as const,
      logicalSessionKey: "tab-1",
      providerSessionId: "p-1",
      origin: "interactive-native" as const,
      interactionPolicy: { version: 1, mode: "interactive", future: true } as never,
      lastDispatchedTurn: { requestId: "r1", mode: "build" as const },
      createdAt: "2026-11-07T00:00:00.000Z",
      updatedAt: "2026-11-07T00:00:00.000Z",
      future: { kept: true },
    };
    const decoded = decodeCommandResult(getNativeAgentSessionCommand, session);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).toEqual(session);
    // A present field is still type-checked, and the record's fields are the model's (7010).
    expect(Schema.decodeUnknownResult(NativeAgentSessionSchema)({ key: 1 })._tag).toBe("Failure");
    expect(
      decodeCommandResult(getNativeAgentSessionCommand, { ...session, agent: "future-agent" })._tag,
    ).toBe("Failure");
    const { providerSessionId: _missing, ...partial } = session;
    expect(decodeCommandResult(getNativeAgentSessionCommand, partial)._tag).toBe("Failure");
    // A malformed self-validated field reads as absent in the backend, so it does not fail here.
    expect(
      decodeCommandResult(getNativeAgentSessionCommand, { ...session, backendTitle: 7 })._tag,
    ).toBe("Success");
    const open = openRecord({ id: Schema.String });
    expect(Schema.decodeUnknownSync(open)({ id: "a", deep: { x: [1] } }) as unknown).toEqual({
      id: "a",
      deep: { x: [1] },
    });
  });

  it("does not validate a pre-encoded (spliced) result", () => {
    const result = validateCommandResult(getNativeAgentTranscriptUpdateCommand, "not an object");
    expect(result._tag).toBe("Success");
  });

  it("lists its client in DOMAIN_CLIENTS with adapters 1 and 0", () => {
    expect(DOMAIN_CLIENTS).toContain(nativeSessionsClient);
    expect(nativeSessionsClient.versions).toEqual([1, 0]);
  });
});

interface Sent {
  command: string;
  args: unknown;
  envelope: ContractEnvelopeFields | undefined;
}

function fakeNode(
  domains: NegotiatedDomains | undefined,
  answer: (command: string) => unknown = () => ({}),
) {
  const sent: Sent[] = [];
  const invoked: Array<{ command: string; args: unknown }> = [];
  const usage: Array<[string, number]> = [];
  const options = {
    call: async (def: AnyCommandDef, args: unknown, envelope?: ContractEnvelopeFields) => {
      sent.push({ command: def.name, args, envelope });
      return answer(def.name);
    },
    invoke: async (command: string, args?: Readonly<Record<string, unknown>>) => {
      invoked.push({ command, args });
      return answer(command);
    },
    domains,
    usage: (domain: string, version: number) => usage.push([domain, version]),
  };
  return { sent, invoked, usage, options };
}

const NATIVE_SESSIONS_V1 = { "native-sessions": { min: 1, max: 1 } };

const dispatch = {
  environmentId: "env-1",
  agent: "codex",
  logicalSessionKey: "tab-1",
  prompt: "Build it",
  requestId: "r1",
  schema: { type: "object" },
};

describe("native-sessions client", () => {
  it("version 1: typed calls carry the envelope and its critical keys, results decode", async () => {
    const node = fakeNode(NATIVE_SESSIONS_V1, (command) =>
      command === "dispatch_native_agent_intent"
        ? { outcome: "accepted", requestId: "r1", extra: "kept" }
        : null,
    );
    const client = createDomainClient(nativeSessionsClient, node.options);
    expect(client.version()).toBe(1);
    const api = client.api();
    await expect(api.dispatch_native_agent_intent(dispatch)).resolves.toEqual({
      outcome: "accepted",
      requestId: "r1",
      extra: "kept",
    } as never);
    expect(node.sent[0]).toEqual({
      command: dispatchNativeAgentIntentCommand.name,
      args: dispatch,
      envelope: { domain: "native-sessions", version: 1, critical: ["requestId", "schema"] },
    });
    await expect(
      api.get_native_agent_session({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "tab-1",
      }),
    ).resolves.toBeNull();
    expect(node.invoked).toEqual([]);
    expect(node.usage).toEqual([]);
  });

  it("version 1: both capability commands are folded into the version", async () => {
    const node = fakeNode(NATIVE_SESSIONS_V1);
    const api = createDomainClient(nativeSessionsClient, node.options).api();
    await expect(api.handoffCapabilities()).resolves.toEqual(NATIVE_SESSIONS_HANDOFF_CAPABILITIES);
    await expect(api.syncCapabilities()).resolves.toEqual(NATIVE_SESSIONS_SYNC_CAPABILITIES);
    expect(node.sent).toEqual([]);
    expect(node.invoked).toEqual([]);
  });

  it("version 1: a result that does not match its schema is refused", async () => {
    const node = fakeNode(NATIVE_SESSIONS_V1, () => ({ outcome: 7 }));
    const api = createDomainClient(nativeSessionsClient, node.options).api();
    await expect(api.dispatch_native_agent_intent(dispatch)).rejects.toThrow(
      "Invalid result from dispatch_native_agent_intent",
    );
  });

  it("version 0: today's untyped call, no envelope, the answer as sent, counted", async () => {
    const legacyAnswer = { outcome: 7, older: true };
    const node = fakeNode(undefined, () => legacyAnswer);
    const client = createDomainClient(nativeSessionsClient, node.options);
    expect(client.version()).toBe(0);
    await expect(client.api().dispatch_native_agent_intent(dispatch)).resolves.toBe(
      legacyAnswer as never,
    );
    expect(node.invoked).toEqual([{ command: "dispatch_native_agent_intent", args: dispatch }]);
    expect(node.sent).toEqual([]);
    expect(node.usage).toEqual([["native-sessions", 0]]);
  });

  it("version 0: handoff capabilities are read, and a node without the command does none", async () => {
    const capable = fakeNode(undefined, () => ({ create: true, delivery: true, pruning: "yes" }));
    await expect(
      createDomainClient(nativeSessionsClient, capable.options).api().handoffCapabilities(),
    ).resolves.toEqual({ create: true, delivery: true, pruning: false });
    expect(capable.invoked).toEqual([
      { command: "get_agent_handoff_capabilities", args: undefined },
    ]);

    const older = fakeNode(undefined, (command) => {
      throw unknownCommand(command);
    });
    await expect(
      createDomainClient(nativeSessionsClient, older.options).api().handoffCapabilities(),
    ).resolves.toEqual(LEGACY_HANDOFF_CAPABILITIES);

    const failing = fakeNode(undefined, () => {
      throw new Error("Backend unavailable");
    });
    await expect(
      createDomainClient(nativeSessionsClient, failing.options).api().handoffCapabilities(),
    ).rejects.toThrow("Backend unavailable");
  });

  it("version 0: sync capabilities are the node's answer, asked on every call", async () => {
    const answer = { projectionSyncVersions: [1], historyPagingVersions: [1] };
    const node = fakeNode(undefined, () => answer);
    const api = createDomainClient(nativeSessionsClient, node.options).api();
    await expect(api.syncCapabilities()).resolves.toBe(answer);
    await expect(api.syncCapabilities()).resolves.toBe(answer);
    expect(node.invoked.map((call) => call.command)).toEqual([
      "get_native_agent_sync_capabilities",
      "get_native_agent_sync_capabilities",
    ]);
    const older = fakeNode(undefined, (command) => {
      throw unknownCommand(command);
    });
    await expect(
      createDomainClient(nativeSessionsClient, older.options).api().syncCapabilities(),
    ).rejects.toMatchObject({ code: "unknown-command" });
  });
});
