/**
 * The `design` domain (plan item 7004): every command defined once with the
 * keys its handler reads, the routing read class, tolerant decoding, and the
 * client's version-1 and legacy adapters against fakes.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { isNodeReadCommand } from "../../../command-nodes.js";
import type { NegotiatedDomains } from "../../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { decodeCommandArgs, decodeCommandResult, type AnyCommandDef } from "../../command.js";
import {
  DESIGN_COMMANDS,
  DESIGN_CONTRACT_CAPABILITIES,
  DESIGN_LEGACY_COMMANDS,
  DesignLibraryQuerySchema,
  DesignSessionLinkInputSchema,
  designClient,
  designSessionResumeCommand,
  designSnapshotCommand,
  designSyncCommand,
} from "./index.js";

/** The keys each handler reads (2026-11-07), from `apps/backend/src/core/design/commands.ts`. */
const KEYS: Record<string, readonly string[]> = {
  design_action: ["environmentId", "action", "input"],
  design_import: ["environmentId", "document"],
  design_import_host_file: ["environmentId", "path"],
  design_capabilities: [],
  design_readiness: ["probe"],
  design_snapshot: ["environmentId", "canvasId"],
  design_sync: ["environmentId", "canvasId", "generation", "after", "statusVersion"],
  design_prepare: ["environmentId", "descriptor"],
  design_execute: ["environmentId", "canvasId", "token", "waitMs"],
  design_operation_status: ["environmentId", "canvasId", "token"],
  design_cancel: ["environmentId", "canvasId", "token"],
  design_intents: ["environmentId", "canvasId"],
  design_intent_save: ["environmentId", "canvasId", "clientId", "drafts"],
  design_intent_import: ["environmentId", "canvasId", "clientId", "intents"],
  design_intent_run: ["environmentId", "canvasId", "intent", "waitMs"],
  design_intent_resume: ["environmentId", "canvasId", "intentId", "clientId", "rebaseTo"],
  design_intent_discard: ["environmentId", "canvasId", "intentId"],
  design_library: ["environmentId", "query"],
  design_purge: ["environmentId", "canvasId"],
  design_history: ["environmentId", "canvasId", "offset", "limit"],
  design_checkpoint: ["environmentId", "canvasId", "entryId", "side"],
  design_export_preview: ["environmentId", "canvasId", "relativePath"],
  design_export_save: [
    "environmentId",
    "canvasId",
    "relativePath",
    "revision",
    "replaceFingerprint",
  ],
  design_open_file: ["environmentId", "relativePath"],
  design_export_reconcile: ["environmentId", "canvasId"],
  design_validate: ["environmentId", "canvasId", "frameId"],
  design_hierarchy: [
    "environmentId",
    "canvasId",
    "frameId",
    "rootSelector",
    "cursor",
    "maxNodes",
    "maxDepth",
  ],
  design_capture: ["environmentId", "canvasId", "frameId", "priority"],
  design_session_link: ["environmentId", "canvasId", "link", "replaceId"],
  design_session_link_states: ["environmentId", "canvasId"],
  design_session_resume: ["environmentId", "canvasId", "linkId", "expectedTabId", "tabId"],
  design_session_unlink: ["environmentId", "canvasId", "linkId"],
};

const CANVAS = "00000000-0000-4000-8000-00000000c001";
const ALL: readonly AnyCommandDef[] = DESIGN_COMMANDS;

describe("design definitions", () => {
  it("define the 32 design commands once each, since version 1 of the domain", () => {
    expect(ALL.map((def) => def.name).sort()).toEqual(Object.keys(KEYS).sort());
    expect(new Set(ALL.map((def) => def.name)).size).toBe(32);
    for (const def of ALL) {
      expect([def.since, def.domain.version, def.domain.min, def.access]).toEqual([
        1,
        2,
        1,
        "workspace",
      ]);
    }
  });

  it.each(ALL.map((def) => [def.name, def] as const))(
    "%s declares the keys its handler reads, and its read class",
    (name, def) => {
      expect(Object.keys(def.args.fields).sort()).toEqual([...KEYS[name]!].sort());
      expect(def.read).toBe(isNodeReadCommand(name));
    },
  );

  it("marks only the session resume's tab compare-and-set critical", () => {
    const critical = Object.fromEntries(
      ALL.filter((def) => def.critical.length > 0).map((def) => [def.name, def.critical]),
    );
    expect(critical).toEqual({ design_session_resume: ["expectedTabId"] });
  });

  it("decode tolerantly: an unknown key is dropped, never refused (§11.4)", () => {
    for (const def of ALL) {
      const args =
        def.name === "design_action"
          ? { environmentId: "e", action: "list_canvases", fromANewerPeer: true }
          : def.name === "design_import"
            ? { environmentId: "e", document: "{}", fromANewerPeer: true }
            : def.name === "design_import_host_file"
              ? { environmentId: "e", path: "/a.orkdes", fromANewerPeer: true }
              : { fromANewerPeer: true };
      const decoded = decodeCommandArgs(def, args);
      expect(decoded._tag).toBe("Success");
      if (decoded._tag === "Success" && Object.keys(def.args.fields).length > 0) {
        expect(decoded.success).not.toHaveProperty("fromANewerPeer");
      }
    }
  });

  it("v2 arguments are left to the handler, so a wrong value stays inside the envelope", () => {
    expect(decodeCommandArgs(designSnapshotCommand, { canvasId: 42 })._tag).toBe("Success");
    expect(decodeCommandArgs(designSyncCommand, { after: "x" })._tag).toBe("Success");
  });

  it("legacy arguments are precise: a wrong value is refused as before", () => {
    for (const def of DESIGN_LEGACY_COMMANDS) {
      expect(decodeCommandArgs(def, { environmentId: 7 })._tag).toBe("Failure");
    }
  });

  it("the formerly strict nested objects strip unknown keys", () => {
    expect(Schema.decodeUnknownSync(DesignLibraryQuerySchema)({ search: "a", future: 1 })).toEqual({
      search: "a",
    });
    expect(
      Schema.decodeUnknownSync(DesignSessionLinkInputSchema)({
        tabId: "t",
        platform: "codex",
        role: "design",
        future: true,
      }),
    ).toEqual({ tabId: "t", platform: "codex", role: "design" });
  });

  it("v2 results are typed envelopes; model records keep keys they do not declare", () => {
    const missing = {
      ok: true,
      value: { kind: "missing", responseVersion: 1, generation: "g", canvasId: CANVAS, extra: 1 },
    };
    expect(decodeCommandResult(designSnapshotCommand, missing)).toMatchObject({
      _tag: "Success",
      success: missing,
    });
    const failure = {
      ok: false,
      failure: { code: "not-found", message: "Environment not found", retry: "never" },
    };
    expect(decodeCommandResult(designSnapshotCommand, failure)._tag).toBe("Success");
    expect(decodeCommandResult(designSnapshotCommand, { value: 1 })._tag).toBe("Failure");
    expect(
      decodeCommandResult(designSnapshotCommand, {
        ok: true,
        value: { kind: "nonsense", generation: "g" },
      })._tag,
    ).toBe("Failure");
  });
});

