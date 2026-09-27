import { describe, expect, test } from "bun:test";
import {
  BRIDGE_SUMMARY_INLINE_DETAIL_BYTES,
  bridgeTranscriptPage,
  bridgeTranscriptSummaryUpdate,
  isBridgeDetailLocator,
  parseBridgeTranscriptDetailResponse,
  parseBridgeTranscriptPageResponse,
  parseBridgeTranscriptSummaryUpdate,
  readBridgeTranscriptDetail,
  summarizeBridgeMessage,
  type BridgePartDetail,
} from "./bridge-transcript-summary.js";
import { bridgeTranscriptUpdate } from "./progressive-transcript.js";

interface Part {
  type: string;
  content: string;
  sourcePartId?: string;
  toolUseId?: string;
  toolOutput?: string;
  toolError?: string;
  toolDiff?: Record<string, unknown>;
  fileUrl?: string;
  filename?: string;
  childTools?: Part[];
}
interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: Part[];
  createdAt: string;
}

const big = (size: number, fill = "o") => fill.repeat(size);
const createdAt = "2026-09-27T00:00:00.000Z";

function message(id: string, parts: Part[] = [], content = `message ${id}`): Message {
  return { id, role: "assistant", content, parts, createdAt };
}

function tool(id: string, output: string, extra: Partial<Part> = {}): Part {
  return {
    type: "tool-invocation",
    content: "Read file",
    sourcePartId: `${id}:part`,
    toolUseId: id,
    toolOutput: output,
    ...extra,
  };
}

const options = {
  sessionIdentity: "session",
  generation: "g1",
  contentEpoch: 3,
  revision: 1,
  limit: 100,
  targetBytes: 512 * 1024,
  complete: true,
  pages: true,
};

function detailOf(part: unknown): BridgePartDetail | undefined {
  return (part as { detail?: BridgePartDetail }).detail;
}

describe("summaries", () => {
  test("move large bodies behind a locator and keep everything a collapsed row shows", () => {
    const summarized = summarizeBridgeMessage(
      message("m1", [
        tool("t1", big(64 * 1024), {
          toolError: "boom",
          toolDiff: { filePath: "a.ts", additions: 3, deletions: 1, diff: big(8192, "+") },
        }),
      ]),
    );
    const part = summarized.parts[0]! as Part & { detail?: BridgePartDetail };
    expect(part.toolOutput).toBeUndefined();
    expect(part.toolError).toBeUndefined();
    expect(part.toolDiff).toEqual({ filePath: "a.ts", additions: 3, deletions: 1, deferred: true });
    expect(part.content).toBe("Read file");
    expect(part.detail?.fields).toEqual(["toolOutput", "toolError", "toolDiff"]);
    expect(isBridgeDetailLocator(part.detail?.locator)).toBe(true);
  });

  test("keep small bodies inline and return an unchanged message by reference", () => {
    const light = message("m1", [tool("t1", "short")]);
    expect(summarizeBridgeMessage(light)).toBe(light);
    const edge = message("m2", [tool("t2", big(BRIDGE_SUMMARY_INLINE_DETAIL_BYTES - 64))]);
    expect(summarizeBridgeMessage(edge)).toBe(edge);
  });

  test("defer an inline image with no readable path, and drop one duplicated by a path", () => {
    const dataUrl = `data:image/png;base64,${big(20_000, "A")}`;
    const summarized = summarizeBridgeMessage(
      message("m1", [
        { type: "image", content: dataUrl, fileUrl: dataUrl, filename: "shot.png" },
        { type: "image", content: "/work/shot.png", fileUrl: dataUrl },
      ]),
    );
    const [inline, withPath] = summarized.parts as Array<Part & { detail?: BridgePartDetail }>;
    expect(inline!.fileUrl).toBeUndefined();
    expect(inline!.content).toBe("shot.png");
    expect(inline!.detail?.fields).toEqual(["fileDataUrl"]);
    expect(withPath!.fileUrl).toBeUndefined();
    expect(withPath!.detail).toBeUndefined();
  });

  test("summarize nested child tools with their own locators", () => {
    const summarized = summarizeBridgeMessage(
      message("m1", [
        {
          type: "tool-invocation",
          content: "Task",
          sourcePartId: "launch",
          childTools: [tool("child", big(10_000))],
        },
      ]),
    );
    const child = (summarized.parts[0] as Part).childTools![0]!;
    expect(child.toolOutput).toBeUndefined();
    expect(detailOf(child)).toBeDefined();
  });

  test("a large artifact no longer evicts earlier messages from the live window", () => {
    const history = [
      message("prompt", [], "the user's question"),
      message("m1", [tool("t1", big(900 * 1024))]),
      message("m2", [], "done"),
    ];
    // The raw v1 window drops the prompt to fit the tool result.
    const v1 = bridgeTranscriptUpdate(history, options);
    expect(v1.status === "snapshot" && v1.value.messages.map((m) => m.id)).not.toContain("prompt");
    const v2 = bridgeTranscriptSummaryUpdate(history, options);
    expect(v2.status).toBe("snapshot");
    if (v2.status !== "snapshot") return;
    expect(v2.value.messages.map((m) => (m as Message).id)).toEqual(["prompt", "m1", "m2"]);
    expect(Buffer.byteLength(JSON.stringify(v2.value.messages))).toBeLessThan(8 * 1024);
    expect(v2.value.complete).toBe(true);
    expect(v2.value.capabilities).toEqual({ details: true, pages: true });
  });

  test("an unchanged summary read with a revision touches no message", () => {
    let visits = 0;
    const history = Array.from({ length: 1_000 }, (_, index) => ({
      id: String(index),
      content: "x",
      get parts() {
        visits += 1;
        return [];
      },
    }));
    const first = bridgeTranscriptSummaryUpdate(history, options);
    visits = 0;
    const again = bridgeTranscriptSummaryUpdate(history, { ...options, knownToken: first.token });
    expect(again.status).toBe("unchanged");
    expect(visits).toBe(0);
  });

  test("v1 and v2 tokens never answer each other", () => {
    const history = [message("m1")];
    const v1 = bridgeTranscriptUpdate(history, options);
    const v2 = bridgeTranscriptSummaryUpdate(history, { ...options, knownToken: v1.token });
    expect(v2.status).toBe("snapshot");
  });

  test("an unchanged heavy part is not re-serialized on the next summary", () => {
    let serializations = 0;
    const diff = {
      filePath: "a.ts",
      diff: big(64 * 1024, "+"),
      toJSON() {
        serializations += 1;
        return { filePath: this.filePath, diff: this.diff };
      },
    };
    const history = [message("m1", [tool("t1", "", { toolDiff: diff })])];
    summarizeBridgeMessage(history[0]!);
    expect(serializations).toBe(1);
    summarizeBridgeMessage(history[0]!);
    summarizeBridgeMessage(history[0]!);
    expect(serializations).toBe(1);
    // Patching the diff in place is a change, and is measured again.
    diff.diff = big(64 * 1024, "-");
    summarizeBridgeMessage(history[0]!);
    expect(serializations).toBe(2);
  });
});

