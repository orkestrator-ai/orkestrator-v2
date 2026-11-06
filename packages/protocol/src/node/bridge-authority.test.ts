import { describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  admitFetchBridgeRequest,
  admitNodeBridgeRequest,
  BRIDGE_AUTHORITY_HEADER,
  BRIDGE_AUTHORITY_REFUSED_CODE,
  BRIDGE_AUTHORITY_WINDOW_MS,
  bridgeAuthorityFromPublicKey,
  bridgeAuthorityKeyEnv,
  bridgeRequestNeedsAuthority,
  loadBridgeAuthority,
  mintBridgeAuthorityKeyPair,
  signBridgeRequest,
  takeAdmittedBody,
} from "./bridge-authority";

const NOW = 1_800_000_000_000;
const ANSWER = "/session/s-1/approvals/request-1";
const BODY = JSON.stringify({ decision: "approve" });

function signed(
  privateKey: string,
  overrides: { method?: string; url?: string; body?: string; now?: number; nonce?: string } = {},
) {
  return signBridgeRequest(
    privateKey,
    {
      method: overrides.method ?? "POST",
      url: overrides.url ?? ANSWER,
      body: overrides.body ?? BODY,
    },
    { now: overrides.now ?? NOW, nonce: overrides.nonce },
  );
}

