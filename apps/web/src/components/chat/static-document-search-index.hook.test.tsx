import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  TRANSCRIPT_ARTIFACT_COMMANDS,
  type ArtifactPublicationView,
  type ArtifactRepresentationResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import {
  artifactPartContent,
  type TranscriptArtifactRef,
} from "@orkestrator/protocol/transcript-artifacts";
import { invoke } from "@/lib/native/backend";
import { resetTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import {
  cachedArtifactSearchBody,
  clearArtifactRequestCache,
  noteArtifactScopeGeneration,
} from "@/lib/chat/artifact-requests";
import {
  RichMessageContext,
  RichTranscriptScopeContext,
  richArtifactOccurrenceKey,
  type RichTranscriptScope,
} from "@/lib/chat/rich-identity";
import type { NativeArtifactPart } from "@/lib/chat/native-message-types";
import { useArtifactLiveHostStore } from "@/stores/artifactLiveHostStore";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { ArtifactPart } from "./rich/ArtifactPart";
import {
  StaticDocumentIndexSession,
  cardsShowDocument,
  loadStaticDocumentSearchBody,
  useStaticDocumentSearchIndex,
} from "./static-document-search-index";

/*
 * The React wiring of Find's static-document index (5780 task 2): when it
 * reads, which generation it reads for, and which cards it leaves alone
 * because they show something other than the document.
 */

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const BACKEND = "backend-1";

const SCOPE_A: RichTranscriptScope = {
  backendId: BACKEND,
  environmentId: "env-1",
  logicalSessionKey: "session-1",
  generation: "gen-a",
};
const SCOPE_B: RichTranscriptScope = { ...SCOPE_A, generation: "gen-b" };
const READ_SCOPE_A = { ...SCOPE_A, backendId: BACKEND };
const READ_SCOPE_B = { ...SCOPE_B, backendId: BACKEND };

const capabilities = {
  backendId: BACKEND,
  authoring: true,
  previewRenderer: { available: true, isolation: "container" },
  liveInteractive: true,
  contentOrigin: null,
  rolloutFlags: {
    richMarkdown: true,
    artifactPublication: true,
    liveInteractive: true,
    staticPresentation: true,
  },
};

function refOf(index: number): TranscriptArtifactRef {
  const id = String(index).padStart(8, "0");
  return {
    schemaVersion: 1,
    artifactId: `art_${id}`,
    revision: 1,
    publicationId: `pub_${id}`,
    kind: "html-static",
    title: "Report",
    summary: "A report",
    provenance: { backendId: BACKEND, origin: "agent" },
  } as TranscriptArtifactRef;
}

function textOf(ref: TranscriptArtifactRef, data: string): ArtifactRepresentationResponse {
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
  };
}

function viewOf(ref: TranscriptArtifactRef): ArtifactPublicationView {
  return {
    ref,
    publishedAt: "2026-10-20T10:00:00.000Z",
    conversationSequence: 1,
    kind: ref.kind,
    receipt: {
      receiptId: "rcpt_abcdefgh1",
      completedAt: "2026-10-20T09:59:00.000Z",
      profile: { theme: "light", viewport: { width: 960, height: 640, deviceScaleFactor: 1 } },
      captures: [
        {
          assetId: "asset_abcdefgh1",
          sha256: "c".repeat(64),
          width: 960,
          height: 640,
          byteLength: 10,
        },
      ],
      semantics: "not-assessed",
    },
    source: { sha256: "a".repeat(64), byteLength: 10, effectiveSha256: "b".repeat(64) },
    availability: "available",
  };
}

function partOf(ref: TranscriptArtifactRef): NativeArtifactPart {
  return {
    type: "artifact",
    content: artifactPartContent(ref),
    artifact: ref,
    publishedAt: "2026-10-20T10:00:00.000Z",
    conversationSequence: 1,
  };
}

/** Stored-text reads by publication, answered by `answer`. */
let answer: (ref: TranscriptArtifactRef) => Promise<unknown> = async () => undefined;
let reads: string[] = [];
const refsById = new Map<string, TranscriptArtifactRef>();

beforeEach(() => {
  resetTranscriptArtifactCapabilities();
  clearArtifactRequestCache();
  useRichContentViewStore.getState().reset();
  useArtifactLiveHostStore.getState().resetForTests();
  reads = [];
  refsById.clear();
  answer = async (ref) => textOf(ref, `Stored text of ${ref.publicationId}`);
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.capabilities) return Promise.resolve(capabilities);
    const ref = refsById.get(String(args.publicationId));
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.getPublication && ref)
      return Promise.resolve(viewOf(ref));
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation && ref) {
      if (args.representation === "search-text") {
        reads.push(ref.publicationId);
        return answer(ref);
      }
      if (args.representation === "source")
        return Promise.resolve({
          ...textOf(ref, "<p>source</p>"),
          representation: "source",
          mimeType: "text/html",
        });
      return Promise.reject(Object.assign(new Error("absent"), { code: "invalid_input" }));
    }
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
  clearArtifactRequestCache();
  useRichContentViewStore.getState().reset();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

