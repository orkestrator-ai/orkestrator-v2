import { afterEach, describe, expect, mock, test } from "bun:test";
import { STATIC_PRESENTATION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type {
  ArtifactRepresentationRequest,
  ArtifactRepresentationResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import type {
  ArtifactKind,
  TranscriptArtifactRef,
} from "@orkestrator/protocol/transcript-artifacts";
import {
  cachedArtifactSearchBody,
  clearArtifactRequestCache,
  noteArtifactScopeGeneration,
  rememberArtifactSearchBody,
} from "@/lib/chat/artifact-requests";
import {
  STATIC_DOCUMENT_INDEX_POLICY,
  StaticDocumentIndexSession,
  loadStaticDocumentSearchBody,
  staticDocumentRefs,
} from "./static-document-search-index";

/*
 * Find reads the text the worker stored for a static document no card has
 * reported (5780 task 2). These pin what reaches Find's body cache, and what
 * never does.
 */

const BACKEND = "backend-1";
const SCOPE = {
  backendId: BACKEND,
  environmentId: "env-1",
  logicalSessionKey: "session-1",
  generation: "gen-1",
};

function refOf(index: number, kind: ArtifactKind = "html-static", backendId = BACKEND) {
  const id = String(index).padStart(8, "0");
  return {
    schemaVersion: 1,
    artifactId: `art_${id}`,
    revision: 1,
    publicationId: `pub_${id}`,
    kind,
    title: "Report",
    summary: "A report",
    provenance: { backendId, origin: "agent" },
  } as TranscriptArtifactRef;
}

function response(
  ref: TranscriptArtifactRef,
  data: string,
  overrides: Partial<ArtifactRepresentationResponse> = {},
): ArtifactRepresentationResponse {
  const byteLength = new TextEncoder().encode(data).byteLength;
  return {
    artifactId: ref.artifactId,
    revision: ref.revision,
    representation: "search-text",
    mimeType: "text/plain; charset=utf-8",
    filename: "report.txt",
    encoding: "utf8",
    data,
    sha256: "0".repeat(64),
    byteLength,
    totalBytes: byteLength,
    nextOffsetBytes: null,
    executableOutsideOrkestrator: false,
    ...overrides,
  };
}

function readerOf(answer: (request: ArtifactRepresentationRequest) => Promise<unknown>) {
  const read = mock(answer);
  return {
    read,
    reader: {
      readTranscriptArtifactRepresentation: read as unknown as (
        request: ArtifactRepresentationRequest,
      ) => Promise<ArtifactRepresentationResponse>,
    },
  };
}

afterEach(() => {
  clearArtifactRequestCache();
});

describe("loading one document's stored text", () => {
  test("stores the text where the card's frame would have", async () => {
    const ref = refOf(1);
    const { reader, read } = readerOf(async () => response(ref, "Quarterly report\nRevenue"));
    expect(await loadStaticDocumentSearchBody(reader, SCOPE, ref)).toBe("stored");
    expect(cachedArtifactSearchBody(ref)).toBe("Quarterly report\nRevenue");
    expect(read.mock.calls[0]![0]).toMatchObject({
      environmentId: SCOPE.environmentId,
      logicalSessionKey: SCOPE.logicalSessionKey,
      publicationId: ref.publicationId,
      representation: "search-text",
      sourceRange: { offsetBytes: 0, limitBytes: STATIC_DOCUMENT_INDEX_POLICY.maxBytes },
    });
  });

  test("keeps text a frame already reported and does not read", async () => {
    const ref = refOf(2);
    rememberArtifactSearchBody(ref, "framed", SCOPE);
    const { reader, read } = readerOf(async () => response(ref, "stored"));
    expect(await loadStaticDocumentSearchBody(reader, SCOPE, ref)).toBe("skipped");
    expect(read).not.toHaveBeenCalled();
    expect(cachedArtifactSearchBody(ref)).toBe("framed");
  });

  test("a frame reporting while the read is in flight wins", async () => {
    const ref = refOf(3);
    const { reader } = readerOf(async () => {
      rememberArtifactSearchBody(ref, "framed", SCOPE);
      return response(ref, "stored");
    });
    expect(await loadStaticDocumentSearchBody(reader, SCOPE, ref)).toBe("skipped");
    expect(cachedArtifactSearchBody(ref)).toBe("framed");
  });

  test("a clear of protected content during the read is never undone", async () => {
    const ref = refOf(4);
    const { reader } = readerOf(async () => {
      clearArtifactRequestCache();
      return response(ref, "stored");
    });
    expect(await loadStaticDocumentSearchBody(reader, SCOPE, ref)).toBe("skipped");
    expect(cachedArtifactSearchBody(ref)).toBeNull();
  });

  test("a newer session generation discards the answer", async () => {
    const ref = refOf(5);
    const { reader } = readerOf(async () => {
      noteArtifactScopeGeneration({ ...SCOPE, generation: "gen-2" });
      return response(ref, "stored");
    });
    expect(await loadStaticDocumentSearchBody(reader, SCOPE, ref)).toBe("skipped");
    expect(cachedArtifactSearchBody(ref)).toBeNull();
  });

  test("an older backend, an older publication or a mismatched answer stores nothing", async () => {
    const ref = refOf(6);
    const cases: Array<() => Promise<unknown>> = [
      async () => {
        throw Object.assign(new Error("Unknown representation"), { code: "invalid_input" });
      },
      async () => response(ref, "x", { representation: "effective-html" }),
      async () => response(ref, "<p>x</p>", { mimeType: "text/html; charset=utf-8" }),
      async () => response(ref, "x", { revision: 2 }),
      async () => response(ref, "x", { artifactId: "art_other000" }),
      async () => response(ref, "x", { encoding: "base64" }),
      async () => response(ref, "x", { nextOffsetBytes: 1 }),
      async () => response(ref, "x".repeat(STATIC_PRESENTATION_POLICY.maxSearchTextCharacters + 1)),
      async () => response(ref, ""),
    ];
    for (const answer of cases) {
      const { reader } = readerOf(answer);
      expect(await loadStaticDocumentSearchBody(reader, SCOPE, ref)).toBe("unavailable");
      expect(cachedArtifactSearchBody(ref)).toBeNull();
    }
  });
});

describe("one Find session's reads", () => {
  async function settle() {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  }

  test("reads each document once, two at a time, up to the session's limit", async () => {
    const releases: Array<() => void> = [];
    let peak = 0;
    let running = 0;
    const load = mock(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running -= 1;
      return "stored" as const;
    });
    const session = new StaticDocumentIndexSession(
      "k",
      { readTranscriptArtifactRepresentation: mock() as never },
      SCOPE,
      load,
    );
    const refs = Array.from(
      { length: STATIC_DOCUMENT_INDEX_POLICY.maxDocumentsPerSession + 5 },
      (_, index) => refOf(index),
    );
    session.offer(refs);
    session.offer(refs.slice(0, 3));
    expect(session.pending()).toEqual({
      running: 2,
      queued: STATIC_DOCUMENT_INDEX_POLICY.maxDocumentsPerSession - 2,
      offered: STATIC_DOCUMENT_INDEX_POLICY.maxDocumentsPerSession,
    });
    while (releases.length > 0) {
      releases.shift()!();
      await settle();
    }
    expect(load).toHaveBeenCalledTimes(STATIC_DOCUMENT_INDEX_POLICY.maxDocumentsPerSession);
    expect(peak).toBe(STATIC_DOCUMENT_INDEX_POLICY.concurrency);
    expect(new Set(load.mock.calls.map((call) => (call as unknown[])[2]))).toHaveProperty(
      "size",
      STATIC_DOCUMENT_INDEX_POLICY.maxDocumentsPerSession,
    );
  });

  test("stop drops the queue; a stopped session takes nothing more", async () => {
    const releases: Array<() => void> = [];
    const load = mock(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return "stored" as const;
    });
    const session = new StaticDocumentIndexSession(
      "k",
      { readTranscriptArtifactRepresentation: mock() as never },
      SCOPE,
      load,
    );
    session.offer([refOf(1), refOf(2), refOf(3), refOf(4)]);
    session.stop();
    session.offer([refOf(5)]);
    while (releases.length > 0) {
      releases.shift()!();
      await settle();
    }
    expect(load).toHaveBeenCalledTimes(2);
    expect(session.pending()).toMatchObject({ running: 0, queued: 0 });
  });

  test("skips documents whose text is already cached", () => {
    const load = mock(async () => "stored" as const);
    const session = new StaticDocumentIndexSession(
      "k",
      { readTranscriptArtifactRepresentation: mock() as never },
      SCOPE,
      load,
    );
    rememberArtifactSearchBody(refOf(1), "framed", SCOPE);
    session.offer([refOf(1), refOf(2)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect((load.mock.calls[0] as unknown[])[2]).toMatchObject({
      publicationId: refOf(2).publicationId,
    });
  });
});

describe("which documents are read", () => {
  test("only supported static documents this connection published", () => {
    const items = [
      [refOf(1), refOf(2, "chart"), { not: "a ref" }],
      [refOf(3, "html-static", "backend-2"), refOf(4, "html-interactive"), refOf(5)],
    ];
    expect(
      staticDocumentRefs(items, (item) => item, BACKEND).map((ref) => ref.publicationId),
    ).toEqual([refOf(1).publicationId, refOf(5).publicationId]);
  });
});
