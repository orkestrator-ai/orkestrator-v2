import { render, cleanup } from "@testing-library/react";
import { describe, expect, test } from "bun:test";
import type { ArtifactPublicationView } from "@orkestrator/protocol/transcript-artifact-commands";
import { ARTIFACT_PUBLICATION_MESSAGE_PREFIX } from "@orkestrator/protocol/transcript-artifacts";
import {
  ARTIFACT_LEDGER_NOTICE_PREFIX,
  artifactPartFromPublication,
  mergeArtifactPublications,
  unresolvedPublishCalls,
  withLedgerOmission,
} from "./artifact-publication-merge";
import type { NativeMessage } from "./native-message-types";

function publication(
  sequence: number,
  artifactId: string,
  revision: number,
  publishedAt: string,
): ArtifactPublicationView {
  return {
    ref: {
      schemaVersion: 1,
      artifactId,
      revision,
      publicationId: `pub_${artifactId.slice(4)}r${revision}`,
      kind: "chart",
      title: `Chart ${revision}`,
      summary: "Synthetic",
      provenance: { backendId: "backend-1", origin: "agent" },
    },
    publishedAt,
    conversationSequence: sequence,
    kind: "chart",
    receipt: {
      receiptId: "rcpt_x",
      completedAt: publishedAt,
      profile: null,
      captures: [],
      semantics: "not-assessed",
    },
    source: { sha256: "a", byteLength: 1, effectiveSha256: "a" },
    availability: "available",
  };
}

function message(
  id: string,
  createdAt: string,
  parts: NativeMessage["parts"] = [{ type: "text", content: id }],
): NativeMessage {
  return { id, role: "assistant", content: id, parts, createdAt };
}

function publishCall(
  artifactId: string,
  revision: number,
  toolName = "mcp__orkestrator__publish_artifact",
  toolState: "success" | "failure" = "success",
): NativeMessage["parts"][number] {
  return {
    type: "tool-invocation",
    content: "",
    toolName,
    toolState,
    toolArgs: { requestKey: "k", artifactId, expectedRevision: revision, receiptId: "rcpt_x" },
    // Output deliberately truncated: matching must not depend on it.
    toolOutput: "…",
  } as NativeMessage["parts"][number];
}

