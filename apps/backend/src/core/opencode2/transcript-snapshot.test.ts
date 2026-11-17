import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderTranscriptSnapshot } from "../agent-provider-contract.js";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import {
  OpenCode2TranscriptState,
  openCode2CursorAnchor,
  openCode2CursorThrough,
  openCode2HistoryCursor,
  openCode2TranscriptPage,
  openCode2TranscriptSnapshot,
} from "./transcript-snapshot.js";

let server: FakeOpenCode2Server | undefined;
afterEach(() => {
  server?.stop();
  server = undefined;
});

async function setup(rows: number, live = true) {
  server = new FakeOpenCode2Server();
  const client = server.client();
  const created = await client.createSession({});
  const ids: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    ids.push(
      server.pushRow(created.id, {
        type: index % 2 === 0 ? "user" : "assistant",
        ...(index % 2 === 0
          ? { text: `u${index}` }
          : { content: [{ type: "text", text: `a${index}` }] }),
        time: { created: 1_000 + index },
      }),
    );
  }
  const liveness = { live };
  const state = new OpenCode2TranscriptState(() => liveness.live);
  return { server, client, sessionId: created.id, ids, state, liveness };
}

const snapshot = (value: unknown) => value as ProviderTranscriptSnapshot;

describe("OpenCode 2 transcript windows", () => {
  test("a short session is complete, pageable and has no cursor", async () => {
    const { client, state, sessionId } = await setup(4);
    const result = snapshot(
      // A window wider than the server's 200-row page is read at the cap, not refused.
      await openCode2TranscriptSnapshot(client, state, sessionId, {
        limit: 500,
        targetBytes: 1_000_000,
      }),
    );
    expect(result.messages.map((row) => (row as { content: string }).content)).toEqual([
      "u0",
      "a1",
      "u2",
      "a3",
    ]);
    expect(result).toMatchObject({ complete: true, historyPageable: true, freshness: "current" });
    expect(result.historyCursor).toBeUndefined();
  });

  test("a long session pages back to its start with no row lost or repeated", async () => {
    const { client, state, sessionId, ids } = await setup(11);
    const window = snapshot(
      await openCode2TranscriptSnapshot(client, state, sessionId, {
        limit: 4,
        targetBytes: 1_000_000,
      }),
    );
    expect(window.complete).toBe(false);
    expect(window.messages.map((row) => (row as { id: string }).id)).toEqual(ids.slice(-4));
    expect(openCode2CursorAnchor(window.historyCursor!)).toBe(ids[7]);
    expect(openCode2CursorAnchor(window.historyCursor!)).toBe(ids.at(-4));
    expect(window.historyCursorBefore!(ids[8]!)).toBe(
      openCode2HistoryCursor(ids[8]!, window.historyEpoch),
    );
    expect(window.historyCursorBefore!("not-a-row")).toBeUndefined();
    const seen = window.messages.map((row) => (row as { id: string }).id);
    let cursor = window.historyCursor;
    while (cursor) {
      const page = await openCode2TranscriptPage(client, state, sessionId, {
        cursor,
        limit: 3,
        targetBytes: 1_000_000,
      });
      if (page.status !== "page") throw new Error("expired");
      expect(page.historyEpoch).toBe(window.historyEpoch!);
      seen.unshift(...page.messages.map((row) => (row as { id: string }).id));
      cursor = page.historyCursor;
      if (!cursor) expect(page.complete).toBe(true);
    }
    expect(seen).toEqual(ids);
  });

  test("the byte target trims whole rows, always keeping the newest", async () => {
    const { client, state, sessionId, ids } = await setup(6);
    const result = snapshot(
      await openCode2TranscriptSnapshot(client, state, sessionId, { limit: 10, targetBytes: 300 }),
    );
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(6);
    expect((result.messages.at(-1) as { id: string }).id).toBe(ids.at(-1)!);
    expect(result.complete).toBe(false);
    // The cursor pages strictly before the oldest row kept.
    expect(openCode2CursorAnchor(result.historyCursor!)).toBe(
      ids[ids.length - result.messages.length],
    );
  });

  test("unchanged only while the stream is live and nothing arrived", async () => {
    const { client, state, sessionId, liveness } = await setup(2);
    const options = { limit: 10, targetBytes: 1_000_000 };
    const first = snapshot(await openCode2TranscriptSnapshot(client, state, sessionId, options));
    expect(
      await openCode2TranscriptSnapshot(client, state, sessionId, {
        ...options,
        knownSourceToken: first.sourceToken,
      }),
    ).toEqual({
      unchanged: true,
      sourceToken: first.sourceToken!,
    });
    state.observe(sessionId, { type: "session.text.delta", data: { sessionID: sessionId } });
    const second = await openCode2TranscriptSnapshot(client, state, sessionId, {
      ...options,
      knownSourceToken: first.sourceToken,
    });
    expect("messages" in second).toBe(true);
    liveness.live = false;
    const token = snapshot(second).sourceToken;
    expect(
      "messages" in
        (await openCode2TranscriptSnapshot(client, state, sessionId, {
          ...options,
          knownSourceToken: token,
        })),
    ).toBe(true);
  });

  test("a row that changes after leaving the window is sent as a revised row", async () => {
    const { server, client, state, sessionId, ids } = await setup(8);
    const options = { limit: 4, targetBytes: 1_000_000 };
    await openCode2TranscriptSnapshot(client, state, sessionId, options);
    // A background sub-agent's result lands on an old response.
    server.reviseRow(sessionId, ids[1]!, { content: [{ type: "text", text: "late result" }] });
    state.observe(sessionId, {
      type: "session.tool.success",
      data: { sessionID: sessionId, assistantMessageID: ids[1] },
    });
    // A change inside the window is just part of the window.
    state.observe(sessionId, {
      type: "session.tool.success",
      data: { sessionID: sessionId, assistantMessageID: ids[7] },
    });
    const result = snapshot(await openCode2TranscriptSnapshot(client, state, sessionId, options));
    expect(result.revisedMessages).toEqual([
      expect.objectContaining({ id: ids[1], content: "late result" }),
    ]);
    expect(result.historyReconciliationToken).toBeUndefined();
    // Fetched once per change, then cached.
    const reads = server.calls.filter((call) => call.path.endsWith(`/message/${ids[1]}`)).length;
    await openCode2TranscriptSnapshot(client, state, sessionId, options);
    expect(server.calls.filter((call) => call.path.endsWith(`/message/${ids[1]}`)).length).toBe(
      reads,
    );
  });

  test("lost events move the reconciliation token; a sequence gap only re-reads", async () => {
    const { client, state, sessionId } = await setup(2);
    const options = { limit: 10, targetBytes: 1_000_000 };
    const before = snapshot(await openCode2TranscriptSnapshot(client, state, sessionId, options));
    state.invalidate(sessionId);
    const gap = snapshot(await openCode2TranscriptSnapshot(client, state, sessionId, options));
    expect(gap.sourceToken).not.toBe(before.sourceToken);
    expect(gap.historyReconciliationToken).toBe(before.historyReconciliationToken);
    state.invalidateAll(true);
    const lost = snapshot(await openCode2TranscriptSnapshot(client, state, sessionId, options));
    expect(lost.historyReconciliationToken).toBeDefined();
    expect(lost.historyReconciliationToken).not.toBe(before.historyReconciliationToken);
  });

  test("a cursor expires when its row is gone, its epoch moved, or it was never minted here", async () => {
    const { server, client, state, sessionId, ids } = await setup(6);
    const options = { limit: 2, targetBytes: 1_000_000 };
    const window = snapshot(await openCode2TranscriptSnapshot(client, state, sessionId, options));
    const cursor = window.historyCursor!;
    // A committed revert removes rows: the anchor no longer exists.
    const session = server.sessions.get(sessionId)!;
    session.rows = session.rows.filter((row) => row.id !== ids[3]);
    expect(
      await openCode2TranscriptPage(client, state, sessionId, {
        cursor: openCode2HistoryCursor(ids[3]!)!,
        limit: 5,
        targetBytes: 1e6,
      }),
    ).toEqual({
      status: "expired",
    });
    state.observe(sessionId, { type: "session.revert.committed", data: { sessionID: sessionId } });
    const moved = snapshot(await openCode2TranscriptSnapshot(client, state, sessionId, options));
    expect(moved.historyEpoch).not.toBe(window.historyEpoch);
    expect(cursor).toBeDefined();
    expect(
      await openCode2TranscriptPage(client, state, sessionId, {
        cursor: "x",
        limit: 5,
        targetBytes: 1e6,
      }),
    ).toEqual({
      status: "expired",
    });
    expect(
      await openCode2TranscriptPage(client, state, sessionId, {
        cursor: Buffer.from(
          JSON.stringify({ id: ids[1], order: "asc", direction: "next" }),
        ).toString("base64url"),
        limit: 5,
        targetBytes: 1e6,
      }),
    ).toEqual({ status: "expired" });
  });

  test("an empty page before an existing first row is the start of history", async () => {
    const { client, state, sessionId, ids } = await setup(3);
    expect(
      await openCode2TranscriptPage(client, state, sessionId, {
        cursor: openCode2HistoryCursor(ids[0]!)!,
        limit: 5,
        targetBytes: 1e6,
      }),
    ).toMatchObject({ status: "page", messages: [], complete: true });
  });

  test("a window at the first message still names a cursor before each kept row (8110)", async () => {
    const { client, state, sessionId, ids } = await setup(4);
    const window = snapshot(
      await openCode2TranscriptSnapshot(client, state, sessionId, {
        limit: 10,
        targetBytes: 1e6,
      }),
    );
    expect(window.complete).toBe(true);
    expect(window.historyCursor).toBeUndefined();
    // A reader whose own bound dropped the first two rows pages them back.
    const cursor = window.historyCursorBefore!(ids[2]!);
    expect(cursor).toBe(openCode2HistoryCursor(ids[2]!, window.historyEpoch));
    const page = await openCode2TranscriptPage(client, state, sessionId, {
      cursor: cursor!,
      limit: 10,
      targetBytes: 1e6,
    });
    if (page.status !== "page") throw new Error("expected a page");
    expect(page.messages.map((row) => (row as { id: string }).id)).toEqual(ids.slice(0, 2));
    expect(page.complete).toBe(true);
  });

  test("the window-end cursor pages the window's newest rows again, then older ones (8110)", async () => {
    const { client, state, sessionId, ids } = await setup(7);
    const window = snapshot(
      await openCode2TranscriptSnapshot(client, state, sessionId, {
        limit: 3,
        targetBytes: 1e6,
      }),
    );
    expect(window.historyCursorAtEnd).toBe(
      openCode2CursorThrough(ids.at(-1)!, window.historyEpoch!),
    );
    expect(openCode2CursorAnchor(window.historyCursorAtEnd!)).toBeUndefined();
    const seen: string[] = [];
    let cursor = window.historyCursorAtEnd;
    let pages = 0;
    while (cursor) {
      const page = await openCode2TranscriptPage(client, state, sessionId, {
        cursor,
        limit: 4,
        targetBytes: 1e6,
      });
      if (page.status !== "page") throw new Error("expected a page");
      expect(page.historyEpoch).toBe(window.historyEpoch!);
      // The first page starts at the newest row, the ones the reader holds.
      if (pages === 0) expect((page.messages.at(-1) as { id: string }).id).toBe(ids.at(-1)!);
      seen.unshift(...page.messages.map((row) => (row as { id: string }).id));
      cursor = page.historyCursor;
      pages += 1;
      if (!cursor) expect(page.complete).toBe(true);
    }
    expect(seen).toEqual(ids);
    // Minted for another epoch, it expires like any other cursor.
    expect(
      await openCode2TranscriptPage(client, state, sessionId, {
        cursor: openCode2CursorThrough(ids.at(-1)!, "another-epoch")!,
        limit: 4,
        targetBytes: 1e6,
      }),
    ).toEqual({ status: "expired" });
    // So does one whose row the server no longer has.
    expect(
      await openCode2TranscriptPage(client, state, sessionId, {
        cursor: openCode2CursorThrough("msg_gone", window.historyEpoch!)!,
        limit: 4,
        targetBytes: 1e6,
      }),
    ).toEqual({ status: "expired" });
  });

  test("the window-end cursor names the window it was minted from, not the session's head (8110)", async () => {
    const { server, client, state, sessionId, ids } = await setup(5);
    const options = { limit: 3, targetBytes: 1e6 };
    const first = snapshot(await openCode2TranscriptSnapshot(client, state, sessionId, options));
    // Rows appended after the window was read do not move the epoch...
    const appended = [
      server.pushRow(sessionId, { type: "user", text: "u5", time: { created: 2_000 } }),
      server.pushRow(sessionId, {
        type: "assistant",
        content: [{ type: "text", text: "a6" }],
        time: { created: 2_001 },
      }),
    ];
    state.invalidate(sessionId);
    const second = snapshot(await openCode2TranscriptSnapshot(client, state, sessionId, options));
    expect(second.historyEpoch).toBe(first.historyEpoch);
    // ...but each window names its own end, so a page cached under one cursor
    // can never answer for the other.
    expect(second.historyCursorAtEnd).not.toBe(first.historyCursorAtEnd);
    // The earlier cursor still pages from its own window's end: no newer row
    // reaches its reader as older history.
    const page = await openCode2TranscriptPage(client, state, sessionId, {
      cursor: first.historyCursorAtEnd!,
      limit: 10,
      targetBytes: 1e6,
    });
    if (page.status !== "page") throw new Error("expected a page");
    expect(page.messages.map((row) => (row as { id: string }).id)).toEqual(ids);
    expect(page.complete).toBe(true);
    const latest = await openCode2TranscriptPage(client, state, sessionId, {
      cursor: second.historyCursorAtEnd!,
      limit: 10,
      targetBytes: 1e6,
    });
    if (latest.status !== "page") throw new Error("expected a page");
    expect(latest.messages.map((row) => (row as { id: string }).id)).toEqual([...ids, ...appended]);
  });

  test("a session the server does not have is an empty, complete window", async () => {
    const { client, state } = await setup(0);
    expect(
      snapshot(
        await openCode2TranscriptSnapshot(client, state, "ses_gone", {
          limit: 5,
          targetBytes: 1e6,
        }),
      ),
    ).toMatchObject({ messages: [], complete: true });
  });
});

