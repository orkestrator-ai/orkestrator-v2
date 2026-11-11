/**
 * The OpenCode server a bridge connection names when a caller injects no
 * server dependencies (`openCodeServerFromConnection`): the password is the
 * connection's token, the directory defaults to the container workspace, and
 * the generation follows a hash of the token.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  createNativeAgentProvider,
  openCodeServerFromConnection,
} from "./native-agent-provider.js";
import { OPENCODE2_CONTAINER_DIRECTORY } from "./opencode2/container-server.js";
import { FakeOpenCode2Server } from "./opencode2/fake-server.test-support.js";

// Fake values only; nothing here is a real credential.
const TOKEN = "fake-bridge-token";

let stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.reverse()) stop();
  stops = [];
});

/** A fake 2.x server behind a proxy that records each request's auth and location headers. */
function recordingServer() {
  const fake = new FakeOpenCode2Server();
  const seen: Array<{ authorization: string | null; directory: string | null }> = [];
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      seen.push({
        authorization: request.headers.get("authorization"),
        directory: request.headers.get("x-opencode-directory"),
      });
      const url = new URL(request.url);
      const body = request.method === "GET" ? undefined : await request.text();
      return fetch(`${fake.baseUrl}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        ...(body ? { body } : {}),
      });
    },
  });
  stops.push(
    () => fake.stop(),
    () => proxy.stop(true),
  );
  return { baseUrl: `http://127.0.0.1:${proxy.port}`, seen };
}

describe("openCodeServerFromConnection", () => {
  test("takes the password from the token and defaults the directory to the container workspace", async () => {
    const server = await openCodeServerFromConnection({
      agent: "opencode",
      baseUrl: "http://127.0.0.1:4096",
      authToken: TOKEN,
    }).connection({ start: true });
    expect(server).toMatchObject({
      baseUrl: "http://127.0.0.1:4096",
      password: TOKEN,
      directory: OPENCODE2_CONTAINER_DIRECTORY,
    });
    expect(
      (
        await openCodeServerFromConnection({
          agent: "opencode",
          baseUrl: "http://127.0.0.1:4096",
          authToken: TOKEN,
          directory: "/work/project",
        }).connection({ start: true })
      )?.directory,
    ).toBe("/work/project");
  });

  test("the generation follows the token's hash, never the token itself", async () => {
    const generation = async (authToken: string) =>
      (
        await openCodeServerFromConnection({
          agent: "opencode",
          baseUrl: "http://127.0.0.1:4096",
          authToken,
        }).connection({ start: true })
      )?.generation;
    const first = await generation(TOKEN);
    expect(first).toBe(await generation(TOKEN));
    expect(first).not.toBe(await generation("another-fake-token"));
    expect(first).toStartWith("http://127.0.0.1:4096#");
    expect(first).not.toContain(TOKEN);
    // An empty token: an empty password and a generation of its own, not a throw.
    expect(await generation("")).toMatch(/^http:\/\/127\.0\.0\.1:4096#[0-9a-f]{12}$/);
  });

  test("a provider built without server dependencies reaches that server with them", async () => {
    const { baseUrl, seen } = recordingServer();
    const provider = createNativeAgentProvider({ agent: "opencode", baseUrl, authToken: TOKEN });
    try {
      expect(await provider.status("ses_unknown")).toBe("missing");
    } finally {
      await provider.dispose?.();
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.authorization).toBe(`Basic ${btoa(`opencode:${TOKEN}`)}`);
      expect(request.directory).toBe(OPENCODE2_CONTAINER_DIRECTORY);
    }
  });
});