describe("detail reads", () => {
  function locatorFor(history: Message[], messageIndex = 0, partIndex = 0): string {
    const summary = summarizeBridgeMessage(history[messageIndex]!);
    return detailOf(summary.parts[partIndex])!.locator;
  }

  test("return exactly the body the summary described", () => {
    const output = big(10_000, "é");
    const history = [message("m1", [tool("t1", output, { toolError: "e" })])];
    const result = readBridgeTranscriptDetail(history, locatorFor(history));
    expect(result).toMatchObject({ status: "ok", detail: { toolOutput: output, toolError: "e" } });
  });

  test("report a changed body as expired rather than serving the new revision", () => {
    const history = [message("m1", [tool("t1", big(10_000))])];
    const locator = locatorFor(history);
    history[0]!.parts[0]!.toolOutput = big(10_001);
    expect(readBridgeTranscriptDetail(history, locator).status).toBe("expired");
  });

  test("report trimmed or rewound history as missing", () => {
    const history = [message("m1", [tool("t1", big(10_000))])];
    const locator = locatorFor(history);
    expect(readBridgeTranscriptDetail([], locator).status).toBe("missing");
    history[0]!.parts = [];
    expect(readBridgeTranscriptDetail(history, locator).status).toBe("missing");
  });

  test("find a part by its id after earlier parts were shed", () => {
    const history = [message("m1", [tool("a", "x"), tool("t1", big(10_000))])];
    const locator = locatorFor(history, 0, 1);
    history[0]!.parts.shift();
    expect(readBridgeTranscriptDetail(history, locator).status).toBe("ok");
  });

  test("reject malformed and foreign locators", () => {
    for (const locator of ["", "bd1.", "bd1.!!!", "file:///etc/passwd", "x".repeat(5_000)]) {
      expect(readBridgeTranscriptDetail([], locator).status).toBe("invalid");
    }
    const forged = `bd1.${Buffer.from(JSON.stringify({ m: 1, p: [], d: "x" })).toString("base64url")}`;
    expect(readBridgeTranscriptDetail([], forged).status).toBe("invalid");
  });

  test("the consumer parser accepts only the documented shapes", () => {
    expect(parseBridgeTranscriptDetailResponse({ version: 1, status: "expired" })).toEqual({
      version: 1,
      status: "expired",
    });
    expect(
      parseBridgeTranscriptDetailResponse({ version: 1, status: "ok", detail: {} }),
    ).toBeUndefined();
    expect(
      parseBridgeTranscriptDetailResponse({
        version: 1,
        status: "ok",
        detail: { fileDataUrl: "javascript:alert(1)" },
      }),
    ).toBeUndefined();
    expect(parseBridgeTranscriptDetailResponse({ version: 2, status: "ok" })).toBeUndefined();
  });
});

