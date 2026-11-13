/**
 * Two Grok sessions on one bridge keep separate children and separate tab
 * credentials across a rotation (to-do 0024 task 6).
 *
 * The backend mints one Agent MCP token per tab and hands it to the bridge as
 * `agentMcp` on create, resume and attach. A rotated token must reload only the
 * session it belongs to: the sibling keeps its child and its own token, and no
 * token ever reaches a child's process environment, where every tool the agent
 * runs would inherit it.
 */
import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { nativeFetch, spawnBridge, temporaryDirectory } from "./acp-test-harness.js";

const MCP_URL = "http://127.0.0.1:4567/mcp";
/** Every token below starts with it, so the fake agent can scan its environment. */
const TOKEN_PREFIX = "rotation-probe-";

type SessionRequest = { method?: string; pid?: number; mcpServers?: unknown };

async function lines<T>(file: string): Promise<T[]> {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/** The bearer each child was given on `session/new` or `session/load`, in order. */
function bearers(requests: readonly SessionRequest[]): Array<{ pid: number; bearer: string }> {
  return requests
    .filter((entry) => entry.method === "session/new" || entry.method === "session/load")
    .map((entry) => {
      const match = /Bearer ([A-Za-z0-9-]+)/.exec(JSON.stringify(entry.mcpServers ?? []));
      return { pid: entry.pid ?? -1, bearer: match?.[1] ?? "" };
    });
}

describe("Grok sibling sessions", () => {
  test("a rotated tab token reloads only its own session's child, and no token reaches a child's environment", async () => {
    const directory = await temporaryDirectory();
    const credential = resolve(directory, "auth.json");
    const requestFile = resolve(directory, "requests.jsonl");
    const lifecycleFile = resolve(directory, "lifecycle.log");
    const envScanFile = resolve(directory, "env-scan.jsonl");
    await fs.writeFile(credential, "{}");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_PROVIDER: "grok",
        GROK_AUTH_FILE: credential,
        XAI_API_KEY: undefined,
        GROK_AUTH_PROVIDER_COMMAND: undefined,
        GROK_AUTH_METHOD_ID: undefined,
        // A process-wide credential would be the fallback for every session.
        ORKESTRATOR_AGENT_MCP_URL: undefined,
        ORKESTRATOR_AGENT_MCP_TOKEN: undefined,
        FAKE_ACP_SESSION_REQUEST_FILE: requestFile,
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_ENV_SCAN_FILE: envScanFile,
        FAKE_ACP_ENV_SCAN_PREFIX: TOKEN_PREFIX,
      },
    });
    const agentMcp = (tab: string) => ({ url: MCP_URL, token: `${TOKEN_PREFIX}${tab}` });
    const create = async (tab: string) =>
      (
        (await nativeFetch(`${base}/session/create`, {
          method: "POST",
          headers,
          body: JSON.stringify({ clientSessionKey: `tab-${tab}`, agentMcp: agentMcp(tab) }),
        }).then((response) => response.json())) as { id: string }
      ).id;
    const attach = (id: string, tab: string) =>
      nativeFetch(`${base}/session/${id}/attach`, {
        method: "POST",
        headers,
        body: JSON.stringify({ agentMcp: agentMcp(tab) }),
      });
    const lifecycle = async () =>
      (await fs.readFile(lifecycleFile, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [event, pid] = line.split(":");
          return { event: event!, pid: Number(pid) };
        });

    const first = await create("a1");
    const second = await create("b1");
    expect(first).not.toBe(second);
    expect((await attach(first, "a1")).status).toBe(200);
    expect((await attach(second, "b1")).status).toBe(200);

    const started = bearers(await lines<SessionRequest>(requestFile));
    expect(started.map((entry) => entry.bearer)).toEqual([
      `${TOKEN_PREFIX}a1`,
      `${TOKEN_PREFIX}b1`,
    ]);
    const [firstChild, secondChild] = started.map((entry) => entry.pid);
    // Two sessions, two children: a sibling never shares the other's process.
    expect(firstChild).not.toBe(secondChild);

    // The first tab's token is rotated; the second tab attaches again unchanged.
    expect((await attach(first, "a2")).status).toBe(200);
    expect((await attach(second, "b1")).status).toBe(200);

    const after = bearers(await lines<SessionRequest>(requestFile));
    const reloads = after.slice(started.length);
    // Exactly one reload, in a new child, carrying only the rotated token.
    expect(reloads).toHaveLength(1);
    expect(reloads[0]!.bearer).toBe(`${TOKEN_PREFIX}a2`);
    expect([firstChild, secondChild]).not.toContain(reloads[0]!.pid);
    const events = await lifecycle();
    expect(events.filter((entry) => entry.event === "stop").map((entry) => entry.pid)).toEqual([
      firstChild,
    ]);
    expect(events.filter((entry) => entry.event === "start")).toHaveLength(3);

    // Neither session was ever handed the other's credential.
    const byChild = new Map<number, string[]>();
    for (const entry of after)
      byChild.set(entry.pid, [...(byChild.get(entry.pid) ?? []), entry.bearer]);
    expect(byChild.get(secondChild!)).toEqual([`${TOKEN_PREFIX}b1`]);
    for (const [pid, tokens] of byChild) {
      if (pid === secondChild) continue;
      expect(tokens.some((token) => token.startsWith(`${TOKEN_PREFIX}b`))).toBe(false);
    }

    // The tokens travel in `mcpServers` only, never in a child's environment.
    const scans = await lines<{ pid: number; keys: string[] }>(envScanFile);
    expect(scans).toHaveLength(3);
    expect(scans.flatMap((scan) => scan.keys)).toEqual([]);
  });
});