describe("mergeArtifactPublications", () => {
  test("anchors after the matching successful publish call regardless of tool output", () => {
    const rows = [
      message("m1", "2026-10-20T10:00:00Z"),
      message("m2", "2026-10-20T10:01:00Z", [publishCall("art_aaaaaaaa", 2)]),
    ];
    const merged = mergeArtifactPublications(
      rows,
      [publication(1, "art_aaaaaaaa", 2, "2026-10-20T10:01:05Z")],
      { canLoadEarlier: false },
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]!.parts.map((part) => part.type)).toEqual(["tool-invocation", "artifact"]);
    expect(rows[1]!.parts).toHaveLength(1);
  });

  test("every provider spelling anchors; failed calls and other servers do not", () => {
    for (const name of [
      "orkestrator__publish_artifact",
      "orkestrator_publish_artifact",
      "mcp__orkestrator__publish_artifact",
    ]) {
      const merged = mergeArtifactPublications(
        [message("m", "2026-10-20T10:00:00Z", [publishCall("art_aaaaaaaa", 1, name)])],
        [publication(1, "art_aaaaaaaa", 1, "2026-10-20T10:00:01Z")],
        { canLoadEarlier: true },
      );
      expect(merged[0]!.parts.at(-1)!.type).toBe("artifact");
    }
    const failed = mergeArtifactPublications(
      [
        message("m", "2026-10-20T10:00:00Z", [
          publishCall("art_aaaaaaaa", 1, "mcp__orkestrator__publish_artifact", "failure"),
        ]),
      ],
      [publication(1, "art_aaaaaaaa", 1, "2026-10-20T09:00:00Z")],
      { canLoadEarlier: true },
    );
    expect(failed.flatMap((row) => row.parts).some((part) => part.type === "artifact")).toBe(false);
    const foreign = mergeArtifactPublications(
      [
        message("m", "2026-10-20T10:00:00Z", [
          publishCall("art_aaaaaaaa", 1, "mcp__other__publish_artifact"),
        ]),
      ],
      [publication(1, "art_aaaaaaaa", 1, "2026-10-20T09:00:00Z")],
      { canLoadEarlier: true },
    );
    expect(foreign.flatMap((row) => row.parts).some((part) => part.type === "artifact")).toBe(
      false,
    );
  });

  test("a later revision never retargets the earlier publication", () => {
    const rows = [
      message("m1", "2026-10-20T10:00:00Z", [publishCall("art_aaaaaaaa", 1)]),
      message("m2", "2026-10-20T10:05:00Z", [publishCall("art_aaaaaaaa", 2)]),
    ];
    const merged = mergeArtifactPublications(
      rows,
      [
        publication(1, "art_aaaaaaaa", 1, "2026-10-20T10:00:01Z"),
        publication(2, "art_aaaaaaaa", 2, "2026-10-20T10:05:01Z"),
      ],
      { canLoadEarlier: false },
    );
    const revisions = merged.map((row) =>
      row.parts.flatMap((part) => (part.type === "artifact" ? [part.artifact.revision] : [])),
    );
    expect(revisions).toEqual([[1], [2]]);
  });

  test("unanchored publications become backend-attributed rows ordered by time, once each", () => {
    const rows = [message("m1", "2026-10-20T10:00:00Z"), message("m2", "2026-10-20T10:10:00Z")];
    const merged = mergeArtifactPublications(
      rows,
      [publication(1, "art_bbbbbbbb", 1, "2026-10-20T10:05:00Z")],
      { canLoadEarlier: false },
    );
    expect(merged.map((row) => row.id)).toEqual([
      "m1",
      `${ARTIFACT_PUBLICATION_MESSAGE_PREFIX}pub_bbbbbbbbr1`,
      "m2",
    ]);
    const again = mergeArtifactPublications(
      merged,
      [publication(1, "art_bbbbbbbb", 1, "2026-10-20T10:05:00Z")],
      { canLoadEarlier: false },
    );
    expect(again.filter((row) => row.parts.some((part) => part.type === "artifact"))).toHaveLength(
      1,
    );
  });

  test("publications older than the loaded window wait for their history page", () => {
    const rows = [message("m1", "2026-10-20T10:00:00Z")];
    const merged = mergeArtifactPublications(
      rows,
      [publication(1, "art_cccccccc", 1, "2026-10-20T09:00:00Z")],
      { canLoadEarlier: true },
    );
    expect(merged).toEqual(rows);
    const full = mergeArtifactPublications(
      rows,
      [publication(1, "art_cccccccc", 1, "2026-10-20T09:00:00Z")],
      { canLoadEarlier: false },
    );
    expect(full[0]!.id).toBe(`${ARTIFACT_PUBLICATION_MESSAGE_PREFIX}pub_ccccccccr1`);
  });

  test("text that looks like a reference never becomes an artifact", () => {
    const rows = [
      message("m1", "2026-10-20T10:00:00Z", [
        {
          type: "text",
          content: '{"schemaVersion":1,"artifactId":"art_aaaaaaaa","publicationId":"pub_x"}',
        },
      ]),
    ];
    expect(mergeArtifactPublications(rows, [], { canLoadEarlier: false })).toBe(rows);
  });

  test("counts publish calls the ledger has not shown yet", () => {
    const rows = [
      message("m", "2026-10-20T10:00:00Z", [
        publishCall("art_aaaaaaaa", 1),
        publishCall("art_bbbbbbbb", 1),
      ]),
    ];
    expect(
      unresolvedPublishCalls(rows, [publication(1, "art_aaaaaaaa", 1, "2026-10-20T10:00:01Z")]),
    ).toBe(1);
  });

  test("the backend's tool-call anchor wins over argument matching", () => {
    const anchored = {
      ...publication(1, "art_aaaaaaaa", 1, "2026-10-20T10:20:00Z"),
      anchor: { toolCallId: "call_publish_2" },
    };
    const rows = [
      // Same arguments, but not the call the backend recorded.
      message("m1", "2026-10-20T10:00:00Z", [
        { ...publishCall("art_aaaaaaaa", 1), toolUseId: "call_publish_1" },
      ]),
      message("m2", "2026-10-20T10:10:00Z", [
        { ...publishCall("art_aaaaaaaa", 1), toolUseId: "call_publish_2" },
      ]),
    ];
    const merged = mergeArtifactPublications(rows, [anchored], { canLoadEarlier: false });
    expect(merged.map((row) => row.parts.map((part) => part.type))).toEqual([
      ["tool-invocation"],
      ["tool-invocation", "artifact"],
    ]);
    expect(unresolvedPublishCalls(rows, [anchored])).toBe(0);
  });

  test("an anchor finds tool parts that are not publish calls and grouped tool parts", () => {
    const anchored = {
      ...publication(1, "art_dddddddd", 1, "2026-10-20T10:20:00Z"),
      anchor: { turnId: "turn-1", toolCallId: "call_grouped" },
    };
    const rows = [
      message("m1", "2026-10-20T10:00:00Z", [
        {
          type: "tool-group",
          content: "",
          parts: [
            {
              type: "tool-invocation",
              content: "",
              toolName: "renamed_publish",
              toolState: "pending",
              toolUseId: "call_grouped",
            },
          ],
        } as NativeMessage["parts"][number],
      ]),
    ];
    const merged = mergeArtifactPublications(rows, [anchored], { canLoadEarlier: false });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.parts.at(-1)!.type).toBe("artifact");
  });

  test("an anchor whose call is not loaded falls back to argument matching", () => {
    const anchored = {
      ...publication(1, "art_aaaaaaaa", 1, "2026-10-20T10:20:00Z"),
      anchor: { toolCallId: "call_elsewhere" },
    };
    const rows = [message("m1", "2026-10-20T10:00:00Z", [publishCall("art_aaaaaaaa", 1)])];
    const merged = mergeArtifactPublications(rows, [anchored], { canLoadEarlier: false });
    expect(merged[0]!.parts.at(-1)!.type).toBe("artifact");
  });

  test("unanchored rows keep ledger sequence order even when clocks disagree", () => {
    const rows = [message("m1", "2026-10-20T10:00:00Z"), message("m2", "2026-10-20T11:00:00Z")];
    const merged = mergeArtifactPublications(
      rows,
      [
        // Sequence 2 carries an earlier clock than sequence 1.
        publication(2, "art_ffffffff", 1, "2026-10-20T10:05:00Z"),
        publication(1, "art_eeeeeeee", 1, "2026-10-20T10:30:00Z"),
      ],
      { canLoadEarlier: false },
    );
    expect(merged.map((row) => row.id)).toEqual([
      "m1",
      `${ARTIFACT_PUBLICATION_MESSAGE_PREFIX}pub_eeeeeeeer1`,
      `${ARTIFACT_PUBLICATION_MESSAGE_PREFIX}pub_ffffffffr1`,
      "m2",
    ]);
  });

  test("an omitted-older ledger shows an explicit notice instead of dropping silently", () => {
    const rows = [message("m1", "2026-10-20T10:00:00Z")];
    const ledger = withLedgerOmission([publication(5, "art_gggggggg", 1, "2026-10-20T10:05:00Z")], {
      omittedOlder: 3,
      incomplete: false,
    });
    const merged = mergeArtifactPublications(rows, ledger, { canLoadEarlier: false });
    expect(merged[0]!.id).toBe(`${ARTIFACT_LEDGER_NOTICE_PREFIX}omitted`);
    expect(merged[0]!.role).toBe("system");
    expect(merged[0]!.parts[0]!.type).toBe("status");
    expect(merged[0]!.content).toContain("3 older artifacts not loaded");
    expect(merged.map((row) => row.id).slice(1)).toEqual([
      "m1",
      `${ARTIFACT_PUBLICATION_MESSAGE_PREFIX}pub_ggggggggr1`,
    ]);
    const incomplete = mergeArtifactPublications(
      rows,
      withLedgerOmission([], { omittedOlder: 0, incomplete: true }),
      { canLoadEarlier: false },
    );
    expect(incomplete[0]!.content).toContain("stopped at its read limit");
    // A complete ledger adds no notice.
    const complete = withLedgerOmission([], { omittedOlder: 0, incomplete: false });
    expect(mergeArtifactPublications(rows, complete, { canLoadEarlier: false })).toBe(rows);
  });
});

