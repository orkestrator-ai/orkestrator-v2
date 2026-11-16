/**
 * The pure parts of the two-node check of to-do 4860 (retired; task 2): the
 * goal `scripts/qa-remote-goal-hold.ts` gives the leaf's worker (a goal the
 * leaf's own goal service accepts as running, held by a check that waits for
 * a file), and the gateway invoker (`scripts/two-node/harness.ts`) it reads
 * the command node through. The live run itself needs two backends. The
 * invoker is checked against a local stand-in node on an ephemeral port.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { goalIsRunning, isNativeAgentGoal } from "@orkestrator/protocol/native-agent-goal";

import { heldGoal, waitForFileCheck } from "../../scripts/qa-remote-goal-hold";
import { gatewayInvoker, InvokeError } from "../../scripts/two-node/harness";
import { nativeWebPlatform } from "../register-dom";

// The root preload installs Happy DOM's fetch, abort and Response classes; a
// loopback server and Bun's fetch need Bun's own.
const { Response, AbortController } = nativeWebPlatform;

describe("the remote goal hold's seeded goal", () => {
  test("is a valid running goal on the session's own provider session", () => {
    const goal = heldGoal({
      providerSessionId: "provider-1",
      check: waitForFileCheck("/work/release"),
      now: new Date("2026-11-13T00:00:00Z"),
    });
    expect(isNativeAgentGoal(goal)).toBe(true);
    expect(goalIsRunning(goal.status)).toBe(true);
    expect(goal).toMatchObject({ status: "checking", providerSessionId: "provider-1" });
    expect(goal.iterations).toBeLessThan(goal.maxIterations);
  });

  test("waits on a quoted path, so a space or a quote cannot split the check", () => {
    expect(waitForFileCheck("/a b/it's")).toBe(`until [ -f '/a b/it'"'"'s' ]; do sleep 1; done`);
  });
});

describe("the gateway invoker", () => {
  let server: ReturnType<typeof Bun.serve>;
  let node: { origin: string; token: string };
  const seen: Array<{ authorization: string | null; body: unknown }> = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const body = (await request.json()) as { command: string };
        seen.push({ authorization: request.headers.get("authorization"), body });
        switch (body.command) {
          case "ok":
            return Response.json({ result: { answer: 42 } });
          case "string-error":
            return Response.json({ error: "Unknown backend command: x" }, { status: 400 });
          case "object-error":
            return Response.json({ error: { message: "not allowed" } }, { status: 403 });
          case "plain-text":
            return new Response("upstream exploded", { status: 502 });
          case "long-text":
            return new Response("x".repeat(2_000), { status: 500 });
          case "slow":
            await Bun.sleep(5_000);
            return Response.json({ result: null });
          default:
            return new Response("unexpected", { status: 500 });
        }
      },
    });
    node = { origin: `http://127.0.0.1:${server.port}`, token: "test-token" };
  });

  afterAll(() => {
    server.stop(true);
  });

  async function failure(command: string): Promise<InvokeError> {
    try {
      await gatewayInvoker(node, nativeWebPlatform)(command);
    } catch (error) {
      expect(error).toBeInstanceOf(InvokeError);
      return error as InvokeError;
    }
    throw new Error(`${command} did not fail`);
  }

  test("posts the command with the node's bearer and returns the result", async () => {
    expect(
      await gatewayInvoker(node, nativeWebPlatform)<{ answer: number }>("ok", { a: 1 }),
    ).toEqual({ answer: 42 });
    expect(seen.at(-1)).toEqual({
      authorization: "Bearer test-token",
      body: { command: "ok", args: { a: 1 } },
    });
  });

  test("maps a string error, an object error and a non-JSON body to InvokeError", async () => {
    expect((await failure("string-error")).failure).toEqual({
      status: 400,
      message: "Unknown backend command: x",
    });
    expect((await failure("object-error")).failure).toEqual({
      status: 403,
      message: "not allowed",
    });
    expect((await failure("plain-text")).failure).toEqual({
      status: 502,
      message: "upstream exploded",
    });
  });

  test("bounds the message it keeps from a large body", async () => {
    expect((await failure("long-text")).failure.message).toHaveLength(500);
  });

  test("aborts when the caller's signal does", async () => {
    const controller = new AbortController();
    const pending = gatewayInvoker(node, nativeWebPlatform)(
      "slow",
      {},
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
