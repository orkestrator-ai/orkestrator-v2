import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { nativeFetch, spawnBridge, temporaryDirectory, waitFor } from "./acp-test-harness.js";

describe("ACP protocol generalization", () => {
  test("advertises filesystem and terminal capabilities and authenticates", async () => {
    const directory = await temporaryDirectory();
    const initializeFile = resolve(directory, "initialize.jsonl");
    const authenticateFile = resolve(directory, "authenticate.jsonl");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_PROVIDER: "grok",
        FAKE_ACP_INITIALIZE_REQUEST_FILE: initializeFile,
        FAKE_ACP_AUTH_METHOD: "test-login",
        FAKE_ACP_AUTH_REQUEST_FILE: authenticateFile,
      },
    });
    expect(
      await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
        (response) => response.status,
      ),
    ).toBe(201);
    const initialize = JSON.parse(
      (
        await waitFor(
          () => fs.readFile(initializeFile, "utf8").catch(() => ""),
          (value) => value.trim().length > 0,
        )
      ).trim(),
    ) as { params: { clientCapabilities: unknown } };
    expect(initialize.params.clientCapabilities).toMatchObject({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    });
    const authenticate = JSON.parse(
      (
        await waitFor(
          () => fs.readFile(authenticateFile, "utf8").catch(() => ""),
          (value) => value.trim().length > 0,
        )
      ).trim(),
    ) as { params: unknown };
    expect(authenticate.params).toEqual({ methodId: "test-login" });
  });

  test("refuses an unsupported negotiated protocol version", async () => {
    const { base, headers } = await spawnBridge({
      env: { ACP_PROVIDER: "grok", FAKE_ACP_PROTOCOL_VERSION: "2" },
    });
    const response = await nativeFetch(`${base}/session/create`, { method: "POST", headers });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("unsupported ACP protocol version 2");
  });

  test("serves filesystem and bounded terminal requests from the fake agent", async () => {
    const directory = await temporaryDirectory();
    const target = resolve(directory, "agent-written.txt");
    const { base, headers } = await spawnBridge({
      env: { ACP_PROVIDER: "grok", CWD: directory, FAKE_ACP_CLIENT_FILE: target },
    });
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json())) as { id: string };
    expect(
      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "ACP_CLIENT_METHODS" }),
      }).then((response) => response.status),
    ).toBe(202);
    const session = await waitFor(
      () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<{ toolOutput?: string }> }>;
        }>,
      (value) => value.status === "idle",
    );
    expect(await fs.readFile(target, "utf8")).toBe("written by ACP");
    expect(session.messages.flatMap((message) => message.parts)).toContainEqual(
      expect.objectContaining({ toolOutput: "terminal-inline" }),
    );
  });
});
