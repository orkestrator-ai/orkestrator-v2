/**
 * The terminals, files and claude-tmux domain clients over a `lib/backend`
 * factory client (plan item 7002), against fake nodes: version 1 for a node
 * that advertises the domain (envelope, decoded results), version 0 for a
 * pre-contract node or a client without negotiation (today's exact calls,
 * answered as sent), and a new connection generation picking again.
 */
import { describe, expect, mock, test } from "bun:test";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";
import type { BackendClient } from "@/lib/backend/client";
import { createSignal } from "@/lib/node-scope/signal";
import { claudeTmux } from "./claude-tmux";
import { rendererValidatesHotPathResults } from "./domain-api";
import { files } from "./files";
import { terminals } from "./terminals";

const CURRENT: NegotiatedDomains = {
  terminals: { min: 1, max: 1 },
  files: { min: 1, max: 1 },
  "claude-tmux": { min: 1, max: 1 },
};

function fakeClient(answer: (command: string) => unknown, domains?: NegotiatedDomains | null) {
  const invokeRaw = mock(async (command: string, _args?: unknown, _options?: unknown) =>
    answer(command),
  );
  const signal =
    domains === undefined ? undefined : createSignal<NegotiatedDomains | null>(domains);
  const client: BackendClient = {
    invokeRaw: invokeRaw as unknown as BackendClient["invokeRaw"],
    ...(signal
      ? { domains: signal, capabilities: createSignal<ReadonlySet<string> | null>(null) }
      : {}),
  };
  return { client, invokeRaw, signal };
}

describe("domain clients over a lib/backend client", () => {
  test("a client without negotiation sends today's calls and gets the answers as sent", async () => {
    const { client, invokeRaw } = fakeClient((command) =>
      command === "read_local_file"
        ? { path: "a", content: "x", language: "ts", extra: 1 }
        : undefined,
    );
    await terminals(client).terminal_write({ sessionId: "s", data: "x" });
    const read = await files(client).read_local_file({ worktreePath: "/w", filePath: "a" });
    expect(invokeRaw.mock.calls).toEqual([
      ["terminal_write", { sessionId: "s", data: "x" }],
      ["read_local_file", { worktreePath: "/w", filePath: "a" }],
    ] as never);
    // Version 0 does not decode: the extra key survives, as with `invoke<T>`.
    expect(read).toEqual({ path: "a", content: "x", language: "ts", extra: 1 } as never);
  });

  test("a pre-contract node (no domains) takes version 0 too", async () => {
    const { client, invokeRaw } = fakeClient(() => null, null);
    await expect(
      claudeTmux(client).claude_tmux_status({ environmentId: "e", tabId: "t" }),
    ).resolves.toBeNull();
    expect(invokeRaw.mock.calls).toEqual([
      ["claude_tmux_status", { environmentId: "e", tabId: "t" }],
    ] as never);
  });

  test("a node with the domain gets the envelope, critical keys and decoded results", async () => {
    const { client, invokeRaw } = fakeClient(
      (command) =>
        command === "write_local_file"
          ? "src/a.ts"
          : { path: "a", content: "x", language: "ts", extra: 1 },
      CURRENT,
    );
    await files(client).write_local_file({
      worktreePath: "/w",
      filePath: "src/a.ts",
      base64Data: "",
      expected: { sha256: "0".repeat(64) },
    });
    const read = await files(client).read_local_file({ worktreePath: "/w", filePath: "a" });
    expect(invokeRaw.mock.calls[0]?.[2]).toEqual({
      envelope: { domain: "files", version: 1, critical: ["expected"] },
    });
    expect(invokeRaw.mock.calls[1]?.[2]).toEqual({ envelope: { domain: "files", version: 1 } });
    expect(read).toEqual({ path: "a", content: "x", language: "ts" });
  });

  test("a malformed answer from a current node is refused, hot path included in tests", async () => {
    expect(rendererValidatesHotPathResults()).toBe(true);
    const { client } = fakeClient(() => ({ delivered: "yes" }), CURRENT);
    await expect(terminals(client).terminal_write({ sessionId: "s", data: "x" })).rejects.toThrow(
      /Invalid result from terminal_write/u,
    );
  });

  test("production renderers skip hot-path result decoding", () => {
    expect(rendererValidatesHotPathResults({ DEV: false, MODE: "production" })).toBe(false);
    expect(rendererValidatesHotPathResults({ DEV: true, MODE: "development" })).toBe(true);
    expect(rendererValidatesHotPathResults({ NODE_ENV: "test" })).toBe(true);
  });

  test("a new connection generation picks the adapter again", async () => {
    const { client, invokeRaw, signal } = fakeClient(() => undefined, null);
    await terminals(client).detach_terminal({ sessionId: "s" });
    signal!.set({ ...CURRENT });
    await terminals(client).detach_terminal({ sessionId: "s" });
    expect(invokeRaw.mock.calls[0]).toEqual(["detach_terminal", { sessionId: "s" }] as never);
    expect(invokeRaw.mock.calls[1]?.[2]).toEqual({ envelope: { domain: "terminals", version: 1 } });
  });
});
