/**
 * One contract fixture for every bridge's v2 transcript routes.
 *
 * Each HTTP bridge serves `GET /session/:id/transcript?version=2`,
 * `/transcript/detail` and `/transcript/page` from its own state, and each had
 * its own copy of the tests for them. Those copies drifted in what they
 * covered, and none of them covered a restart. This module states the
 * contract once, as scenarios a bridge suite runs against an adapter over its
 * real router:
 *
 * - summary rows carry a detail locator for a large tool output, and the
 *   detail read returns exactly that body;
 * - a detail read answers the revision it was minted for, or an explicit
 *   `expired` / `missing` — never a newer body;
 * - history pages are contiguous back to the first message;
 * - a read with a current token answers `unchanged`, and only then;
 * - after the bridge rewrites history (rewind, branch switch, recovery, front
 *   trim) the content epoch changes and old tokens and cursors are refused;
 * - after a restart over the same persisted or provider state, nothing
 *   minted by the previous process answers `unchanged` or resolves a page.
 *
 * Framework-free on purpose (it throws `AssertionError`s), so bridges with
 * their own lockfiles and harnesses can import it without a shared test
 * runner setup. Test support only: nothing in production imports it.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { BRIDGE_SUMMARY_INLINE_DETAIL_BYTES } from "./bridge-transcript-summary.js";

/** A fixture message in the normalized shape every bridge serves. */
export interface ContractMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: ContractPart[];
  createdAt: string;
}

export type ContractPart =
  | { type: "text"; content: string; sourcePartId: string; sourceMessageId: string }
  | {
      type: "tool-invocation";
      content: string;
      sourcePartId: string;
      sourceMessageId: string;
      toolUseId: string;
      toolName: string;
      toolState: "success";
      toolOutput: string;
    };

const CREATED_AT = "2026-09-27T00:00:00.000Z";

/** A plain prose message. */
export function contractTextMessage(id: string, content = `message ${id}`): ContractMessage {
  return {
    id,
    role: "assistant",
    content,
    parts: [{ type: "text", content, sourcePartId: `${id}:0`, sourceMessageId: id }],
    createdAt: CREATED_AT,
  };
}

/** A message holding one settled tool call with `output` as its result. */
export function contractToolMessage(id: string, output: string): ContractMessage {
  return {
    id,
    role: "assistant",
    content: "",
    parts: [
      {
        type: "tool-invocation",
        content: "Read file",
        sourcePartId: `${id}:0`,
        sourceMessageId: id,
        toolUseId: `${id}-call`,
        toolName: "read",
        toolState: "success",
        toolOutput: output,
      },
    ],
    createdAt: CREATED_AT,
  };
}

/** A tool output well past the inline threshold, so its row carries a locator. */
export const CONTRACT_LARGE_OUTPUT = "contract tool output line\n".repeat(16_000);

/** How many messages a rewrite must leave behind; see `rewrite`. */
export const CONTRACT_REWRITE_MIN_RETAINED = 150;

export interface ContractSession {
  readonly id: string;
}

/** Reads one route of one bridge instance. */
export type ContractReader = (path: string) => Promise<unknown>;

/**
 * What a bridge suite supplies. Every mutation must go through the state and
 * helpers the bridge itself uses, so the scenarios test the bridge's
 * bookkeeping (revision, epoch, generation) rather than the adapter's.
 */
export interface BridgeTranscriptContractAdapter<S extends ContractSession = ContractSession> {
  /** `GET path` on the running bridge; resolves the parsed body of a 200 answer. */
  read: ContractReader;
  /** A session whose retained history is exactly `messages`, oldest first. */
  seed(messages: ContractMessage[]): Promise<S>;
  /** Append one message the way a live turn does (the content epoch stays). */
  append(session: S, message: ContractMessage): Promise<void> | void;
  /** Replace a retained tool part's output in place, as a streaming update does. */
  setToolOutput(session: S, messageId: string, output: string): Promise<void> | void;
  /**
   * Rewrite retained history through the bridge's own path — rewind, branch
   * switch, recovery replacement or front trim — so absolute positions from
   * before no longer name the same messages. At least
   * {@link CONTRACT_REWRITE_MIN_RETAINED} messages must remain, so an old
   * cursor is refused for its epoch and not merely for running past the end.
   */
  rewrite(session: S): Promise<void> | void;
  /**
   * A new bridge instance (new process generation) over the same persisted or
   * provider state. Returns that instance's reader and the session as it
   * knows it.
   */
  restart(session: S): Promise<{ read: ContractReader; session: S }>;
}

