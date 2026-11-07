/**
 * The `web-annotations` domain (plan item 7004): the definitions keep the
 * argument keys of the strict Zod schema map they replace, classify reads as
 * the routing classifier does, decode tolerantly, keep refusing a declared
 * provenance, and the client sends the envelope only to a node with the
 * domain.
 */
import { describe, expect, it } from "bun:test";
import { isNodeReadCommand } from "../../../command-nodes.js";
import type { NegotiatedDomains } from "../../../node-client.js";
import {
  fixtureCaptureInput,
  fixtureDestination,
} from "../../../testing/web-annotations-fixtures.js";
import { WEB_ANNOTATION_COMMANDS } from "../../../web-annotations.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { DOMAIN_CLIENTS } from "../../client-adapters.js";
import { decodeCommandArgs, decodeCommandResult, type AnyCommandDef } from "../../command.js";
import {
  WEB_ANNOTATIONS_COMMANDS,
  webAnnotationCreateCommand,
  webAnnotationsClient,
} from "./index.js";

/** The keys of the strict Zod schemas the handlers parsed before (2026-11-07). */
const FORMER_KEYS: Record<string, readonly string[]> = {
  web_annotations_capabilities: ["environmentId"],
  web_annotations_list: ["environmentId", "filter", "cursor", "limit"],
  web_annotations_changes: ["environmentId", "generation", "after"],
  web_annotation_get: ["environmentId", "annotationId", "entryLimit", "entryWindow"],
  web_annotation_entries: [
    "environmentId",
    "annotationId",
    "afterSequence",
    "beforeSequence",
    "limit",
  ],
  web_annotation_capture: ["environmentId", "captureId"],
  web_annotation_draft_get: ["environmentId", "editorId"],
  web_annotation_draft_save: [
    "environmentId",
    "editorId",
    "expectedRevision",
    "text",
    "annotationId",
    "captureId",
    "pendingCaptureId",
    "operation",
    "destination",
  ],
  web_annotation_draft_delete: ["environmentId", "editorId", "expectedRevision"],
  web_annotation_create: ["environmentId", "operationId", "capture", "body", "title", "draftId"],
  web_annotation_operation_receipt: ["environmentId", "operationId"],
  web_annotation_entry_append: [
    "environmentId",
    "operationId",
    "annotationId",
    "expectedContentRevision",
    "body",
    "editorId",
  ],
  web_annotation_entry_edit: [
    "environmentId",
    "operationId",
    "annotationId",
    "entryId",
    "expectedContentRevision",
    "body",
  ],
  web_annotation_update: [
    "environmentId",
    "operationId",
    "annotationId",
    "expectedMetadataRevision",
    "title",
    "defaultDestination",
    "hidden",
  ],
  web_annotation_capture_replace: [
    "environmentId",
    "operationId",
    "annotationId",
    "expectedContentRevision",
    "capture",
    "body",
  ],
  web_annotation_resolve: [
    "environmentId",
    "operationId",
    "annotationId",
    "expectedContentRevision",
    "expectedCaptureId",
    "requestId",
    "resultId",
    "expectedResultRevision",
    "note",
  ],
  web_annotation_reopen: [
    "environmentId",
    "operationId",
    "annotationId",
    "expectedMetadataRevision",
    "body",
  ],
  web_annotation_delete: [
    "environmentId",
    "operationId",
    "annotationId",
    "expectedMetadataRevision",
  ],
  web_annotation_asset_stage: ["environmentId", "operationId", "mediaType", "data"],
  web_annotation_asset_get: ["environmentId", "assetId"],
  web_annotation_destinations: ["environmentId"],
  web_annotation_request_prepare: [
    "environmentId",
    "operation",
    "destination",
    "annotations",
    "instruction",
    "textOnly",
    "followUpOf",
    "retargetOf",
  ],
  web_annotation_request_send: ["environmentId", "preparationId", "requestId", "bodyHash"],
  web_annotation_request_get: ["environmentId", "requestId"],
  web_annotation_requests: ["environmentId", "annotationId", "activeOnly"],
  web_annotation_request_cancel: ["environmentId", "requestId", "expectedRevision"],
  web_annotation_request_recover: ["environmentId", "requestId", "action"],
  web_annotation_request_response: ["environmentId", "requestId"],
  web_annotation_request_follow_up: ["environmentId", "requestId"],
  web_annotation_result_capture: [
    "environmentId",
    "operationId",
    "requestId",
    "annotationId",
    "capture",
    "zoomFactor",
    "deviceScaleFactor",
    "scroll",
    "stability",
    "masks",
    "targetResolution",
  ],
  web_annotations_migrate: ["environmentId"],
  web_annotations_migration_status: ["environmentId"],
  web_annotation_archive: [
    "environmentId",
    "operationId",
    "annotationId",
    "expectedMetadataRevision",
    "title",
    "body",
  ],
  web_annotations_reconcile_draft: ["environmentId", "value"],
  web_annotations_rollout: [],
  web_annotations_rollout_set: ["mode"],
  web_annotations_metrics: [],
};