async function flush() {
  await act(async () => {
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
  });
}

function register(...refs: TranscriptArtifactRef[]): TranscriptArtifactRef[] {
  for (const ref of refs) refsById.set(ref.publicationId, ref);
  return refs;
}

const identity = (item: TranscriptArtifactRef[]) => item;

function scoped(scope: RichTranscriptScope) {
  return ({ children }: { children: ReactNode }) => (
    <RichTranscriptScopeContext.Provider value={scope}>
      {children}
    </RichTranscriptScopeContext.Provider>
  );
}

function occurrenceKey(scope: RichTranscriptScope, messageId: string, ref: TranscriptArtifactRef) {
  return richArtifactOccurrenceKey(
    scope,
    messageId,
    ref.publicationId,
    ref.artifactId,
    ref.revision,
  );
}

describe("when the index reads", () => {
  test("only while Find is searching; closing it stops the session", async () => {
    const items = [register(refOf(1)), register(refOf(2))];
    const { rerender } = renderHook(
      ({ active }) => useStaticDocumentSearchIndex(items, identity, active),
      { wrapper: scoped(SCOPE_A), initialProps: { active: false } },
    );
    await flush();
    expect(reads).toEqual([]);

    rerender({ active: true });
    await flush();
    expect(reads.sort()).toEqual([refOf(1).publicationId, refOf(2).publicationId]);
    expect(cachedArtifactSearchBody(refOf(1))).toBe(`Stored text of ${refOf(1).publicationId}`);

    // Closing and reopening starts a new session; documents already cached are not read again.
    rerender({ active: false });
    rerender({ active: true });
    await flush();
    expect(reads).toHaveLength(2);
  });

  test("a transcript without artifact references reads nothing", async () => {
    const items = [register(refOf(1))];
    renderHook(() => useStaticDocumentSearchIndex(items, undefined, true), {
      wrapper: scoped(SCOPE_A),
    });
    await flush();
    expect(reads).toEqual([]);
  });

  test("a client that cannot show documents reads nothing", async () => {
    capabilities.rolloutFlags.staticPresentation = false;
    try {
      const items = [register(refOf(1))];
      renderHook(() => useStaticDocumentSearchIndex(items, identity, true), {
        wrapper: scoped(SCOPE_A),
      });
      await flush();
      expect(reads).toEqual([]);
    } finally {
      capabilities.rolloutFlags.staticPresentation = true;
    }
  });

  test("unmount drops what is queued", async () => {
    const releases: Array<() => void> = [];
    answer = (ref) => new Promise((resolve) => releases.push(() => resolve(textOf(ref, "stored"))));
    const items = [register(refOf(1), refOf(2), refOf(3), refOf(4))];
    const { unmount } = renderHook(() => useStaticDocumentSearchIndex(items, identity, true), {
      wrapper: scoped(SCOPE_A),
    });
    await flush();
    expect(reads).toHaveLength(2);
    unmount();
    while (releases.length > 0) {
      releases.shift()!();
      await flush();
    }
    expect(reads).toHaveLength(2);
  });
});

describe("which generation the index reads for", () => {
  test("a resumed conversation with every card offscreen stores its text, and the old one's late answer is dropped", async () => {
    // A card mounted under generation A recorded it; then every card scrolled away.
    noteArtifactScopeGeneration(READ_SCOPE_A);
    let releaseStale: () => void = () => {};
    const staleRead = mock(
      () =>
        new Promise<ArtifactRepresentationResponse>((resolve) => {
          releaseStale = () => resolve(textOf(refOf(1), "late from A"));
        }),
    );
    const stale = new StaticDocumentIndexSession(
      "a",
      { readTranscriptArtifactRepresentation: staleRead },
      READ_SCOPE_A,
    );
    stale.offer([refOf(1)]);
    await flush();
    expect(staleRead).toHaveBeenCalledTimes(1);

    answer = async (ref) => textOf(ref, "current from B");
    const items = [register(refOf(1), refOf(2))];
    renderHook(() => useStaticDocumentSearchIndex(items, identity, true), {
      wrapper: scoped(SCOPE_B),
    });
    await flush();
    expect(cachedArtifactSearchBody(refOf(2))).toBe("current from B");
    expect(cachedArtifactSearchBody(refOf(1))).toBe("current from B");

    // Generation A's answer arrives last and must not replace B's.
    releaseStale();
    await flush();
    expect(cachedArtifactSearchBody(refOf(1))).toBe("current from B");
  });

  test("starting a session records its generation even with no card mounted", async () => {
    noteArtifactScopeGeneration(READ_SCOPE_A);
    new StaticDocumentIndexSession(
      "b",
      { readTranscriptArtifactRepresentation: mock() as never },
      READ_SCOPE_B,
      mock(async () => "stored" as const),
    );
    const reader = {
      readTranscriptArtifactRepresentation: async (request: { publicationId: string }) =>
        textOf(refsById.get(request.publicationId)!, "text"),
    };
    register(refOf(9), refOf(10));
    expect(await loadStaticDocumentSearchBody(reader, READ_SCOPE_B, refOf(9))).toBe("stored");
    // The older generation is now fenced.
    expect(await loadStaticDocumentSearchBody(reader, READ_SCOPE_A, refOf(10))).not.toBe("stored");
    expect(cachedArtifactSearchBody(refOf(10))).toBeNull();
  });
});