describe("pages", () => {
  const history = Array.from({ length: 250 }, (_, index) => message(`m${index}`));

  function firstCursor(): string {
    const update = bridgeTranscriptSummaryUpdate(history, options);
    if (update.status !== "snapshot") throw new Error("expected a snapshot");
    return update.value.historyCursor!;
  }

  test("walk contiguous history back to the start, each cursor advancing", () => {
    const seen: string[] = [];
    let cursor: string | undefined = firstCursor();
    let pages = 0;
    while (cursor) {
      const page = bridgeTranscriptPage(history, {
        generation: "g1",
        contentEpoch: 3,
        complete: true,
        cursor,
        limit: 60,
        targetBytes: 512 * 1024,
      });
      expect(page.status).toBe("page");
      if (page.status !== "page") return;
      expect(parseBridgeTranscriptPageResponse(page)).toEqual(page);
      seen.unshift(...page.messages.map((entry) => (entry as Message).id));
      cursor = page.nextCursor;
      pages += 1;
      if (!cursor) expect(page.complete).toBe(true);
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(history.slice(0, 150).map((entry) => entry.id));
  });

  test("a byte-limited page still advances", () => {
    const heavy = Array.from({ length: 10 }, (_, index) =>
      message(`h${index}`, [], big(200 * 1024)),
    );
    const update = bridgeTranscriptSummaryUpdate(heavy, { ...options, limit: 1 });
    if (update.status !== "snapshot") throw new Error("expected a snapshot");
    const page = bridgeTranscriptPage(heavy, {
      generation: "g1",
      contentEpoch: 3,
      complete: true,
      cursor: update.value.historyCursor!,
      limit: 100,
      targetBytes: 256 * 1024,
    });
    if (page.status !== "page") throw new Error("expected a page");
    expect(page.messages).toHaveLength(1);
    expect(page.startIndex).toBe(8);
    expect(page.nextCursor).toBeDefined();
  });

  test("a cursor from another epoch or generation is expired, never reinterpreted", () => {
    const cursor = firstCursor();
    const base = { complete: true, cursor, limit: 50, targetBytes: 512 * 1024 };
    expect(
      bridgeTranscriptPage(history, { ...base, generation: "g2", contentEpoch: 3 }).status,
    ).toBe("expired");
    expect(
      bridgeTranscriptPage(history, { ...base, generation: "g1", contentEpoch: 4 }).status,
    ).toBe("expired");
    expect(
      bridgeTranscriptPage(history.slice(0, 10), { ...base, generation: "g1", contentEpoch: 3 })
        .status,
    ).toBe("expired");
    expect(
      bridgeTranscriptPage(history, {
        ...base,
        cursor: "bp1.bad",
        generation: "g1",
        contentEpoch: 3,
      }).status,
    ).toBe("invalid");
  });

  test("history lost before the first retained message is never reported complete", () => {
    const cursor = firstCursor();
    let next: string | undefined = cursor;
    let last;
    while (next) {
      last = bridgeTranscriptPage(history, {
        generation: "g1",
        contentEpoch: 3,
        complete: false,
        cursor: next,
        limit: 200,
        targetBytes: 1024 * 1024,
      });
      next = last.status === "page" ? last.nextCursor : undefined;
    }
    expect(last).toMatchObject({ status: "page", startIndex: 0, complete: false });
  });

  test("the consumer parser rejects a page that neither advances nor ends", () => {
    const base = {
      version: 1,
      status: "page",
      messages: [],
      generation: "g",
      contentEpoch: 1,
      complete: false,
      truncated: false,
    };
    expect(parseBridgeTranscriptPageResponse({ ...base, startIndex: 5 })).toBeUndefined();
    expect(
      parseBridgeTranscriptPageResponse({ ...base, startIndex: 0, nextCursor: "c" }),
    ).toBeUndefined();
  });
});

describe("summary envelope parsing", () => {
  test("an old bridge's v1 answer is recognized as not-a-summary", () => {
    const v1 = bridgeTranscriptUpdate([message("m1")], options);
    expect(parseBridgeTranscriptSummaryUpdate(v1)).toBeUndefined();
  });

  test("round-trips snapshots and unchanged answers", () => {
    const snapshot = bridgeTranscriptSummaryUpdate([message("m1")], { ...options, title: "T" });
    expect(parseBridgeTranscriptSummaryUpdate(snapshot)).toEqual(snapshot);
    const unchanged = bridgeTranscriptSummaryUpdate([message("m1")], {
      ...options,
      title: "T",
      knownToken: snapshot.token,
    });
    expect(parseBridgeTranscriptSummaryUpdate(unchanged)).toEqual(unchanged);
  });

  test("rejects malformed envelopes", () => {
    for (const body of [
      null,
      { version: 2 },
      { version: 2, status: "snapshot", token: "t" },
      { version: 2, status: "snapshot", token: "t", value: { messages: "x" } },
      {
        version: 2,
        status: "snapshot",
        token: "t",
        value: { messages: [], startIndex: -1, generation: "g", contentEpoch: 1 },
      },
      { version: 2, status: "unchanged", token: "" },
    ]) {
      expect(parseBridgeTranscriptSummaryUpdate(body)).toBeUndefined();
    }
  });
});