/** The handlers that called `assertNoDeclaredProvenance(args)` before. */
const REFUSES_PROVENANCE = [
  "web_annotation_create",
  "web_annotation_entry_append",
  "web_annotation_entry_edit",
  "web_annotation_capture_replace",
  "web_annotation_reopen",
  "web_annotation_request_prepare",
  "web_annotation_result_capture",
  "web_annotation_archive",
];

const ALL: readonly AnyCommandDef[] = WEB_ANNOTATIONS_COMMANDS;

const createArgs = {
  environmentId: "env-a",
  operationId: "op-1",
  capture: fixtureCaptureInput(),
  body: "Make it roomier",
};

const receipt = {
  operationId: "op-1",
  annotationId: "a-1",
  captureId: "c-1",
  entryId: "e-1",
  contentRevision: 1,
  metadataRevision: 1,
  captureRevision: 1,
  environmentRevision: 3,
  newerField: { kept: true },
};

describe("web-annotations definitions", () => {
  it("cover every web annotation command once, each in version 1 of the domain", () => {
    expect(ALL.map((def) => def.name).sort()).toEqual(
      Object.values(WEB_ANNOTATION_COMMANDS).sort(),
    );
    expect(Object.keys(FORMER_KEYS).sort()).toEqual(ALL.map((def) => def.name).sort());
    for (const def of ALL) {
      expect({ name: def.name, since: def.since, version: def.domain.version }).toEqual({
        name: def.name,
        since: 1,
        version: 1,
      });
      expect(def.domain.min).toBe(1);
    }
  });

  it.each(ALL.map((def) => [def.name, def] as const))(
    "%s declares the keys its strict schema accepted, and its read class",
    (name, def) => {
      const expected = [
        ...FORMER_KEYS[name]!,
        ...(REFUSES_PROVENANCE.includes(name) ? ["provenance"] : []),
      ].sort();
      expect(Object.keys(def.args.fields).sort()).toEqual(expected);
      expect(def.read).toBe(isNodeReadCommand(name));
    },
  );

  it("admits only the rollout switch as administration", () => {
    const admin = ALL.filter((def) => def.access === "admin").map((def) => def.name);
    expect(admin).toEqual(["web_annotations_rollout_set"]);
    expect(ALL.every((def) => def.access === "admin" || def.access === "workspace")).toBe(true);
  });

  it("marks the result guard, text-only and retarget critical", () => {
    const critical = Object.fromEntries(
      ALL.filter((def) => def.critical.length > 0).map((def) => [def.name, def.critical]),
    );
    expect(critical).toEqual({
      web_annotation_resolve: ["expectedResultRevision"],
      web_annotation_request_prepare: ["textOnly", "retargetOf"],
    });
  });

  it("decodes tolerantly: an unknown key is dropped, never refused (§11.4)", () => {
    const decoded = decodeCommandArgs(webAnnotationCreateCommand, {
      ...createArgs,
      fromANewerPeer: true,
    });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") {
      expect(decoded.success).not.toHaveProperty("fromANewerPeer");
      expect(decoded.success.body).toBe("Make it roomier");
    }
  });

  it("keeps refusing a declared provenance, at the top and inside a capture", () => {
    const top = decodeCommandArgs(webAnnotationCreateCommand, {
      ...createArgs,
      provenance: "host-user",
    });
    expect(top._tag).toBe("Failure");
    expect(top._tag === "Failure" && top.failure.message).toContain(
      "Provenance is assigned by the receiver",
    );
    const nested = decodeCommandArgs(webAnnotationCreateCommand, {
      ...createArgs,
      capture: { ...fixtureCaptureInput(), provenance: "host-user" },
    });
    expect(nested._tag === "Failure" && nested.failure.message).toContain("Provenance");
  });

  it("keeps the bounds: ids, revisions, destinations and request sizes", () => {
    const prepare = ALL.find((def) => def.name === "web_annotation_request_prepare")!;
    const selection = { annotationId: "a1", expectedContentRevision: 1, expectedCaptureId: "c1" };
    const base = {
      environmentId: "env-a",
      operation: "implement",
      destination: fixtureDestination,
      annotations: [selection],
      instruction: "",
    };
    expect(decodeCommandArgs(prepare, base)._tag).toBe("Success");
    expect(
      decodeCommandArgs(prepare, { ...base, annotations: Array(21).fill(selection) })._tag,
    ).toBe("Failure");
    expect(
      decodeCommandArgs(prepare, { ...base, destination: { ...fixtureDestination, tabId: "" } })
        ._tag,
    ).toBe("Failure");
    expect(decodeCommandArgs(prepare, { ...base, environmentId: "../escape" })._tag).toBe(
      "Failure",
    );
    expect(
      decodeCommandArgs(webAnnotationCreateCommand, { ...createArgs, operationId: "x".repeat(201) })
        ._tag,
    ).toBe("Failure");
  });

  it("passes undeclared record fields through when a result is decoded", () => {
    const decoded = decodeCommandResult(webAnnotationCreateCommand, receipt);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).toEqual(receipt);
    expect(
      decodeCommandResult(webAnnotationCreateCommand, { ...receipt, contentRevision: "1" })._tag,
    ).toBe("Failure");
  });
});

