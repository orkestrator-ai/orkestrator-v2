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

  // Security report M13: a session whose policy denies writes and commands is
  // neither offered nor served them, whatever the agent then asks for.
  for (const denial of ["capabilities", "readOnly", "approvals"] as const) {
    test(`neither advertises nor serves writes and terminals under ${denial}`, async () => {
      const directory = await temporaryDirectory();
      const target = resolve(directory, "agent-written.txt");
      const initializeFile = resolve(directory, "initialize.jsonl");
      const { base, headers } = await spawnBridge({
        env: {
          ACP_PROVIDER: "grok",
          CWD: directory,
          FAKE_ACP_CLIENT_FILE: target,
          FAKE_ACP_INITIALIZE_REQUEST_FILE: initializeFile,
        },
      });
      const created = (await nativeFetch(`${base}/session/create`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          readOnly: denial === "readOnly",
          policy: {
            id: "pipeline",
            sandbox: "none",
            approvals: denial === "approvals" ? "deny" : "auto-approve",
            projectResources: false,
            networkAccess: "full",
            capabilityPolicy: {
              deny: denial === "capabilities" ? ["file.write", "file.patch", "shell.mutate"] : [],
            },
          },
        }),
      }).then((response) => response.json())) as { id: string };
      expect(
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "ACP_CLIENT_METHODS" }),
        }).then((response) => response.status),
      ).toBe(202);
      await waitFor(
        () =>
          nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
            response.json(),
          ) as Promise<{ status: string }>,
        (value) => value.status === "idle",
      );
      const initialize = JSON.parse(
        (await fs.readFile(initializeFile, "utf8")).trim().split("\n").at(-1)!,
      ) as { params: { clientCapabilities: unknown } };
      expect(initialize.params.clientCapabilities).toMatchObject({
        fs: { readTextFile: true, writeTextFile: false },
        terminal: false,
      });
      await expect(fs.readFile(target, "utf8")).rejects.toThrow();
      const responses = new Map(
        (await fs.readFile(`${target}.responses.jsonl`, "utf8"))
          .trim()
          .split("\n")
          .map(
            (line) => JSON.parse(line) as { id: number; error?: { code: number; message: string } },
          )
          .map((response) => [response.id, response]),
      );
      for (const id of [910, 912]) {
        expect(responses.get(id)?.error).toMatchObject({
          code: -32601,
          message: expect.stringContaining("refused by this session's execution policy"),
        });
      }
    });
  }
});