test("staged Undo hides an off-window boundary, expires retained pages and restores on Redo without events", async () => {
  const { server, client, state, sessionId, ids } = await setup(12);
  const options = { limit: 2, targetBytes: 1e6 };
  const before = snapshot(await openCode2TranscriptSnapshot(client, state, sessionId, options));
  const pageBefore = await openCode2TranscriptPage(client, state, sessionId, {
    ...options,
    cursor: before.historyCursor!,
  });
  expect(pageBefore.status).toBe("page");
  server.sessions.get(sessionId)!.revert = { messageID: ids[4]! };
  const undone = snapshot(
    await openCode2TranscriptSnapshot(client, state, sessionId, {
      ...options,
      knownSourceToken: before.sourceToken,
    }),
  );
  expect(undone.messages.map((row) => (row as { id: string }).id)).toEqual(ids.slice(2, 4));
  expect(undone.historyEpoch).not.toBe(before.historyEpoch);
  expect(
    await openCode2TranscriptPage(client, state, sessionId, {
      ...options,
      cursor: before.historyCursor!,
    }),
  ).toEqual({ status: "expired" });
  state.observe(sessionId, { type: "session.text.ended", data: { assistantMessageID: ids[9] } });
  const revised = snapshot(await openCode2TranscriptSnapshot(client, state, sessionId, options));
  expect(revised.revisedMessages).toBeUndefined();
  const page = await openCode2TranscriptPage(client, state, sessionId, {
    ...options,
    cursor: undone.historyCursor!,
  });
  expect(page).toMatchObject({ status: "page", messages: ids.slice(0, 2).map((id) => ({ id })) });
  server.sessions.get(sessionId)!.revert = undefined;
  const redone = snapshot(await openCode2TranscriptSnapshot(client, state, sessionId, options));
  expect(redone.messages.map((row) => (row as { id: string }).id)).toEqual(ids.slice(-2));
  expect(redone.historyEpoch).not.toBe(undone.historyEpoch);
  expect(
    await openCode2TranscriptPage(client, state, sessionId, {
      ...options,
      cursor: undone.historyCursor!,
    }),
  ).toEqual({ status: "expired" });
});