export interface BridgeTranscriptContractScenario {
  name: string;
  run<S extends ContractSession>(adapter: BridgeTranscriptContractAdapter<S>): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

function transcriptPath(id: string, params: Record<string, string> = {}): string {
  return `/session/${encodeURIComponent(id)}/transcript?${new URLSearchParams(params)}`;
}

function detailPath(id: string, locator: string): string {
  return `/session/${encodeURIComponent(id)}/transcript/detail?${new URLSearchParams({ locator })}`;
}

function pagePath(id: string, params: Record<string, string>): string {
  return `/session/${encodeURIComponent(id)}/transcript/page?${new URLSearchParams(params)}`;
}

async function summary(
  read: ContractReader,
  id: string,
  params: Record<string, string> = {},
): Promise<Body> {
  const body = (await read(transcriptPath(id, { ...params, version: "2" }))) as Body;
  assert.equal(body?.version, 2, "a version=2 read answers the v2 envelope");
  return body;
}

async function snapshot(
  read: ContractReader,
  id: string,
  params: Record<string, string> = {},
): Promise<Body> {
  const body = await summary(read, id, params);
  assert.equal(body.status, "snapshot", "a read without a current token answers a snapshot");
  return body;
}

function ids(messages: Array<{ id: string }>): string[] {
  return messages.map((message) => message.id);
}

/** The tool part of the newest message that has one, from a summary. */
function lastToolPart(messages: Body[]): Body {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const part = messages[index].parts?.find((entry: Body) => entry?.type === "tool-invocation");
    if (part) return part;
  }
  assert.fail("the summary holds a tool row");
}

/**
 * Walk every page before a summary's window, asserting contiguity, and return
 * the retained ids in transcript order and whether the first page said the
 * history is complete.
 */
async function walkPages(
  read: ContractReader,
  id: string,
  first: Body,
  limit = "100",
): Promise<{ ids: string[]; complete: boolean }> {
  const collected = ids(first.value.messages);
  let expectedEnd: number = first.value.startIndex;
  let cursor: string | undefined = first.value.historyCursor;
  let complete: boolean = first.value.complete;
  assert.equal(cursor === undefined, expectedEnd === 0, "a history cursor exists iff history does");
  while (cursor) {
    const page = (await read(pagePath(id, { cursor, limit }))) as Body;
    assert.equal(page.status, "page", "a current cursor answers a page");
    assert.equal(String(page.generation), String(first.value.generation));
    assert.equal(String(page.contentEpoch), String(first.value.contentEpoch));
    assert.ok(page.messages.length > 0, "a page before a nonzero position is never empty");
    assert.equal(
      page.startIndex + page.messages.length,
      expectedEnd,
      "each page ends exactly where the previous read began",
    );
    assert.notEqual(page.nextCursor, cursor, "a page always advances its cursor");
    assert.equal(page.nextCursor === undefined, page.startIndex === 0);
    collected.unshift(...ids(page.messages));
    expectedEnd = page.startIndex;
    cursor = page.nextCursor;
    if (!cursor) complete = page.complete;
  }
  assert.equal(expectedEnd, 0, "pages reach the first retained message");
  return { ids: collected, complete };
}

/** A detail read is either the exact body it was minted for, or says it is gone. */
function assertTruthfulDetail(answer: Body, expected: Record<string, unknown>, context: string) {
  if (answer.status === "ok") {
    assert.deepEqual(answer.detail, expected, `${context}: an ok detail is the minted body`);
    return;
  }
  assert.ok(
    answer.status === "missing" || answer.status === "expired",
    `${context}: a detail that is no longer served says so (got ${answer.status})`,
  );
}

const textMessages = (count: number, prefix = "m") =>
  Array.from({ length: count }, (_, index) => contractTextMessage(`${prefix}${index}`));

