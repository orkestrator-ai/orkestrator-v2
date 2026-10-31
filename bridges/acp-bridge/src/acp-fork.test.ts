import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { promises as fs } from "node:fs";
import type { BridgeMessage } from "./acp-context.js";
import { forkPromptIndex, type ForkPromptPoint } from "./acp-fork.js";
import { nativeFetch, spawnBridge, temporaryDirectory, waitFor } from "./acp-test-harness.js";

function row(id: string, role: "user" | "assistant", content = id): BridgeMessage {
  return { id, role, content, parts: [], createdAt: "2026-10-31T00:00:00.000Z" } as BridgeMessage;
}
function points(...previews: string[]): ForkPromptPoint[] {
  return previews.map((preview, promptIndex) => ({ promptIndex, preview }));
}

describe("forkPromptIndex", () => {
  const transcript = [
    row("u1", "user", "first prompt"),
    row("a1", "assistant"),
    row("u2", "user", "second prompt"),
    row("a2a", "assistant"),
    row("a2b", "assistant"),
    row("u3", "user", "third prompt"),
    row("a3", "assistant"),
  ];
  const all = points("first prompt", "second prompt", "third prompt");

  test.each([
    ["a user row", "u2", 1],
    ["its answer", "a1", 0],
    ["any row of a multi-response turn", "a2a", 1],
    ["the last row", "a3", 2],
  ])("%s resolves to its turn's prompt", (_name, id, expected) => {
    expect(forkPromptIndex(transcript, id, all)).toBe(expected);
  });

  test("aligns from the newest, so a trimmed transcript still resolves", () => {
    expect(forkPromptIndex(transcript.slice(2), "a2b", all)).toBe(1);
  });

  test("a long prompt matches a preview cut short with an ellipsis", () => {
    const messages = [row("u1", "user", `${"word ".repeat(40)}tail`), row("a1", "assistant")];
    expect(forkPromptIndex(messages, "a1", points(`${"word ".repeat(10).trim()}…`))).toBe(0);
  });

  test("a command with no prompt index of its own is skipped", () => {
    const messages = [
      row("u1", "user", "first prompt"),
      row("a1", "assistant"),
      row("u2", "user", "/context"),
      row("a2", "assistant"),
      row("u3", "user", "second prompt"),
      row("a3", "assistant"),
    ];
    const listed = points("first prompt", "second prompt");
    expect(forkPromptIndex(messages, "a3", listed)).toBe(1);
    // The command's own row forks at the prompt before it.
    expect(forkPromptIndex(messages, "a2", listed)).toBe(0);
  });

  test("refuses a point before a compaction, whose fork would hold later context", () => {
    const messages = [
      row("u1", "user", "first prompt"),
      row("a1", "assistant"),
      row("u2", "user", "/compact"),
      row("u3", "user", "second prompt"),
      row("a3", "assistant"),
    ];
    const listed = points("first prompt", "second prompt");
    expect(() => forkPromptIndex(messages, "a1", listed)).toThrow("before its compaction");
    expect(forkPromptIndex(messages, "a3", listed)).toBe(1);
  });

  test("refuses when the transcript and the agent's list disagree", () => {
    expect(() => forkPromptIndex(transcript, "a2a", points("first prompt", "other"))).toThrow(
      "cannot be forked at that message",
    );
    expect(() => forkPromptIndex(transcript, "a1", [])).toThrow("cannot be forked at that message");
  });

  test("refuses an unknown message and a message with no prompt before it", () => {
    expect(() => forkPromptIndex(transcript, "nope", all)).toThrow("not in this session");
    const leading = [row("a0", "assistant"), ...transcript];
    expect(() => forkPromptIndex(leading, "a0", all)).toThrow("no prompt to fork at");
  });
});

