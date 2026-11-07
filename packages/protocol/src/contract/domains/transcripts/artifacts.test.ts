/**
 * The transcript artifact and media commands of the `transcripts` domain
 * (plan item 7004): every command defined once with the keys its handler
 * read, the routing classifier's read class, the critical keys, tolerant
 * decoding, and the client's two adapters against a fake node.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { isNodeReadCommand } from "../../../command-nodes.js";
import { TRANSCRIPT_ARTIFACT_COMMANDS } from "../../../transcript-artifact-commands.js";
import { TRANSCRIPT_MEDIA_PIN_COMMAND } from "../../../transcript-media-pins.js";
import { createDomainClient, type ContractEnvelopeFields } from "../../client.js";
import { DOMAIN_CLIENTS } from "../../client-adapters.js";
import { decodeCommandArgs } from "../../command.js";
import {
  ArtifactDraftListSchema,
  MermaidRenderResponseSchema,
  TRANSCRIPT_ARTIFACT_DEFINITIONS,
  transcriptMediaPinCommand,
  transcriptsClient,
} from "./index.js";

const SCOPE = ["environmentId", "logicalSessionKey"];

/** The keys each handler read before it was defined (2026-11-07). */
const HANDLER_KEYS: Record<string, readonly string[]> = {
  transcript_artifact_capabilities: [],
  transcript_artifact_get_publication: [...SCOPE, "publicationId"],
  transcript_artifact_list_publications: [...SCOPE, "afterSequence", "limit"],
  transcript_artifact_read_representation: [
    ...SCOPE,
    "publicationId",
    "representation",
    "paper",
    "captureIndex",
    "sourceRange",
  ],
  transcript_artifact_open_live_session: [...SCOPE, "publicationId"],
  transcript_artifact_close_live_session: ["generation"],
  transcript_artifact_render_mermaid: ["source", "theme"],
  transcript_artifact_workflow_live_snapshot: ["environmentId", "workflowId", "runId"],
  transcript_artifact_list_drafts: [...SCOPE, "limit"],
  transcript_artifact_read_draft: [
    ...SCOPE,
    "artifactId",
    "representation",
    "revision",
    "operationId",
    "captureIndex",
    "sourceRange",
  ],
  transcript_artifact_stage_asset: [...SCOPE, "name", "mimeType", "dataBase64"],
  transcript_media_open_stream: ["environmentId", "path", "containerId"],
  transcript_media_close_stream: ["streamId"],
  transcript_media_pdf_preview: ["environmentId", "source"],
  transcript_artifact_prepare_worker: [],
  // The strict handler's ARGUMENTS list.
  transcript_media_pin: [...SCOPE, "messageId", "path", "containerId"],
};

describe("transcript artifact definitions", () => {
  it("define every artifact and media command once, in version 1", () => {
    const names = TRANSCRIPT_ARTIFACT_DEFINITIONS.map((def): string => def.name).sort();
    expect(names).toEqual(Object.keys(HANDLER_KEYS).sort());
    expect(names).toEqual(
      [...Object.values(TRANSCRIPT_ARTIFACT_COMMANDS), TRANSCRIPT_MEDIA_PIN_COMMAND].sort(),
    );
    for (const def of TRANSCRIPT_ARTIFACT_DEFINITIONS) {
      expect(def.since).toBe(1);
      expect(def.access).toBe("workspace");
      expect([def.domain.name, def.domain.version, def.domain.min]).toEqual(["transcripts", 1, 1]);
    }
  });

  it.each(TRANSCRIPT_ARTIFACT_DEFINITIONS.map((def) => [def.name, def] as const))(
    "%s declares the keys its handler read, and its read class",
    (name, def) => {
      expect(Object.keys(def.args.fields).sort()).toEqual([...HANDLER_KEYS[name]!].sort());
      expect(def.read).toBe(isNodeReadCommand(name));
    },
  );

  it("marks the media reads' container critical", () => {
    const critical = Object.fromEntries(
      TRANSCRIPT_ARTIFACT_DEFINITIONS.filter((def) => def.critical.length > 0).map((def) => [
        def.name,
        def.critical,
      ]),
    );
    expect(critical).toEqual({
      transcript_media_open_stream: ["containerId"],
      transcript_media_pin: ["containerId"],
    });
  });

  it("decode tolerantly: the formerly strict media pin drops an unknown key", () => {
    for (const def of TRANSCRIPT_ARTIFACT_DEFINITIONS) {
      expect(decodeCommandArgs(def, { fromANewerPeer: true })._tag).toBe("Success");
    }
    const decoded = decodeCommandArgs(transcriptMediaPinCommand, {
      environmentId: "e",
      logicalSessionKey: "k",
      messageId: "m",
      path: "/a.png",
      extra: 1,
    });
    expect(decoded._tag === "Success" && Object.keys(decoded.success).sort()).toEqual([
      "environmentId",
      "logicalSessionKey",
      "messageId",
      "path",
    ]);
  });

  it("result schemas describe both Mermaid outcomes and the draft list", () => {
    const failed = {
      ok: false as const,
      error: { code: "invalid_input", message: "bad", retryClass: "never", line: 2 },
    };
    expect(Schema.decodeUnknownSync(MermaidRenderResponseSchema)(failed)).toEqual(failed as never);
    expect(() => Schema.decodeUnknownSync(ArtifactDraftListSchema)([])).toThrow();
  });
});

describe("transcriptsClient (artifact part)", () => {
  it("is listed with adapters 1 and 0", () => {
    expect(DOMAIN_CLIENTS).toContain(transcriptsClient);
    expect(transcriptsClient.versions).toEqual([1, 0]);
  });

  function fakeNode(domains: Record<string, { min: number; max: number }> | null) {
    const typed: Array<{ command: string; args: unknown; envelope?: ContractEnvelopeFields }> = [];
    const untyped: Array<{ command: string; args: unknown }> = [];
    const answer = {
      url: "https://content.test/m/1",
      mimeType: "video/mp4",
      byteLength: 10,
      expiresAt: "2026-11-07T00:00:00.000Z",
      streamId: "s1",
      older: "not decoded on 0",
    };
    const client = createDomainClient(transcriptsClient, {
      domains,
      call: async (def, args, envelope) => {
        typed.push({ command: def.name, args, ...(envelope ? { envelope } : {}) });
        return answer;
      },
      invoke: async (command, args) => {
        untyped.push({ command, args });
        return answer;
      },
    });
    return { client, typed, untyped };
  }

  const request = { environmentId: "e", path: "/workspace/a.mp4", containerId: "c1" };

  it("version 1 sends the envelope with the critical container and decodes the result", async () => {
    const node = fakeNode({ transcripts: { min: 1, max: 1 } });
    const result = await node.client.api().openMediaStream(request);
    expect(result).not.toHaveProperty("older");
    expect(node.typed).toEqual([
      {
        command: "transcript_media_open_stream",
        args: request,
        envelope: { domain: "transcripts", version: 1, critical: ["containerId"] },
      },
    ]);
  });

  it("version 0 makes today's untyped call, without an envelope or decoding", async () => {
    const node = fakeNode(null);
    const result = await node.client.api().openMediaStream(request);
    expect(result).toHaveProperty("older");
    expect(node.untyped).toEqual([{ command: "transcript_media_open_stream", args: request }]);
    expect(node.typed).toEqual([]);
  });
});