export const bridgeTranscriptContract: readonly BridgeTranscriptContractScenario[] = [
  {
    name: "summary rows carry a detail locator for large tool output, and the detail is exact",
    async run(adapter) {
      const session = await adapter.seed([
        contractTextMessage("earlier"),
        contractToolMessage("tool", CONTRACT_LARGE_OUTPUT),
        contractToolMessage("small", "short output"),
      ]);
      const body = await snapshot(adapter.read, session.id, {
        limit: "100",
        targetBytes: String(128 * 1024),
      });
      // The raw output alone would overflow this window; the summary keeps
      // every row because the body moved behind a locator.
      assert.deepEqual(ids(body.value.messages), ["earlier", "tool", "small"]);
      assert.equal(body.value.capabilities.details, true);
      assert.equal(body.value.capabilities.pages, true);
      const large = body.value.messages[1].parts[0];
      assert.equal(large.toolOutput, undefined, "the large body is not inline");
      assert.ok(large.detail?.fields?.includes("toolOutput"));
      assert.ok(large.detail.bytes > BRIDGE_SUMMARY_INLINE_DETAIL_BYTES);
      const small = body.value.messages[2].parts[0];
      assert.equal(small.toolOutput, "short output", "a small body stays inline");
      assert.equal(small.detail, undefined);

      const detail = (await adapter.read(detailPath(session.id, large.detail.locator))) as Body;
      assert.equal(detail.status, "ok");
      assert.deepEqual(detail.detail, { toolOutput: CONTRACT_LARGE_OUTPUT });
      assert.equal(
        detail.bytes,
        Buffer.byteLength(JSON.stringify({ toolOutput: CONTRACT_LARGE_OUTPUT })),
      );
    },
  },
  {
    name: "a detail answers the revision it was minted for, or says it is gone",
    async run(adapter) {
      const session = await adapter.seed([
        contractTextMessage("keep"),
        contractToolMessage("tool", CONTRACT_LARGE_OUTPUT),
      ]);
      const first = await snapshot(adapter.read, session.id);
      const locator = lastToolPart(first.value.messages).detail.locator as string;

      const changed = `${CONTRACT_LARGE_OUTPUT}streamed more`;
      await adapter.setToolOutput(session, "tool", changed);
      assert.deepEqual(await adapter.read(detailPath(session.id, locator)), {
        version: 1,
        status: "expired",
      });
      const second = await snapshot(adapter.read, session.id);
      const current = lastToolPart(second.value.messages).detail.locator as string;
      assert.notEqual(current, locator, "a changed body gets a new locator");
      const fresh = (await adapter.read(detailPath(session.id, current))) as Body;
      assert.deepEqual(fresh.detail, { toolOutput: changed });

      assert.deepEqual(await adapter.read(detailPath(session.id, "not-a-locator")), {
        version: 1,
        status: "invalid",
      });
      assert.deepEqual(await adapter.read(detailPath("contract-unknown-session", locator)), {
        version: 1,
        status: "missing",
      });
      assert.deepEqual(
        await adapter.read(pagePath("contract-unknown-session", { cursor: "bp1.x" })),
        { version: 1, status: "expired" },
      );
    },
  },
  {
    name: "history pages are contiguous back to the first message",
    async run(adapter) {
      const seeded = textMessages(250);
      const session = await adapter.seed(seeded);
      const first = await snapshot(adapter.read, session.id);
      assert.ok(first.value.startIndex > 0, "250 messages do not fit the default window");
      assert.deepEqual(await walkPages(adapter.read, session.id, first), {
        ids: ids(seeded),
        complete: true,
      });
      // A smaller page size walks the same history in more steps.
      assert.deepEqual((await walkPages(adapter.read, session.id, first, "37")).ids, ids(seeded));
      assert.deepEqual(await adapter.read(pagePath(session.id, { cursor: "garbage" })), {
        version: 1,
        status: "invalid",
      });
    },
  },
  {
    name: "a current token answers unchanged, and only while nothing changed",
    async run(adapter) {
      const session = await adapter.seed([
        contractTextMessage("a"),
        contractToolMessage("tool", CONTRACT_LARGE_OUTPUT),
      ]);
      const first = await snapshot(adapter.read, session.id);
      assert.deepEqual(await summary(adapter.read, session.id, { knownToken: first.token }), {
        version: 2,
        status: "unchanged",
        token: first.token,
      });
      // A v1 token describes raw bodies, never a v2 summary.
      const v1 = (await adapter.read(transcriptPath(session.id))) as Body;
      assert.equal(v1.version, 1);
      assert.equal(
        (await summary(adapter.read, session.id, { knownToken: v1.token })).status,
        "snapshot",
      );

      await adapter.append(session, contractTextMessage("appended"));
      const afterAppend = await summary(adapter.read, session.id, { knownToken: first.token });
      assert.equal(afterAppend.status, "snapshot", "an append invalidates the token");
      assert.equal(afterAppend.value.messages.at(-1).id, "appended");
      assert.equal(
        String(afterAppend.value.contentEpoch),
        String(first.value.contentEpoch),
        "an append keeps the epoch",
      );
      assert.deepEqual(await summary(adapter.read, session.id, { knownToken: afterAppend.token }), {
        version: 2,
        status: "unchanged",
        token: afterAppend.token,
      });

      await adapter.setToolOutput(session, "tool", `${CONTRACT_LARGE_OUTPUT}more`);
      assert.equal(
        (await summary(adapter.read, session.id, { knownToken: afterAppend.token })).status,
        "snapshot",
        "an in-place change invalidates the token",
      );
    },
  },
  {
    name: "a rewrite starts a new epoch and refuses the old token, cursor and positions",
    async run(adapter) {
      const seeded = [...textMessages(249), contractToolMessage("tool", CONTRACT_LARGE_OUTPUT)];
      const session = await adapter.seed(seeded);
      const before = await snapshot(adapter.read, session.id);
      const cursor = before.value.historyCursor as string;
      assert.ok(cursor, "the seeded history has pages");
      const locator = lastToolPart(before.value.messages).detail.locator as string;

      await adapter.rewrite(session);

      const after = await summary(adapter.read, session.id, { knownToken: before.token });
      assert.equal(after.status, "snapshot", "a token from before a rewrite is never current");
      assert.notEqual(
        String(after.value.contentEpoch),
        String(before.value.contentEpoch),
        "a rewrite starts a new content epoch",
      );
      assert.deepEqual(await adapter.read(pagePath(session.id, { cursor })), {
        version: 1,
        status: "expired",
      });
      assertTruthfulDetail(
        await adapter.read(detailPath(session.id, locator)),
        { toolOutput: CONTRACT_LARGE_OUTPUT },
        "after a rewrite",
      );
      // The rewritten history pages consistently under its own epoch. A front
      // trim may truthfully leave it incomplete; either way it is contiguous.
      const retained = await walkPages(adapter.read, session.id, after);
      assert.ok(retained.ids.length >= CONTRACT_REWRITE_MIN_RETAINED);
    },
  },
  {
    name: "a restarted bridge never honours a token or cursor from the previous process",
    async run(adapter) {
      const seeded = [...textMessages(149), contractToolMessage("tool", CONTRACT_LARGE_OUTPUT)];
      const session = await adapter.seed(seeded);
      const before = await snapshot(adapter.read, session.id);
      const cursor = before.value.historyCursor as string;
      assert.ok(cursor, "the seeded history has pages");
      const locator = lastToolPart(before.value.messages).detail.locator as string;

      const restarted = await adapter.restart(session);
      const read = restarted.read;
      const id = restarted.session.id;
      const after = await summary(read, id, { knownToken: before.token });
      assert.equal(
        after.status,
        "snapshot",
        "a token minted by the previous process never answers unchanged",
      );
      assert.notEqual(
        String(after.value.generation),
        String(before.value.generation),
        "a new process serves a new generation",
      );
      assert.deepEqual(await read(pagePath(id, { cursor })), { version: 1, status: "expired" });
      assertTruthfulDetail(
        await read(detailPath(id, locator)),
        { toolOutput: CONTRACT_LARGE_OUTPUT },
        "after a restart",
      );
      // The restored history is whole and self-consistent in the new process.
      assert.deepEqual((await walkPages(read, id, after)).ids, ids(seeded));
      assert.deepEqual(await summary(read, id, { knownToken: after.token }), {
        version: 2,
        status: "unchanged",
        token: after.token,
      });
    },
  },
];