describe("cards that are not showing the document", () => {
  test("a remembered Saved preview or Source choice keeps the document out of the index", async () => {
    const preview = refOf(1);
    const source = refOf(2);
    const shown = refOf(3);
    const items = [register(preview, source, shown)];
    const update = useRichContentViewStore.getState().update;
    update(occurrenceKey(SCOPE_A, "m1", preview), { view: "preview" });
    update(occurrenceKey(SCOPE_A, "m1", source), { view: "source" });
    update(occurrenceKey(SCOPE_A, "m1", shown), { view: "document" });
    // Another conversation's choice for the same publication does not count.
    update(occurrenceKey({ ...SCOPE_A, logicalSessionKey: "other" }, "m1", shown), {
      view: "source",
    });
    expect(cardsShowDocument(SCOPE_A, preview)).toBe(false);
    expect(cardsShowDocument(SCOPE_A, source)).toBe(false);
    expect(cardsShowDocument(SCOPE_A, shown)).toBe(true);

    renderHook(() => useStaticDocumentSearchIndex(items, identity, true), {
      wrapper: scoped(SCOPE_A),
    });
    await flush();
    expect(reads).toEqual([shown.publicationId]);
    expect(cachedArtifactSearchBody(preview)).toBeNull();
    expect(cachedArtifactSearchBody(source)).toBeNull();
  });

  test("a card switched off the document while its read is in flight stores nothing", async () => {
    const ref = refOf(1);
    let release: () => void = () => {};
    answer = (target) =>
      new Promise((resolve) => {
        release = () => resolve(textOf(target, "stored"));
      });
    const items = [register(ref)];
    renderHook(() => useStaticDocumentSearchIndex(items, identity, true), {
      wrapper: scoped(SCOPE_A),
    });
    await flush();
    expect(reads).toEqual([ref.publicationId]);
    act(() =>
      useRichContentViewStore.getState().update(occurrenceKey(SCOPE_A, "m1", ref), {
        view: "preview",
      }),
    );
    release();
    await flush();
    expect(cachedArtifactSearchBody(ref)).toBeNull();
  });

  test("a mounted card on Source shows no body root, and Find holds no body for it", async () => {
    const ref = refOf(1);
    register(ref);
    useRichContentViewStore.getState().update(occurrenceKey(SCOPE_A, "m1", ref), {
      view: "source",
    });
    function Transcript() {
      useStaticDocumentSearchIndex([[ref]], identity, true);
      return <ArtifactPart part={partOf(ref)} />;
    }
    const { container, unmount } = render(
      <RichTranscriptScopeContext.Provider value={SCOPE_A}>
        <RichMessageContext.Provider value={{ messageId: "m1", role: "assistant" }}>
          <Transcript />
        </RichMessageContext.Provider>
      </RichTranscriptScopeContext.Provider>,
    );
    await flush();
    expect(reads).toEqual([]);
    expect(cachedArtifactSearchBody(ref)).toBeNull();
    expect(container.querySelectorAll('[data-artifact-search-body="true"]')).toHaveLength(0);

    // Scrolled away and back: still nothing Find could count but not reveal.
    unmount();
    render(
      <RichTranscriptScopeContext.Provider value={SCOPE_A}>
        <RichMessageContext.Provider value={{ messageId: "m1", role: "assistant" }}>
          <Transcript />
        </RichMessageContext.Provider>
      </RichTranscriptScopeContext.Provider>,
    );
    await flush();
    expect(reads).toEqual([]);
    expect(cachedArtifactSearchBody(ref)).toBeNull();
  });
});