function launchRow(id: string, callId: string, childId: string, completedAt = 1_000) {
  return {
    id,
    type: "assistant",
    content: [
      {
        type: "tool",
        id: callId,
        name: "subagent",
        state: {
          status: "completed",
          input: { agent: "general", description: "probe child", prompt: "Look" },
          content: [
            {
              type: "text",
              text: `The subagent is working in the background (sessionID: ${childId}).`,
            },
          ],
          metadata: { sessionID: childId, status: "running", truncated: false },
        },
        time: { created: completedAt - 10, ran: completedAt - 5, completed: completedAt },
      },
    ],
    time: { created: completedAt - 20 },
  };
}

/** The `<subagent>` report 2.3.0 delivers to the parent each time the child goes idle. */
function reportRow(id: string, childId: string, state: string, body: string) {
  return {
    id,
    type: "synthetic",
    description: "probe child",
    metadata: { source: "subagent", childID: childId, agent: "General", state },
    text: `<subagent sessionID="${childId}" state="${state}" description="probe child">\n${body}\n</subagent>`,
    time: { created: 5_000 },
  };
}

for (const outcome of ["completed", "error"] as const) {
  test(`revised launch retains ${outcome} after the report leaves the head`, async () => {
    const { server, client, state, sessionId } = await setup(0);
    const launch = server.pushRow(sessionId, launchRow("msg_launch", "call", "ses_child"));
    state.observe(sessionId, {
      type: "session.tool.success",
      data: { sessionID: sessionId, assistantMessageID: launch },
    });
    server.pushRow(sessionId, reportRow("msg_report", "ses_child", outcome, "retained result"));
    const options = { limit: 2, targetBytes: 1_000_000 };
    await openCode2TranscriptSnapshot(client, state, sessionId, options);
    for (let i = 0; i < 4; i++)
      server.pushRow(sessionId, { type: "user", text: "later", time: { created: 9_000 } });
    const result = snapshot(await openCode2TranscriptSnapshot(client, state, sessionId, options));
    expect(result.revisedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: launch,
          parts: expect.arrayContaining([
            expect.objectContaining({
              agentState: outcome === "completed" ? "finished" : "failed",
              [outcome === "completed" ? "toolOutput" : "toolError"]: "retained result",
            }),
          ]),
        }),
      ]),
    );
  });
}

test("an older revised launch consults live sessions outside the window", async () => {
  const { server, client, state, sessionId } = await setup(0);
  const launch = server.pushRow(sessionId, launchRow("msg_launch", "call", "ses_child"));
  state.observe(sessionId, {
    type: "session.tool.success",
    data: { sessionID: sessionId, assistantMessageID: launch },
  });
  for (let i = 0; i < 4; i++)
    server.pushRow(sessionId, { type: "user", text: "later", time: { created: 9_000 } });
  let reads = 0;
  const result = snapshot(
    await openCode2TranscriptSnapshot(
      client,
      state,
      sessionId,
      { limit: 2, targetBytes: 1_000_000 },
      undefined,
      async () => {
        reads++;
        return new Set(["ses_child"]);
      },
    ),
  );
  expect(reads).toBeGreaterThan(0);
  expect(result.revisedMessages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: launch,
        parts: expect.arrayContaining([expect.objectContaining({ agentState: "active" })]),
      }),
    ]),
  );
});