describe("POST /session/:id/fork", () => {
  const POINTS = JSON.stringify([
    { prompt_index: 0, prompt_preview: "DIRECT:one" },
    { prompt_index: 1, prompt_preview: "DIRECT:two" },
  ]);

  async function grokBridge(env: NodeJS.ProcessEnv = {}) {
    const workspace = await temporaryDirectory();
    const requests = resolve(workspace, "fork-requests.log");
    const bridge = await spawnBridge({
      env: {
        CWD: workspace,
        ACP_PROVIDER: "grok",
        XAI_API_KEY: "test-key",
        FAKE_ACP_AUTH_METHOD: "cached_token",
        FAKE_ACP_FORK_REQUEST_FILE: requests,
        FAKE_ACP_REWIND_POINTS: POINTS,
        ...env,
      },
    });
    const created = (await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json())) as { id: string };
    const url = `${bridge.base}/session/${created.id}`;
    const send = async (prompt: string) => {
      const sent = await nativeFetch(`${url}/prompt`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({ prompt, requestId: prompt }),
      });
      expect(sent.status).toBe(202);
      await waitFor(
        () =>
          nativeFetch(url, { headers: bridge.headers }).then((response) =>
            response.json(),
          ) as Promise<{ status: string; messages: BridgeMessage[] }>,
        (session) => session.status === "idle",
      );
    };
    const session = () =>
      nativeFetch(url, { headers: bridge.headers }).then((response) => response.json()) as Promise<{
        status: string;
        messages: BridgeMessage[];
      }>;
    const fork = (body: unknown = {}) =>
      nativeFetch(`${url}/fork`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify(body),
      });
    const forkRequests = async () =>
      (await fs.readFile(requests, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { ...bridge, id: created.id, workspace, send, session, fork, forkRequests };
  }

  test("a whole-session fork adopts the new conversation as its own session", async () => {
    const bridge = await grokBridge();
    await bridge.send("DIRECT:one");

    const response = await bridge.fork();
    expect(response.status).toBe(200);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(sessionId).not.toBe(bridge.id);

    const [request] = await bridge.forkRequests();
    // Grok requires `sourceCwd`; a fork keeps working in the same checkout.
    expect(typeof request?.sourceCwd).toBe("string");
    expect(request?.newCwd).toBe(request?.sourceCwd);
    expect(request).not.toHaveProperty("targetPromptIndex");
    const forked = (await nativeFetch(`${bridge.base}/session/${sessionId}`, {
      headers: bridge.headers,
    }).then((value) => value.json())) as { status: string };
    expect(forked.status).toBe("idle");
    // The source is untouched and usable.
    expect((await bridge.session()).status).toBe("idle");
    await bridge.send("DIRECT:two");
  });

  test("a fork at a message sends that turn's prompt index", async () => {
    const bridge = await grokBridge();
    await bridge.send("DIRECT:one");
    await bridge.send("DIRECT:two");
    const { messages } = await bridge.session();
    const firstAnswer = messages.find((message) => message.role === "assistant")!;

    expect((await bridge.fork({ upToMessageId: firstAnswer.id })).status).toBe(200);
    expect((await bridge.forkRequests())[0]).toMatchObject({ targetPromptIndex: 0 });
  });

  test("an unmappable message is refused before anything is forked", async () => {
    const bridge = await grokBridge();
    await bridge.send("DIRECT:one");

    const response = await bridge.fork({ upToMessageId: "no-such-row" });
    expect(response.status).toBe(422);
    expect(await bridge.forkRequests()).toEqual([]);
  });

  test("the agent's refusal answers fixed text, without its detail", async () => {
    const bridge = await grokBridge({ FAKE_ACP_FAIL_FORK: "1" });
    await bridge.send("DIRECT:one");

    const response = await bridge.fork();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "grok could not fork this session" });
    // A failed fork leaves the source free to take the next prompt.
    await bridge.send("DIRECT:two");
  });

  test("a reply with no session id is a failure, not a session", async () => {
    const bridge = await grokBridge({ FAKE_ACP_MALFORMED_FORK: "1" });
    await bridge.send("DIRECT:one");
    expect((await bridge.fork()).status).toBe(502);
  });

  test("a provider with no fork method answers 422", async () => {
    const created = await spawnBridge();
    const session = (await nativeFetch(`${created.base}/session/create`, {
      method: "POST",
      headers: created.headers,
    }).then((response) => response.json())) as { id: string };
    const response = await nativeFetch(`${created.base}/session/${session.id}/fork`, {
      method: "POST",
      headers: created.headers,
      body: "{}",
    });
    expect(response.status).toBe(422);
  });
});
