import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { nativeFetch, spawnBridge, temporaryDirectory, waitFor } from "./acp-test-harness.js";

describe("policy continuation through HTTP completion", () => {
  test.each([false, true])(
    "structured recovery and terminal journal (exhausted=%s)",
    async (exhausted) => {
      const { base, headers } = await spawnBridge({
        env: {
          ACP_PROVIDER: "grok",
          FAKE_ACP_POLICY_EXHAUST: exhausted ? "1" : "0",
        },
      });
      const { id } = (await nativeFetch(`${base}/session/create`, {
        method: "POST",
        headers,
        body: JSON.stringify({ readOnly: true }),
      }).then((r) => r.json())) as { id: string };
      const requestId = "policy-structured";
      const response = await nativeFetch(`${base}/session/${id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: "POLICYDENIAL:report",
          requestId,
          readOnly: true,
          outputSchema: { type: "object" },
        }),
      });
      expect(response.status).toBe(202);
      const journal = await waitFor(
        () =>
          nativeFetch(`${base}/session/${id}/dispatch?requestId=${requestId}`, { headers }).then(
            (r) => r.json(),
          ) as Promise<{ turn?: { state: string; error?: string } }>,
        (value) => value.turn !== undefined,
      );
      if (exhausted) {
        expect(journal.turn?.error).toMatch(
          /kept ending the turn on tool calls this session's policy refuses/,
        );
      } else {
        expect(journal.turn).toEqual({ state: "completed" });
        const result = await nativeFetch(
          `${base}/session/${id}/structured-output?requestId=${requestId}`,
          { headers },
        ).then((r) => r.json());
        expect(result).toMatchObject({ structuredOutput: { ok: true, value: { ok: true } } });
        const session = await nativeFetch(`${base}/session/${id}`, { headers }).then((r) =>
          r.json(),
        );
        expect(session).toMatchObject({
          contextUsage: {
            usedTokens: 80,
            lastTurnTokens: 42,
            sessionTokens: 42,
            costUsd: 0.3,
          },
        });
      }
    },
  );
});

test("Grok tool profile follows read-only create and reattach, and is removed on close", async () => {
  const argsFile = join(await temporaryDirectory(), "args.jsonl");
  const { base, headers } = await spawnBridge({
    env: { ACP_PROVIDER: "grok", FAKE_ACP_ARGS_FILE: argsFile },
  });
  const { id } = (await nativeFetch(`${base}/session/create`, {
    method: "POST",
    headers,
    body: JSON.stringify({ readOnly: true }),
  }).then((r) => r.json())) as { id: string };
  const readArgs = async () =>
    (await fs.readFile(argsFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
  const profilePath = (args: string[]) => args[args.indexOf("--agent-profile") + 1]!;
  const first = (await readArgs()).at(-1)!;
  expect(first).toContain("--no-leader");
  const path = profilePath(first);
  const profile = await fs.readFile(path, "utf8");
  for (const tool of ["write", "search_replace", "run_terminal_cmd", "Agent", "monitor"]) {
    expect(profile).toContain(`  - ${tool}\n`);
  }
  for (const readOnly of [false, true]) {
    expect(
      (
        await nativeFetch(`${base}/session/${id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "DIRECT:done", readOnly }),
        })
      ).status,
    ).toBe(202);
    await waitFor(
      () =>
        nativeFetch(`${base}/session/${id}/status`, { headers }).then((r) => r.json()) as Promise<{
          status: string;
        }>,
      (state) => state.status === "idle",
    );
    const args = (await readArgs()).at(-1)!;
    expect(args.includes("--agent-profile")).toBe(readOnly);
  }
  expect(await fs.stat(path).catch(() => null)).toBeNull();
  const finalPath = profilePath((await readArgs()).at(-1)!);
  expect(
    (await nativeFetch(`${base}/session/${id}/close`, { method: "POST", headers })).status,
  ).toBe(200);
  expect(await fs.stat(finalPath).catch(() => null)).toBeNull();
});