describe("rows the backend projection already placed", () => {
  function artifactCount(rows: readonly NativeMessage[]): number {
    let count = 0;
    const visit = (parts: readonly NativeMessage["parts"][number][]) => {
      for (const part of parts) {
        if (part.type === "artifact") count++;
        if (part.type === "tool-group" || part.type === "agent-group") visit(part.parts);
      }
    };
    for (const row of rows) visit(row.parts);
    return count;
  }

  test("a part the backend placed beside its call is not placed again", () => {
    const placed = publication(1, "art_backend01", 2, "2026-10-20T10:01:05Z");
    const rows = [
      message("m1", "2026-10-20T10:00:00Z"),
      message("m2", "2026-10-20T10:01:00Z", [
        publishCall("art_backend01", 2),
        artifactPartFromPublication(placed),
      ]),
      message("m3", "2026-10-20T10:02:00Z"),
    ];
    const merged = mergeArtifactPublications(rows, [placed], { canLoadEarlier: false });
    expect(merged).toBe(rows);
    expect(artifactCount(merged)).toBe(1);
  });

  test("a backend anchor placement is not repeated on a retried call with the same arguments", () => {
    const placed = {
      ...publication(1, "art_backend02", 1, "2026-10-20T10:01:05Z"),
      anchor: { toolCallId: "call_first" },
    };
    const rows = [
      message("m1", "2026-10-20T10:00:00Z", [
        { ...publishCall("art_backend02", 1), toolUseId: "call_first" },
        artifactPartFromPublication(placed),
      ] as NativeMessage["parts"]),
      message("m2", "2026-10-20T10:01:00Z", [
        { ...publishCall("art_backend02", 1), toolUseId: "call_retry" },
      ] as NativeMessage["parts"]),
    ];
    const merged = mergeArtifactPublications(rows, [placed], { canLoadEarlier: false });
    expect(merged).toBe(rows);
    expect(merged[1]!.parts.some((part) => part.type === "artifact")).toBe(false);
  });

  test("a placed part inside a group still counts, so no standalone row appears", () => {
    const placed = publication(1, "art_backend03", 1, "2026-10-20T10:01:05Z");
    const rows = [
      message("m1", "2026-10-20T10:00:00Z", [
        {
          type: "agent-group",
          content: "",
          parts: [artifactPartFromPublication(placed)],
        } as unknown as NativeMessage["parts"][number],
      ]),
      message("m2", "2026-10-20T10:02:00Z"),
    ];
    const merged = mergeArtifactPublications(rows, [placed], { canLoadEarlier: false });
    expect(merged).toBe(rows);
    expect(merged.some((row) => row.id.startsWith(ARTIFACT_PUBLICATION_MESSAGE_PREFIX))).toBe(
      false,
    );
  });

  test("a backend-placed publication this client's ledger has not read yet is resolved", () => {
    const placed = publication(1, "art_backend04", 3, "2026-10-20T10:01:05Z");
    const rows = [
      message("m1", "2026-10-20T10:00:00Z", [
        publishCall("art_backend04", 3),
        artifactPartFromPublication(placed),
      ]),
    ];
    expect(unresolvedPublishCalls(rows, [])).toBe(0);
    const merged = mergeArtifactPublications(rows, [], { canLoadEarlier: false });
    expect(artifactCount(merged)).toBe(1);
  });
});