interface Sent {
  command: string;
  args: unknown;
  envelope: ContractEnvelopeFields | undefined;
}

const CAPABILITIES = {
  protocolVersion: 2,
  responseVersion: 1,
  snapshot: true,
  operations: true,
  sync: true,
  save: true,
  history: true,
  lifecycle: true,
  rendererHealth: true,
  library: true,
  batch: true,
  sessions: true,
  validation: true,
  hierarchyPaging: true,
};

function fakeNode(domains: NegotiatedDomains | undefined, answer: (command: string) => unknown) {
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

const resume = {
  environmentId: "env-1",
  canvasId: CANVAS,
  linkId: "l1",
  expectedTabId: "old",
  tabId: "new",
};

describe("design client", () => {
  it("version 2: envelopes, decoded results, and every capability folded into the domain", async () => {
    const node = fakeNode({ design: { min: 1, max: 2 } }, (command) =>
      command === "design_capabilities"
        ? { ok: true, value: { ...CAPABILITIES, sessions: false } }
        : {
            ok: false,
            failure: { code: "not-found", message: "Link not found", retry: "never" },
          },
    );
    const client = createDomainClient(designClient, node.options);
    expect(client.version()).toBe(2);
    const design = client.api();
    expect(await design.capabilities()).toEqual({
      ok: true,
      value: { ...CAPABILITIES, ...DESIGN_CONTRACT_CAPABILITIES },
    });
    expect(await design.command(designSessionResumeCommand, resume)).toMatchObject({
      ok: false,
      failure: { code: "not-found" },
    });
    expect(node.sent).toEqual([
      {
        command: "design_capabilities",
        args: {},
        envelope: { domain: "design", version: 2 },
      },
      {
        command: "design_session_resume",
        args: resume,
        envelope: { domain: "design", version: 2, critical: ["expectedTabId"] },
      },
    ]);
    expect(node.invoked).toEqual([]);
    expect(node.usage).toEqual([]);
  });

  it("version 1 refuses a result that is not the command's shape", async () => {
    const node = fakeNode({ design: { min: 1, max: 1 } }, () => ({ value: "?" }));
    const design = createDomainClient(designClient, node.options).api();
    await expect(
      design.command(designSnapshotCommand, { environmentId: "e", canvasId: CANVAS }),
    ).rejects.toThrow("Invalid result from design_snapshot");
  });

  it("version 0: today's calls by name, answers as sent, today's capability flags, counted", async () => {
    // An older backend's answer: no `intents` flag and a field this build does not know.
    const older = { ok: true as const, value: { ...CAPABILITIES, legacyOnly: 1 } };
    const node = fakeNode(undefined, (command) =>
      command === "design_capabilities" ? older : { anything: "goes" },
    );
    const client = createDomainClient(designClient, node.options);
    expect(client.version()).toBe(0);
    const design = client.api();
    expect(await design.capabilities()).toEqual(older);
    expect(
      await design.command(designSnapshotCommand, { environmentId: "e", canvasId: CANVAS }),
    ).toEqual({ anything: "goes" } as never);
    expect(node.sent).toEqual([]);
    expect(node.invoked).toEqual([
      { command: "design_capabilities", args: {} },
      { command: "design_snapshot", args: { environmentId: "e", canvasId: CANVAS } },
    ]);
    expect(node.usage).toEqual([
      ["design", 0],
      ["design", 0],
    ]);
  });
});
