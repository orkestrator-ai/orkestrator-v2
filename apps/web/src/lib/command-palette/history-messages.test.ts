import { describe, expect, test } from "bun:test";
import {
  createMessageHistoryProvider,
  messageSnippet,
  type MessageHistorySource,
} from "./history-messages";

function source(
  tabId: string,
  messages: readonly unknown[] | null,
  environmentId = "e-1",
): MessageHistorySource {
  return {
    environmentId,
    environmentName: "checkout",
    projectId: "p",
    projectName: "orkestrator-v2",
    tabId,
    tabTitle: `Tab ${tabId}`,
    messages: () => messages,
  };
}

function message(id: string, content: string, role = "assistant") {
  return { id, role, content, parts: [], createdAt: "2026-11-19T00:00:00Z" };
}

describe("message History source", () => {
  test("an empty query searches no message text", async () => {
    let read = 0;
    const provider = createMessageHistoryProvider({
      machine: () => null,
      sources: () => [
        {
          ...source("t1", []),
          messages: () => {
            read += 1;
            return [message("m1", "anything")];
          },
        },
      ],
    });
    const answer = await provider.search("  ", new AbortController().signal);
    expect(answer).toEqual({ rows: [], partial: false });
    expect(read).toBe(0);
  });

  test("matches every token, newest first, and opens a stable message destination", async () => {
    const provider = createMessageHistoryProvider({
      machine: () => null,
      sources: () => [
        source("t1", [
          message("m1", "Release notes drafted", "user"),
          message("m2", "The release build failed on arm64"),
          message("system-1", "release build notice", "system"),
          message("error-1", "release build error"),
        ]),
        source("t2", null),
      ],
    });
    const answer = await provider.search("release BUILD", new AbortController().signal);
    expect(answer.rows.map((row) => row.messageId)).toEqual(["m2"]);
    expect(answer.rows[0]).toMatchObject({
      source: "message",
      rowId: "history-message:this:e-1:t1:m2",
      tabId: "t1",
      kind: "Agent reply",
      title: "Tab t1",
    });
    const user = await provider.search("notes", new AbortController().signal);
    expect(user.rows[0]?.kind).toBe("Your message");
  });

  test("is bounded per tab, in results and in messages read", async () => {
    const many = Array.from({ length: 10 }, (_, index) => message(`m${index}`, `deploy ${index}`));
    const provider = createMessageHistoryProvider({
      machine: () => null,
      sources: () => [source("t1", many), source("t2", many, "e-2"), source("t3", many, "e-3")],
      resultLimit: 5,
      scanLimit: 25,
    });
    const answer = await provider.search("deploy", new AbortController().signal);
    // Three per tab at most, newest first, five overall.
    expect(answer.rows.map((row) => `${row.tabId}:${row.messageId}`)).toEqual([
      "t1:m9",
      "t1:m8",
      "t1:m7",
      "t2:m9",
      "t2:m8",
    ]);
    expect(answer.partial).toBe(true);

    const scanned = createMessageHistoryProvider({
      machine: () => null,
      sources: () => [source("t1", many)],
      scanLimit: 4,
    });
    const limited = await scanned.search("nothing-matches", new AbortController().signal);
    expect(limited).toEqual({ rows: [], partial: true });
  });

  test("an aborted search rejects", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createMessageHistoryProvider({
      machine: () => null,
      sources: () => [source("t1", [message("m1", "hello")])],
    });
    await expect(provider.search("hello", controller.signal)).rejects.toHaveProperty(
      "name",
      "AbortError",
    );
  });

  test("an excerpt is one line around the match", () => {
    const content = `${"a ".repeat(60)}needle\n\nin the\n haystack ${"b ".repeat(60)}`;
    const snippet = messageSnippet(content, "needle");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("needle");
    expect(snippet).not.toContain("\n");
    expect(snippet).toContain("needle in the haystack");
    expect(messageSnippet("short needle", "needle")).toBe("short needle");
  });
});
