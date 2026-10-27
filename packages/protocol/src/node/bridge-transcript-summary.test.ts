import { describe, expect, test } from "bun:test";
import {
  BRIDGE_REVISED_MESSAGES_MAX,
  BRIDGE_SUMMARY_INLINE_DETAIL_BYTES,
  bridgeTranscriptPage,
  bridgeTranscriptPageCursorAt,
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
  test("each file in a shared tool invocation resolves its own deferred diff", () => {
    const original = message("patch", [
      {
        type: "tool-invocation",
        content: "a",
        toolUseId: "apply",
        toolDiff: { filePath: "a.ts", diff: big(8_192, "a") },
      },
      {
        type: "tool-invocation",
        content: "b",
        toolUseId: "apply",
        toolDiff: { filePath: "b.ts", diff: big(8_192, "b") },
      },
    ]);
    const summary = summarizeBridgeMessage(original);
    const locators = summary.parts.map(
      (part) => (part as Part & { detail: BridgePartDetail }).detail.locator,
    );
    expect(locators[0]).not.toBe(locators[1]);
    for (let index = 0; index < 2; index += 1) {
      expect(readBridgeTranscriptDetail([original], locators[index]!)).toMatchObject({
        status: "ok",
        detail: { toolDiff: original.parts[index]!.toolDiff },
      });
    }
  });
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

  test("a row larger than the page target is sent whole rather than cut", () => {
    const parts = Array.from({ length: 300 }, (_, index) => ({
      type: "text",
      content: `part ${index} ${"x".repeat(4 * 1024)}`,
    }));
    const history = [message("before"), message("huge", parts), message("after")];
    const update = bridgeTranscriptSummaryUpdate(history, { ...options, limit: 1 });
    if (update.status !== "snapshot") throw new Error("expected a snapshot");
    const page = bridgeTranscriptPage(history, {
      generation: "g1",
      contentEpoch: 3,
      complete: true,
      cursor: update.value.historyCursor!,
      limit: 100,
      targetBytes: 256 * 1024,
    });
    if (page.status !== "page") throw new Error("expected a page");
    expect(page.messages.map((entry) => (entry as Message).id)).toEqual(["huge"]);
    expect((page.messages[0] as Message).parts).toHaveLength(300);
    expect(page.truncated).toBe(false);
    expect(page.startIndex).toBe(1);
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

  test("a cursor moved to a later position pages exactly the rows before it", () => {
    const cursor = firstCursor();
    const moved = bridgeTranscriptPageCursorAt(cursor, 160);
    expect(moved).toBeDefined();
    const page = bridgeTranscriptPage(history, {
      generation: "g1",
      contentEpoch: 3,
      complete: true,
      cursor: moved!,
      limit: 20,
      targetBytes: 512 * 1024,
    });
    if (page.status !== "page") throw new Error("expected a page");
    expect(page.messages.map((entry) => (entry as Message).id)).toEqual(
      history.slice(140, 160).map((entry) => entry.id),
    );
    // Same generation and epoch: another epoch still expires the moved cursor.
    expect(
      bridgeTranscriptPage(history, {
        generation: "g1",
        contentEpoch: 4,
        complete: true,
        cursor: moved!,
        limit: 20,
        targetBytes: 512 * 1024,
      }).status,
    ).toBe("expired");
    // The snapshot's own position is allowed; one behind it, or a bad cursor, is not.
    expect(bridgeTranscriptPageCursorAt(cursor, 150)).toBe(cursor);
    expect(bridgeTranscriptPageCursorAt(cursor, 149)).toBeUndefined();
    expect(bridgeTranscriptPageCursorAt(cursor, 1.5)).toBeUndefined();
    expect(bridgeTranscriptPageCursorAt("bp1.bad", 160)).toBeUndefined();
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

describe("revised rows", () => {
  const history = Array.from({ length: 150 }, (_, index) => message(`r${index}`));

  test("rows before the window that changed travel with the snapshot, newest change first", () => {
    const update = bridgeTranscriptSummaryUpdate(history, {
      ...options,
      revisedMessageIds: ["r149", "r3", "r10", "missing"],
    });
    if (update.status !== "snapshot") throw new Error("expected a snapshot");
    expect(update.value.startIndex).toBe(50);
    // r149 is in the window already; an unknown id is ignored.
    expect(update.value.revisedMessages?.map((entry) => (entry as Message).id)).toEqual([
      "r3",
      "r10",
    ]);
    expect(parseBridgeTranscriptSummaryUpdate(update)).toEqual(update);
  });

  test("revised rows are bounded by count and summarized like the window", () => {
    const heavy = history.map((entry, index) =>
      index === 1 ? message(entry.id, [tool("t1", big(64 * 1024))]) : entry,
    );
    const ids = heavy.slice(0, 50).map((entry) => entry.id);
    const update = bridgeTranscriptSummaryUpdate(heavy, { ...options, revisedMessageIds: ids });
    if (update.status !== "snapshot") throw new Error("expected a snapshot");
    const revised = update.value.revisedMessages as Message[];
    expect(revised).toHaveLength(BRIDGE_REVISED_MESSAGES_MAX);
    expect(update.value.historyReconciliationToken).toBeDefined();
    const streamed = bridgeTranscriptSummaryUpdate(
      [...heavy.slice(0, -1), message("r149", [], "delta")],
      { ...options, revision: 2, revisedMessageIds: ids },
    );
    if (streamed.status !== "snapshot") throw new Error("expected snapshot");
    expect(streamed.value.historyReconciliationToken).toBe(update.value.historyReconciliationToken);
    const changed = heavy.map((row) =>
      row.id === "r49" ? { ...row, content: "revised again" } : row,
    );
    const late = bridgeTranscriptSummaryUpdate(changed, {
      ...options,
      revision: 3,
      revisedMessageIds: ids,
    });
    if (late.status !== "snapshot") throw new Error("expected snapshot");
    expect(late.value.historyReconciliationToken).not.toBe(update.value.historyReconciliationToken);
    const summarized = revised.find((entry) => entry.id === "r1")!;
    expect(summarized.parts[0]?.toolOutput).toBeUndefined();
  });

  test("a window that starts at the beginning carries none", () => {
    const update = bridgeTranscriptSummaryUpdate(history.slice(0, 5), {
      ...options,
      revisedMessageIds: ["r0"],
    });
    if (update.status !== "snapshot") throw new Error("expected a snapshot");
    expect(update.value.revisedMessages).toBeUndefined();
  });
});

test("revised-row byte overflow invalidates retained history while keeping whole-row paging", () => {
  const rows = Array.from({ length: 102 }, (_, index) =>
    message(
      `bytes-${index}`,
      index < 2
        ? Array.from({ length: 45 }, () => ({ type: "text", content: "x".repeat(4 * 1024) }))
        : [],
      "small",
    ),
  );
  const update = bridgeTranscriptSummaryUpdate(rows, {
    ...options,
    revisedMessageIds: ["bytes-0", "bytes-1"],
    pages: true,
  });
  if (update.status !== "snapshot") throw new Error("expected snapshot");
  expect(update.value.revisedMessages).toHaveLength(1);
  expect(update.value.historyReconciliationToken).toBeDefined();
  const page = bridgeTranscriptPage(rows, {
    generation: "g1",
    contentEpoch: 3,
    cursor: update.value.historyCursor!,
    complete: true,
    limit: 100,
    targetBytes: 512 * 1024,
  });
  if (page.status !== "page") throw new Error("expected page");
  expect(page.messages).toEqual(rows.slice(0, 2));
  expect(page.complete).toBe(true);
});