describe("bridge authority signatures", () => {
  test("the backend's signature is accepted once, and nothing else changes authority", () => {
    const keys = mintBridgeAuthorityKeyPair();
    const authority = bridgeAuthorityFromPublicKey(keys.publicKey, { now: () => NOW });
    const header = signed(keys.privateKey);
    const request = { method: "POST", url: ANSWER, header, body: Buffer.from(BODY) };

    expect(authority.enforced).toBe(true);
    expect(authority.check(request)).toEqual({ ok: true });
    // The same signature again is a replay, whoever presents it.
    expect(authority.check(request)).toEqual({ ok: false, reason: "replayed" });
    expect(authority.check({ ...request, header: undefined })).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(authority.check({ ...request, header: "Bearer okb_x" })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("a signature covers the method, the path and query, and the body", () => {
    const keys = mintBridgeAuthorityKeyPair();
    const authority = bridgeAuthorityFromPublicKey(keys.publicKey, { now: () => NOW });
    const header = signed(keys.privateKey, { url: `${ANSWER}?directory=/workspace` });
    const base = { method: "POST", url: `${ANSWER}?directory=/workspace`, header };

    // An imposter that caught this request cannot turn it into a different one.
    expect(authority.check({ ...base, body: Buffer.from('{"decision":"deny"}') })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(
      authority.check({
        ...base,
        url: "/session/s-2/approvals/request-1",
        body: Buffer.from(BODY),
      }),
    ).toEqual({ ok: false, reason: "invalid" });
    expect(authority.check({ ...base, url: ANSWER, body: Buffer.from(BODY) })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(authority.check({ ...base, method: "PUT", body: Buffer.from(BODY) })).toEqual({
      ok: false,
      reason: "invalid",
    });
    // A full URL and the path alone name the same target.
    expect(
      authority.check({
        ...base,
        url: `http://127.0.0.1:4097${ANSWER}?directory=/workspace`,
        body: Buffer.from(BODY),
      }),
    ).toEqual({ ok: true });
  });

  test("another bridge's key, or a key that does not parse, signs nothing here", () => {
    const keys = mintBridgeAuthorityKeyPair();
    const other = mintBridgeAuthorityKeyPair();
    const authority = bridgeAuthorityFromPublicKey(keys.publicKey, { now: () => NOW });
    expect(
      authority.check({
        method: "POST",
        url: ANSWER,
        header: signed(other.privateKey),
        body: Buffer.from(BODY),
      }),
    ).toEqual({ ok: false, reason: "invalid" });

    // A malformed key fails closed: every request that needs a signature is refused.
    const broken = bridgeAuthorityFromPublicKey("not-a-key", { now: () => NOW });
    expect(broken.enforced).toBe(true);
    expect(
      broken.check({
        method: "POST",
        url: ANSWER,
        header: signed(keys.privateKey),
        body: Buffer.from(BODY),
      }),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  test("a signature outside the window is stale, either side of now", () => {
    const keys = mintBridgeAuthorityKeyPair();
    const authority = bridgeAuthorityFromPublicKey(keys.publicKey, { now: () => NOW });
    const at = (now: number) => ({
      method: "POST",
      url: ANSWER,
      header: signed(keys.privateKey, { now }),
      body: Buffer.from(BODY),
    });
    expect(authority.check(at(NOW - BRIDGE_AUTHORITY_WINDOW_MS - 1))).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(authority.check(at(NOW + BRIDGE_AUTHORITY_WINDOW_MS + 1))).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(authority.check(at(NOW - BRIDGE_AUTHORITY_WINDOW_MS + 1))).toEqual({ ok: true });
  });

  test("past its nonce bound the verifier refuses what it can no longer tell apart", () => {
    const keys = mintBridgeAuthorityKeyPair();
    const authority = bridgeAuthorityFromPublicKey(keys.publicKey, {
      now: () => NOW,
      maxNonces: 2,
    });
    const requests = [NOW - 3, NOW - 2, NOW - 1].map((now) => ({
      method: "POST",
      url: ANSWER,
      header: signed(keys.privateKey, { now }),
      body: Buffer.from(BODY),
    }));
    for (const request of requests) expect(authority.check(request)).toEqual({ ok: true });
    // The first nonce was forgotten, so its replay is refused as stale, not accepted.
    expect(authority.check(requests[0]!)).toEqual({ ok: false, reason: "stale" });
    expect(authority.check(requests[2]!)).toEqual({ ok: false, reason: "replayed" });
  });

  test("reads and the routes that only narrow need no signature", () => {
    expect(bridgeRequestNeedsAuthority("GET", "/session/s/messages")).toBe(false);
    expect(bridgeRequestNeedsAuthority("HEAD", ANSWER)).toBe(false);
    expect(bridgeRequestNeedsAuthority("POST", "/session/s-1/close")).toBe(false);
    expect(bridgeRequestNeedsAuthority("POST", "/sessions/activity")).toBe(false);
    expect(bridgeRequestNeedsAuthority("POST", "/debug/log-policy")).toBe(false);
    // Everything else that writes does: answers, prompts, policy and config.
    expect(bridgeRequestNeedsAuthority("POST", ANSWER)).toBe(true);
    expect(bridgeRequestNeedsAuthority("POST", "/session/create")).toBe(true);
    expect(bridgeRequestNeedsAuthority("POST", "/session/s/prompt_async")).toBe(true);
    expect(bridgeRequestNeedsAuthority("PATCH", "/session/s/config")).toBe(true);
    expect(bridgeRequestNeedsAuthority("DELETE", "/session/s")).toBe(true);
    expect(bridgeRequestNeedsAuthority("POST", "/session/s/close/extra")).toBe(true);
  });

  test("a bridge given no key enforces nothing, and the key leaves its environment", () => {
    const env: NodeJS.ProcessEnv = {};
    const none = loadBridgeAuthority("TEST_BRIDGE_TOKEN", { env });
    expect(none.enforced).toBe(false);
    expect(none.requires("POST", ANSWER)).toBe(false);

    const keys = mintBridgeAuthorityKeyPair();
    const withKey: NodeJS.ProcessEnv = {
      [bridgeAuthorityKeyEnv("TEST_BRIDGE_TOKEN")]: ` ${keys.publicKey} `,
    };
    const loaded = loadBridgeAuthority("TEST_BRIDGE_TOKEN", { env: withKey, now: () => NOW });
    expect(withKey).toEqual({});
    expect(loaded.enforced).toBe(true);
    expect(
      loaded.check({
        method: "POST",
        url: ANSWER,
        header: signed(keys.privateKey),
        body: Buffer.from(BODY),
      }),
    ).toEqual({ ok: true });
  });
});

describe("bridge request admission", () => {
  test("a Fetch bridge refuses an unsigned change and hands the handler the checked body", async () => {
    const keys = mintBridgeAuthorityKeyPair();
    const authority = bridgeAuthorityFromPublicKey(keys.publicKey);
    const url = `http://127.0.0.1:4097${ANSWER}`;

    const unsigned = await admitFetchBridgeRequest(
      authority,
      new Request(url, { method: "POST", body: BODY }),
    );
    expect(unsigned).toMatchObject({
      refusal: { status: 403, body: { code: BRIDGE_AUTHORITY_REFUSED_CODE, reason: "missing" } },
    });

    const admitted = await admitFetchBridgeRequest(
      authority,
      new Request(url, {
        method: "POST",
        headers: {
          [BRIDGE_AUTHORITY_HEADER]: signBridgeRequest(keys.privateKey, {
            method: "POST",
            url,
            body: BODY,
          }),
        },
        body: BODY,
      }),
    );
    expect("request" in admitted && admitted.request).toBeTruthy();
    expect(await (admitted as { request: Request }).request.json()).toEqual(JSON.parse(BODY));

    // A read passes untouched and unread.
    expect(await admitFetchBridgeRequest(authority, new Request(url))).toEqual({});
  });

  test("admits the backend's full 32 MiB decoded inline image allowance", async () => {
    const keys = mintBridgeAuthorityKeyPair();
    const authority = bridgeAuthorityFromPublicKey(keys.publicKey);
    const url = "http://127.0.0.1:4097/session/s/prompt_async";
    const data = Buffer.alloc(8 * 1024 * 1024).toString("base64");
    const body = JSON.stringify({
      prompt: "Inspect these screenshots",
      attachments: Array.from({ length: 4 }, (_, index) => ({
        type: "image",
        filename: `${index}.png`,
        dataUrl: `data:image/png;base64,${data}`,
      })),
    });
    const admission = await admitFetchBridgeRequest(
      authority,
      new Request(url, {
        method: "POST",
        body,
        headers: {
          [BRIDGE_AUTHORITY_HEADER]: signBridgeRequest(keys.privateKey, {
            method: "POST",
            url,
            body,
          }),
        },
      }),
    );
    expect("refusal" in admission).toBe(false);
    expect(await (admission as { request: Request }).request.text()).toBe(body);
  });

  test("a Fetch bridge bounds the body it buffers to check", async () => {
    const keys = mintBridgeAuthorityKeyPair();
    const authority = bridgeAuthorityFromPublicKey(keys.publicKey);
    const url = `http://127.0.0.1:4097${ANSWER}`;
    const body = "x".repeat(64);
    const result = await admitFetchBridgeRequest(
      authority,
      new Request(url, {
        method: "POST",
        headers: {
          [BRIDGE_AUTHORITY_HEADER]: signBridgeRequest(keys.privateKey, {
            method: "POST",
            url,
            body,
          }),
        },
        body,
      }),
      16,
    );
    expect(result).toMatchObject({ refusal: { status: 413 } });
  });

  test("a node:http bridge checks the body it then parses", async () => {
    const keys = mintBridgeAuthorityKeyPair();
    const authority = bridgeAuthorityFromPublicKey(keys.publicKey);
    const seen: Array<{ status: number; body: string }> = [];
    const server = createServer(async (request: IncomingMessage, response) => {
      const refused = await admitNodeBridgeRequest(authority, request, 1024);
      if (refused) {
        response.writeHead(refused.status, { "content-type": "application/json" });
        response.end(JSON.stringify(refused.body));
        return;
      }
      const admitted = takeAdmittedBody(request);
      response.writeHead(200);
      response.end(admitted ? admitted.toString("utf8") : "unread");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      const post = async (headers: Record<string, string>, body = BODY, path = ANSWER) => {
        const response = await fetch(`${base}${path}`, { method: "POST", headers, body });
        seen.push({ status: response.status, body: await response.text() });
      };
      await post({});
      await post({
        [BRIDGE_AUTHORITY_HEADER]: signBridgeRequest(keys.privateKey, {
          method: "POST",
          url: ANSWER,
          body: '{"decision":"deny"}',
        }),
      });
      await post({
        [BRIDGE_AUTHORITY_HEADER]: signBridgeRequest(keys.privateKey, {
          method: "POST",
          url: ANSWER,
          body: BODY,
        }),
      });
      await post({}, "{}", "/session/s-1/close");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(seen.map((entry) => entry.status)).toEqual([403, 403, 200, 200]);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ reason: "missing" });
    expect(JSON.parse(seen[1]!.body)).toMatchObject({ reason: "invalid" });
    expect(seen[2]!.body).toBe(BODY);
    // An unsigned route is not read here; its handler reads it itself.
    expect(seen[3]!.body).toBe("unread");
  });
});
