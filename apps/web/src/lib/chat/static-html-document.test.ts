import { beforeEach, describe, expect, mock, test } from "bun:test";
import { STATIC_PRESENTATION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { sha256Bytes } from "@orkestrator/protocol/graphs/sha256";
import {
  TRANSCRIPT_ARTIFACT_COMMANDS,
  type ArtifactRepresentationRequest,
  type ArtifactRepresentationResponse,
} from "@orkestrator/protocol/transcript-artifact-commands";
import * as backend from "@/lib/backend";
import { invoke } from "@/lib/native/backend";
import {
  StaleArtifactScopeError,
  clearArtifactRequestCache,
  noteArtifactScopeGeneration,
} from "./artifact-requests";
import {
  StaticDocumentError,
  readVerifiedEffectiveHtml,
  sha256HexOfBytes,
} from "./static-html-document";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const REF = { artifactId: "art_abcdefgh1", revision: 2, publicationId: "pub_abcdefgh1" };
const SCOPE = {
  backendId: "backend-1",
  environmentId: "env-1",
  logicalSessionKey: "session-1",
  generation: "g1",
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hashOf(text: string): string {
  return hex(sha256Bytes(new TextEncoder().encode(text)));
}

/** Slices at UTF-8 boundaries the way the backend does, and always names the whole-document hash. */
function page(
  text: string,
  range?: { offsetBytes: number; limitBytes: number },
  overrides: Partial<ArtifactRepresentationResponse> = {},
): ArtifactRepresentationResponse {
  const bytes = new TextEncoder().encode(text);
  const offset = range?.offsetBytes ?? 0;
  let end = Math.min(bytes.length, offset + (range?.limitBytes ?? bytes.length));
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    artifactId: REF.artifactId,
    revision: REF.revision,
    representation: "effective-html",
    mimeType: "text/html; charset=utf-8",
    filename: "report.html",
    encoding: "utf8",
    data: new TextDecoder().decode(bytes.subarray(offset, end)),
    sha256: hashOf(text),
    byteLength: end - offset,
    totalBytes: bytes.length,
    nextOffsetBytes: end < bytes.length ? end : null,
    executableOutsideOrkestrator: true,
    ...overrides,
  };
}

function serve(
  respond: (request: ArtifactRepresentationRequest) => ArtifactRepresentationResponse,
): void {
  invokeMock.mockImplementation((command: string, args: { request?: unknown }) => {
    if (command !== TRANSCRIPT_ARTIFACT_COMMANDS.readRepresentation)
      return Promise.reject(new Error(`Unexpected ${command}`));
    return Promise.resolve(respond((args.request ?? args) as ArtifactRepresentationRequest));
  });
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StaticDocumentError) return error.code;
    throw error;
  }
  throw new Error("Expected the read to be refused");
}

beforeEach(() => {
  clearArtifactRequestCache();
  invokeMock.mockReset();
});