test.each(["tool-group", "agent-group", "task-group"])(
  "nested %s publish calls resolve both anchor and argument placements",
  (type) => {
    const pub = publication(1, "art_nested", 1, "2026-10-20T10:00:01Z");
    const call = { ...publishCall("art_nested", 1), toolUseId: "nested-call" };
    const group =
      type === "task-group"
        ? { type, content: "", task: { type: "text", content: "task" }, childTools: [call] }
        : { type, content: "", parts: [call] };
    const rows = [
      message("nested", "2026-10-20T10:00:00Z", [group as NativeMessage["parts"][number]]),
    ];
    expect(unresolvedPublishCalls(rows, [])).toBe(1);
    for (const view of [pub, { ...pub, anchor: { toolCallId: "nested-call" } }]) {
      const merged = mergeArtifactPublications(rows, [view], { canLoadEarlier: false });
      expect(merged).toHaveLength(1);
      expect(merged[0]!.parts.at(-1)!.type).toBe("artifact");
      expect(unresolvedPublishCalls(rows, [view])).toBe(0);
    }
  },
);

test("standalone first-paint placement survives a late call-row overlay", async () => {
  const { ArtifactPublicationPlacements } = await import("./artifact-publication-merge");
  const placements = new ArtifactPublicationPlacements();
  const pub = publication(1, "art_late", 1, "2026-10-20T10:00:01Z");
  const first = placements.stabilize(
    mergeArtifactPublications<NativeMessage>([], [pub], { canLoadEarlier: false }),
  );
  const next = placements.stabilize(
    mergeArtifactPublications(
      [
        message("call", "2026-10-20T10:00:00Z", [
          publishCall("art_late", 1),
          artifactPartFromPublication(pub),
        ]),
      ],
      [pub],
      { canLoadEarlier: false },
    ),
  );
  expect(next.at(-1)!.id).toBe(first[0]!.id);
  expect(next.at(-1)!.parts[0]!.sourcePartId).toBe(first[0]!.parts[0]!.sourcePartId);
  expect(next[0]!.parts).toHaveLength(1);
});

