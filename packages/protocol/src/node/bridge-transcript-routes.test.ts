import { describe, expect, test } from "bun:test";
import {
  bridgeTranscriptDetailRouteBody,
  bridgeTranscriptPageRouteBody,
  bridgeTranscriptRouteBody,
  type BridgeTranscriptSource,
} from "./bridge-transcript-routes.js";
import { bridgeTranscriptUpdate } from "./progressive-transcript.js";

interface Message {
  id: string;
  role: "assistant";
  content: string;
  parts: Array<Record<string, unknown>>;
  createdAt: string;
}

function message(id: string, parts: Array<Record<string, unknown>> = []): Message {
  return { id, role: "assistant", content: id, parts, createdAt: "2026-09-27T00:00:00.000Z" };
}

function query(values: Record<string, string>) {
  const params = new URLSearchParams(values);
  return (name: string) => params.get(name);
}

const source: BridgeTranscriptSource<Message> = {
  messages: Array.from({ length: 150 }, (_, index) =>
    message(`m${index}`, [
      {
        type: "tool-invocation",
        content: "Read",
        toolUseId: `t${index}`,
        toolOutput: index === 149 ? "o".repeat(8 * 1024) : "small",
      },
    ]),
  ),
  sessionIdentity: "session-1",
  generation: "g1",
  contentEpoch: 4,
  revision: 9,
  complete: true,
};

describe("bridge transcript route bodies", () => {
  test("an absent or v1 version keeps the v1 envelope exactly", () => {
    const expected = bridgeTranscriptUpdate(source.messages, {
      sessionIdentity: "session-1",
      generation: "g1",
      contentEpoch: 4,
      revision: 9,
      limit: 100,
      targetBytes: 512 * 1024,
      complete: true,
    });
    const versions: Array<Record<string, string>> = [{}, { version: "1" }, { version: "3" }];
    for (const version of versions) {
      const body = bridgeTranscriptRouteBody(
        source,
        query({ limit: "100", targetBytes: String(512 * 1024), ...version }),
      );
      expect(JSON.stringify(body)).toBe(JSON.stringify(expected));
    }
  });

  test("version=2 answers summaries that advertise details and pages", () => {
    const body = bridgeTranscriptRouteBody(source, query({ version: "2" }));
    if (body.version !== 2 || body.status !== "snapshot") throw new Error("expected v2 snapshot");
    expect(body.value.capabilities).toEqual({ details: true, pages: true });
    expect(body.value.startIndex).toBe(50);
    expect(body.value.historyCursor).toBeString();
    const newest = body.value.messages.at(-1) as Message;
    expect(newest.parts[0]).not.toHaveProperty("toolOutput");
    expect(newest.parts[0]).toHaveProperty("detail");
  });

  test("detail and page read the same source", () => {
    const summary = bridgeTranscriptRouteBody(source, query({ version: "2" }));
    if (summary.version !== 2 || summary.status !== "snapshot") throw new Error("expected v2");
    const locator = ((summary.value.messages.at(-1) as Message).parts[0]!.detail as {
      locator: string;
    })!.locator;
    expect(bridgeTranscriptDetailRouteBody(source, query({ locator }))).toMatchObject({
      status: "ok",
      detail: { toolOutput: "o".repeat(8 * 1024) },
    });
    const page = bridgeTranscriptPageRouteBody(
      source,
      query({ cursor: summary.value.historyCursor!, limit: "20" }),
    );
    expect(page).toMatchObject({ status: "page", startIndex: 30, complete: false });
  });

  test("an unknown session is answered in band, never as an absent route", () => {
    expect(bridgeTranscriptDetailRouteBody(undefined, query({ locator: "bd1.x" }))).toEqual({
      version: 1,
      status: "missing",
    });
    expect(bridgeTranscriptPageRouteBody(undefined, query({ cursor: "bp1.x" }))).toEqual({
      version: 1,
      status: "expired",
    });
  });

  test("a missing locator or cursor is invalid", () => {
    expect(bridgeTranscriptDetailRouteBody(source, query({}))).toEqual({
      version: 1,
      status: "invalid",
    });
    expect(bridgeTranscriptPageRouteBody(source, query({}))).toEqual({
      version: 1,
      status: "invalid",
    });
  });
});