describe("readVerifiedEffectiveHtml", () => {
  test("assembles a multi-page non-ASCII document and verifies its bytes", async () => {
    // Multi-byte characters straddle every page boundary.
    const html = `<!doctype html><p>${"Käse — 日本語 🧀 ".repeat(800)}</p>`;
    const limits: number[] = [];
    serve((request) => {
      expect(request.representation).toBe("effective-html");
      limits.push(request.sourceRange?.limitBytes ?? -1);
      return page(html, {
        offsetBytes: request.sourceRange?.offsetBytes ?? 0,
        limitBytes: Math.min(4 * 1024, request.sourceRange?.limitBytes ?? 4 * 1024),
      });
    });
    const document = await readVerifiedEffectiveHtml(backend, SCOPE, REF, hashOf(html));
    expect(document.html).toBe(html);
    expect(document.byteLength).toBe(new TextEncoder().encode(html).byteLength);
    expect(document.sha256).toBe(hashOf(html));
    expect(limits.length).toBeGreaterThan(2);
  });

  test("a response claiming completion with too few bytes is incomplete", async () => {
    const html = "<p>Whole document</p>";
    serve(() => page(html, undefined, { data: "<p>Who" }));
    expect(await failure(readVerifiedEffectiveHtml(backend, SCOPE, REF, hashOf(html)))).toBe(
      "static_incomplete",
    );
  });

  test("a partial result with a next offset still set is never a document", async () => {
    const html = "<p>Whole document</p>";
    const budget = STATIC_PRESENTATION_POLICY.maxDocumentBytes;
    // The loader stops at its budget and hands back what it has, offset included.
    serve(() =>
      page(html, undefined, { byteLength: budget, totalBytes: budget, nextOffsetBytes: budget }),
    );
    expect(await failure(readVerifiedEffectiveHtml(backend, SCOPE, REF, hashOf(html)))).toBe(
      "static_incomplete",
    );
  });

  test("a read that stops advancing is refused rather than looping", async () => {
    const html = "<p>Whole document</p>";
    serve(() => page(html, undefined, { data: "<p>", byteLength: 3, nextOffsetBytes: 3 }));
    await expect(readVerifiedEffectiveHtml(backend, SCOPE, REF, hashOf(html))).rejects.toThrow(
      "did not advance",
    );
  });

  test("a hash change between pages is refused", async () => {
    const html = `<p>${"x".repeat(9_000)}</p>`;
    let calls = 0;
    serve((request) => {
      calls++;
      const range = {
        offsetBytes: request.sourceRange?.offsetBytes ?? 0,
        limitBytes: 4_096,
      };
      return calls === 1 ? page(html, range) : page(html, range, { sha256: "e".repeat(64) });
    });
    await expect(readVerifiedEffectiveHtml(backend, SCOPE, REF, hashOf(html))).rejects.toThrow(
      "changed while it was being read",
    );
  });

  test("a revision or artifact change between pages is refused", async () => {
    const html = `<p>${"x".repeat(9_000)}</p>`;
    for (const change of [{ revision: 3 }, { artifactId: "art_other00001" }]) {
      let calls = 0;
      serve((request) => {
        calls++;
        const range = {
          offsetBytes: request.sourceRange?.offsetBytes ?? 0,
          limitBytes: 4_096,
        };
        return calls === 1 ? page(html, range) : page(html, range, change);
      });
      await expect(readVerifiedEffectiveHtml(backend, SCOPE, REF, hashOf(html))).rejects.toThrow(
        "changed while it was being read",
      );
    }
  });

  test("the wrong artifact, revision or representation is an identity failure", async () => {
    const html = "<p>Report</p>";
    for (const overrides of [
      { artifactId: "art_other00001" },
      { revision: 3 },
      { representation: "source" as const },
    ]) {
      serve(() => page(html, undefined, overrides));
      expect(await failure(readVerifiedEffectiveHtml(backend, SCOPE, REF, hashOf(html)))).toBe(
        "static_identity",
      );
    }
  });

  test("a representation hash other than the receipt's is an integrity failure", async () => {
    const html = "<p>Report</p>";
    serve(() => page(html));
    expect(await failure(readVerifiedEffectiveHtml(backend, SCOPE, REF, "b".repeat(64)))).toBe(
      "static_integrity",
    );
  });

  test("bytes that do not hash to what the response and receipt both claim are refused", async () => {
    const claimed = "<p>Report one</p>";
    const received = "<p>Report two</p>";
    serve(() => page(received, undefined, { sha256: hashOf(claimed) }));
    expect(await failure(readVerifiedEffectiveHtml(backend, SCOPE, REF, hashOf(claimed)))).toBe(
      "static_integrity",
    );
  });

  test("a document over the display budget is refused without reading the rest", async () => {
    const html = `<p>${"x".repeat(STATIC_PRESENTATION_POLICY.maxDocumentBytes + 10)}</p>`;
    const requests: Array<ArtifactRepresentationRequest["sourceRange"]> = [];
    serve((request) => {
      requests.push(request.sourceRange);
      return page(html, request.sourceRange);
    });
    expect(await failure(readVerifiedEffectiveHtml(backend, SCOPE, REF, hashOf(html)))).toBe(
      "static_over_budget",
    );
    expect(requests).toEqual([
      { offsetBytes: 0, limitBytes: STATIC_PRESENTATION_POLICY.maxDocumentBytes },
    ]);
  });

  test("a document exactly at the budget is accepted", async () => {
    const prefix = "<p>";
    const suffix = "</p>";
    const html = `${prefix}${"x".repeat(
      STATIC_PRESENTATION_POLICY.maxDocumentBytes - prefix.length - suffix.length,
    )}${suffix}`;
    serve((request) => page(html, request.sourceRange));
    const document = await readVerifiedEffectiveHtml(backend, SCOPE, REF, hashOf(html));
    expect(document.byteLength).toBe(STATIC_PRESENTATION_POLICY.maxDocumentBytes);
  });

  test("an answer that finishes after the generation changed never settles", async () => {
    const html = "<p>Report</p>";
    let release: (value: ArtifactRepresentationResponse) => void = () => {};
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    noteArtifactScopeGeneration(SCOPE);
    const read = readVerifiedEffectiveHtml(backend, SCOPE, REF, hashOf(html));
    await Bun.sleep(0);
    noteArtifactScopeGeneration({ ...SCOPE, generation: "g2" });
    release(page(html));
    await expect(read).rejects.toBeInstanceOf(StaleArtifactScopeError);
  });
});

describe("sha256HexOfBytes", () => {
  const bytes = new TextEncoder().encode("Käse 🧀");
  const expected = hex(sha256Bytes(bytes));

  test("Web Crypto and the pure helper agree", async () => {
    expect(await sha256HexOfBytes(bytes)).toBe(expected);
  });

  test("falls back when Web Crypto is absent, as on a plain-HTTP gateway", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      expect(await sha256HexOfBytes(bytes)).toBe(expected);
    } finally {
      if (original) Object.defineProperty(globalThis, "crypto", original);
    }
  });
});