describe("web-annotations client", () => {
  function node(domains: NegotiatedDomains | null, answer: unknown) {
    const calls: { command: string; args: unknown; envelope?: ContractEnvelopeFields }[] = [];
    const legacy: { command: string; args: unknown }[] = [];
    const client = createDomainClient(webAnnotationsClient, {
      call: async (def, args, envelope) => {
        calls.push({ command: def.name, args, ...(envelope ? { envelope } : {}) });
        return answer;
      },
      invoke: async (command, args) => {
        legacy.push({ command, args });
        return answer;
      },
      domains,
    });
    return { client, calls, legacy };
  }

  it("is listed once in the adapter list, with adapters 1 and 0", () => {
    expect(DOMAIN_CLIENTS.filter((def) => def.domain.name === "web-annotations")).toEqual([
      webAnnotationsClient,
    ]);
    expect(webAnnotationsClient.versions).toEqual([1, 0]);
  });

  it("version 1 sends the envelope with the critical keys present and decodes the result", async () => {
    const { client, calls, legacy } = node({ "web-annotations": { min: 1, max: 1 } }, receipt);
    const api = client.api();
    expect(api.version).toBe(1);
    const result = await api.run("web_annotation_resolve", {
      environmentId: "env-a",
      operationId: "op-1",
      annotationId: "a-1",
      expectedContentRevision: 1,
      expectedCaptureId: "c-1",
      expectedResultRevision: 2,
    });
    expect(result).toEqual(receipt);
    expect(legacy).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.envelope).toEqual({
      domain: "web-annotations",
      version: 1,
      critical: ["expectedResultRevision"],
    });
    const bad = node({ "web-annotations": { min: 1, max: 1 } }, { operationId: 1 });
    await expect(bad.client.api().run("web_annotation_create", createArgs)).rejects.toThrow(
      "Invalid result from web_annotation_create",
    );
  });

  it("version 0 is today's call: by name, no envelope, the answer as sent", async () => {
    const older = { contractVersion: 1, storage: "ready", olderShape: true };
    const { client, calls, legacy } = node(null, older);
    const api = client.api();
    expect(api.version).toBe(0);
    expect(await api.run("web_annotations_capabilities", { environmentId: "env-a" })).toEqual(
      older as never,
    );
    expect(calls).toEqual([]);
    expect(legacy).toEqual([
      { command: "web_annotations_capabilities", args: { environmentId: "env-a" } },
    ]);
  });
});
