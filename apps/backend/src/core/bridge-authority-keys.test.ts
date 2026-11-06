import { afterEach, describe, expect, test } from "bun:test";
import {
  BRIDGE_AUTHORITY_HEADER,
  bridgeAuthorityFromPublicKey,
  mintBridgeAuthorityKeyPair,
} from "@orkestrator/protocol/node/bridge-authority";
import {
  bridgeAuthorityHeaders,
  forgetBridgeAuthorityKey,
  hasBridgeAuthorityKey,
  rememberBridgeAuthorityKey,
} from "./bridge-authority-keys.js";
import { bridgeFetch } from "./http-bridge-transport.js";
import { LocalServerRuntime } from "./local-server-runtime.js";

const TOKEN = `okb_${"k".repeat(43)}`;
const remembered: string[] = [];

function remember(token: string, privateKey: string): void {
  remembered.push(token);
  rememberBridgeAuthorityKey(token, privateKey);
}

afterEach(() => {
  for (const token of remembered.splice(0)) forgetBridgeAuthorityKey(token);
});

describe("bridge authority keys", () => {
  test("bridgeFetch signs what changes authority, with the key minted for that token", async () => {
    const keys = mintBridgeAuthorityKeyPair();
    remember(TOKEN, keys.privateKey);
    const verifier = bridgeAuthorityFromPublicKey(keys.publicKey);
    const sent: Array<{ url: string; method: string; header: string | null; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        method: init.method ?? "GET",
        header: new Headers(init.headers).get(BRIDGE_AUTHORITY_HEADER),
        body: typeof init.body === "string" ? init.body : "",
      });
      return new Response("{}");
    }) as unknown as typeof fetch;
    const connection = { agent: "pi" as const, baseUrl: "http://127.0.0.1:4101", authToken: TOKEN };

    const answer = JSON.stringify({ decision: "approve" });
    await bridgeFetch(
      connection,
      "/session/s/approvals/r?x=1",
      { method: "POST", body: answer },
      fetchImpl,
    );
    await bridgeFetch(connection, "/session/s/messages", {}, fetchImpl);
    await bridgeFetch(connection, "/session/s/close", { method: "POST", body: "{}" }, fetchImpl);
    // A bridge with no key, such as one an older image started, gets no header.
    await bridgeFetch(
      { ...connection, authToken: `okb_${"n".repeat(43)}` },
      "/session/s/approvals/r",
      { method: "POST", body: answer },
      fetchImpl,
    );

    expect(sent.map((entry) => entry.header !== null)).toEqual([true, false, false, false]);
    expect(
      verifier.check({
        method: sent[0]!.method,
        url: sent[0]!.url,
        header: sent[0]!.header,
        body: Buffer.from(sent[0]!.body),
      }),
    ).toEqual({ ok: true });
  });

  test("a key that does not parse is not kept", () => {
    remember(TOKEN, "not-a-key");
    expect(hasBridgeAuthorityKey(TOKEN)).toBe(false);
  });

  test("a host bridge's key leaves with its token, and only when that token goes", () => {
    const runtime = new LocalServerRuntime();
    const first = `okb_${"1".repeat(43)}`;
    const second = `okb_${"2".repeat(43)}`;
    remember(first, mintBridgeAuthorityKeyPair().privateKey);
    runtime.recordBridgeToken("pi", "env", first);
    // Recording the same token again keeps its key.
    runtime.recordBridgeToken("pi", "env", first);
    expect(hasBridgeAuthorityKey(first)).toBe(true);

    remember(second, mintBridgeAuthorityKeyPair().privateKey);
    runtime.recordBridgeToken("pi", "env", second);
    expect(hasBridgeAuthorityKey(first)).toBe(false);
    expect(hasBridgeAuthorityKey(second)).toBe(true);

    runtime.forgetBridgeToken("pi", "env");
    expect(hasBridgeAuthorityKey(second)).toBe(false);
  });

  test("signing touches a key, so the bound evicts the least recently used", () => {
    const keys = mintBridgeAuthorityKeyPair();
    remember(TOKEN, keys.privateKey);
    for (let index = 0; index < 1_023; index += 1) {
      remember(`okb_filler-${index}`, keys.privateKey);
    }
    // Used now, so the next arrival evicts the oldest filler instead.
    expect(bridgeAuthorityHeaders(TOKEN, "POST", "/session/create", "{}")).not.toEqual({});
    remember("okb_newest", keys.privateKey);
    expect(hasBridgeAuthorityKey(TOKEN)).toBe(true);
    expect(hasBridgeAuthorityKey("okb_filler-0")).toBe(false);
  });
});
