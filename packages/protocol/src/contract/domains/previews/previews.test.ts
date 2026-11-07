/**
 * The `previews` domain (plan item 7004): every command defined once with the
 * keys its lenient handler read, the routing classifier's read class, the
 * critical keys, tolerant decoding, and the client's two adapters against a
 * fake node.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { isNodeReadCommand } from "../../../command-nodes.js";
import { fixturePreviewCapabilities } from "../../../testing/preview-contract-fixtures.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { DOMAIN_CLIENTS } from "../../client-adapters.js";
import { decodeCommandArgs } from "../../command.js";
import {
  PREVIEWS_COMMANDS,
  PreviewDiagnosticsSnapshotSchema,
  PreviewMutationResultSchema,
  previewsClient,
} from "./index.js";

/** The keys each handler read before it was defined (2026-11-07). */
const HANDLER_KEYS: Record<string, readonly string[]> = {
  get_preview_capabilities: [],
  get_preview_services: ["environmentId", "knownEpoch", "knownRevision"],
  register_preview_service: ["service", "operationId"],
  update_preview_service: ["serviceId", "expectedRevision", "patch", "operationId"],
  remove_preview_service: ["serviceId", "expectedRevision", "operationId"],
  resolve_preview_target: ["serviceRef", "intent"],
  probe_preview_service: ["serviceId"],
  create_preview_attachment: ["serviceId", "surface", "clientKey", "path"],
  renew_preview_attachment: ["attachmentId"],
  release_preview_attachment: ["attachmentId"],
  create_preview_handoff_url: ["serviceId", "clientKey", "path"],
  get_preview_public_origin: ["serviceId"],
  revoke_preview_access: ["serviceId"],
  get_preview_diagnostics: [],
  record_preview_client_metrics: ["report"],
  get_preview_settings: [],
  update_preview_settings: ["settings"],
};

describe("previews definitions", () => {
  it("define the 17 preview commands once, in version 1", () => {
    expect(PREVIEWS_COMMANDS.map((def): string => def.name).sort()).toEqual(
      Object.keys(HANDLER_KEYS).sort(),
    );
    for (const def of PREVIEWS_COMMANDS) {
      expect(def.since).toBe(1);
      expect([def.domain.name, def.domain.version, def.domain.min]).toEqual(["previews", 1, 1]);
    }
  });

  it.each(PREVIEWS_COMMANDS.map((def) => [def.name, def] as const))(
    "%s declares the keys its handler read, and its read class",
    (name, def) => {
      expect(Object.keys(def.args.fields).sort()).toEqual([...HANDLER_KEYS[name]!].sort());
      expect(def.read).toBe(isNodeReadCommand(name));
    },
  );

  it("marks the idempotency, compare-and-set and revocation-scope keys critical", () => {
    const critical = Object.fromEntries(
      PREVIEWS_COMMANDS.filter((def) => def.critical.length > 0).map((def) => [
        def.name,
        def.critical,
      ]),
    );
    expect(critical).toEqual({
      register_preview_service: ["operationId"],
      update_preview_service: ["operationId"],
      remove_preview_service: ["expectedRevision", "operationId"],
      revoke_preview_access: ["serviceId"],
    });
  });

  it("classifies the settings write as admin and everything else as workspace", () => {
    expect(
      PREVIEWS_COMMANDS.filter((def) => def.access !== "workspace").map((def) => def.name),
    ).toEqual(["update_preview_settings"]);
  });

  it("decode tolerantly: an unknown key is dropped and the handler's own checks still see any value", () => {
    for (const def of PREVIEWS_COMMANDS) {
      const decoded = decodeCommandArgs(def, { fromANewerPeer: true });
      expect(decoded._tag).toBe("Success");
    }
    const decoded = decodeCommandArgs(PREVIEWS_COMMANDS[1], {
      environmentId: 42,
      knownRevision: "not a number",
      extra: true,
    });
    expect(decoded._tag === "Success" && decoded.success).toEqual({
      environmentId: 42,
      knownRevision: "not a number",
    });
  });

  it("result schemas accept today's records and keep the fields they do not declare", () => {
    const capabilities = fixturePreviewCapabilities();
    const def = PREVIEWS_COMMANDS[0];
    expect(Schema.decodeUnknownSync(def.result)(capabilities)).toEqual(capabilities);
    const mutation = {
      kind: "removed" as const,
      serviceId: "svc_1",
      replayed: false,
    };
    expect(Schema.decodeUnknownSync(PreviewMutationResultSchema)(mutation)).toEqual(mutation);
    expect(() =>
      Schema.decodeUnknownSync(PreviewDiagnosticsSnapshotSchema)({ registry: {} }),
    ).toThrow();
  });
});

describe("previewsClient", () => {
  it("is listed with adapters 1 and 0", () => {
    expect(DOMAIN_CLIENTS).toContain(previewsClient);
    expect(previewsClient.versions).toEqual([1, 0]);
  });

  function fakeNode(domains: Record<string, { min: number; max: number }> | null) {
    const typed: Array<{ command: string; args: unknown; envelope?: ContractEnvelopeFields }> = [];
    const untyped: Array<{ command: string; args: unknown }> = [];
    const answer = (command: string): unknown =>
      command === "revoke_preview_access"
        ? { revoked: 1, extra: "dropped by the decoder" }
        : { released: true };
    const client = createDomainClient(previewsClient, {
      domains,
      call: async (def, args, envelope) => {
        typed.push({ command: def.name, args, ...(envelope ? { envelope } : {}) });
        return answer(def.name);
      },
      invoke: async (command, args) => {
        untyped.push({ command, args });
        return answer(command);
      },
    });
    return { client, typed, untyped };
  }

  it("version 1 sends the envelope with the critical keys and decodes the result", async () => {
    const node = fakeNode({ previews: { min: 1, max: 1 } });
    expect(node.client.version()).toBe(1);
    const result = await node.client.api().revokeAccess({ serviceId: "svc_1" });
    expect(result).toEqual({ revoked: 1 });
    expect(node.typed).toEqual([
      {
        command: "revoke_preview_access",
        args: { serviceId: "svc_1" },
        envelope: { domain: "previews", version: 1, critical: ["serviceId"] },
      },
    ]);
    expect(node.untyped).toEqual([]);
  });

  it("version 0 makes today's untyped call, without an envelope or decoding", async () => {
    const node = fakeNode(null);
    expect(node.client.version()).toBe(0);
    const result = await node.client.api().revokeAccess({ serviceId: "svc_1" });
    expect(result).toEqual({ revoked: 1, extra: "dropped by the decoder" } as never);
    expect(node.untyped).toEqual([
      { command: "revoke_preview_access", args: { serviceId: "svc_1" } },
    ]);
    expect(node.typed).toEqual([]);
  });

  it("a node outside the range refuses with the coded unsupported-version", () => {
    const node = fakeNode({ previews: { min: 2, max: 3 } });
    expect(() => node.client.api()).toThrow();
  });
});