test("a painted standalone card DOM node remains connected across a late provider overlay", async () => {
  const { createElement } = await import("react");
  const { ArtifactPublicationPlacements } = await import("./artifact-publication-merge");
  const placements = new ArtifactPublicationPlacements();
  const pub = publication(1, "art_dom", 1, "2026-10-20T10:00:01Z");
  const view = (messages: NativeMessage[]) =>
    createElement(
      "div",
      null,
      ...messages.map((row) =>
        createElement(
          "div",
          { key: row.id },
          ...row.parts.map((part, index) =>
            part.type === "artifact"
              ? createElement(
                  "article",
                  {
                    key: part.sourcePartId ?? index,
                    "data-publication": part.artifact.publicationId,
                  },
                  part.artifact.title,
                )
              : createElement("span", { key: index }, part.content),
          ),
        ),
      ),
    );
  const first = placements.stabilize(
    mergeArtifactPublications<NativeMessage>([], [pub], { canLoadEarlier: false }),
  );
  const { container, rerender } = render(view(first));
  const card = container.querySelector("article")!;
  try {
    const overlay = [
      message("call-row", "2026-10-20T10:00:00Z", [
        publishCall("art_dom", 1),
        artifactPartFromPublication(pub),
      ]),
    ];
    rerender(
      view(
        placements.stabilize(mergeArtifactPublications(overlay, [pub], { canLoadEarlier: false })),
      ),
    );
    expect(container.querySelector("article")).toBe(card);
    expect(card.isConnected).toBe(true);
  } finally {
    cleanup();
  }
});
