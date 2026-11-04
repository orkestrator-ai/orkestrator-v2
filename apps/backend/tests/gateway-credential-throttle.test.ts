import { describe, expect, test } from "bun:test";
import { Agent, request as httpRequest } from "node:http";
import {
  FIRST_PAUSE_MS,
  FREE_WRONG_GUESSES,
  GatewayCredentialThrottle,
  GUESS_MEMORY_MS,
  MAX_PAUSE_MS,
  MAX_PROVEN_PEERS,
  MAX_REMEMBERED_GUESSES,
  type GuessPeer,
} from "../src/gateway-credential-throttle";
import { requestUrl, startGateway } from "./gateway-test-harness.js";

const TOKEN = "the-real-gateway-token";

function peer(remoteAddress = "127.0.0.1", localPort = 34121): GuessPeer {
  return { socket: { remoteAddress, localPort } } as unknown as GuessPeer;
}

function clocked() {
  let time = 1_000_000;
  const throttle = new GatewayCredentialThrottle(() => time);
  return { throttle, advance: (ms: number) => (time += ms) };
}

/** Spends every free wrong value, which opens the first pause. */
function exhaust(throttle: GatewayCredentialThrottle, from: GuessPeer, prefix = "guess"): void {
  for (let i = 0; i <= FREE_WRONG_GUESSES; i++) {
    expect(throttle.check(TOKEN, `${prefix}-${i}`, from)).toBe("wrong");
  }
}

describe("GatewayCredentialThrottle", () => {
  test("the free guesses are compared and the next new value waits", () => {
    const { throttle } = clocked();
    const attacker = peer();
    exhaust(throttle, attacker);
    expect(throttle.check(TOKEN, "one-more", attacker)).toBe("throttled");
    expect(throttle.retryAfterSeconds(attacker)).toBe(FIRST_PAUSE_MS / 1000);
  });

  test("the correct token is refused during a pause, so it cannot be read off the answer", () => {
    const { throttle } = clocked();
    const attacker = peer();
    exhaust(throttle, attacker);
    expect(throttle.check(TOKEN, TOKEN, attacker)).toBe("throttled");
  });

  test("each further wrong value doubles the pause up to the cap", () => {
    const { throttle, advance } = clocked();
    const attacker = peer();
    exhaust(throttle, attacker);
    let expected = FIRST_PAUSE_MS;
    for (let i = 0; i < 12; i++) {
      advance(expected);
      expect(throttle.check(TOKEN, `later-${i}`, attacker)).toBe("wrong");
      expected = Math.min(MAX_PAUSE_MS, expected * 2);
      expect(throttle.retryAfterSeconds(attacker)).toBe(expected / 1000);
    }
    expect(expected).toBe(MAX_PAUSE_MS);
  });

  test("attempts during a pause neither extend it nor count", () => {
    const { throttle, advance } = clocked();
    const attacker = peer();
    exhaust(throttle, attacker);
    for (let i = 0; i < 50; i++) throttle.check(TOKEN, `flood-${i}`, attacker);
    advance(FIRST_PAUSE_MS);
    expect(throttle.check(TOKEN, TOKEN, attacker)).toBe("match");
  });

  test("a value already known to be wrong never counts, so a stale client cannot lock anyone out", () => {
    const { throttle } = clocked();
    const stale = peer();
    for (let i = 0; i < FREE_WRONG_GUESSES * 10; i++) {
      expect(throttle.check(TOKEN, "token-before-rotation", stale)).toBe("wrong");
    }
    expect(throttle.check(TOKEN, TOKEN, stale)).toBe("match");
  });

  test("during a pause a remembered wrong value still gets its usual answer", () => {
    const { throttle } = clocked();
    const attacker = peer();
    exhaust(throttle, attacker);
    expect(throttle.check(TOKEN, "guess-0", attacker)).toBe("wrong");
  });

  test("a connection that has shown the token stays exempt, and a new one does not", () => {
    const { throttle } = clocked();
    const open = peer();
    expect(throttle.check(TOKEN, TOKEN, open)).toBe("match");
    exhaust(throttle, peer());
    expect(throttle.check(TOKEN, TOKEN, open)).toBe("match");
    expect(throttle.check(TOKEN, TOKEN, peer())).toBe("throttled");
  });

  test("an address that has shown the token stays exempt on a new connection", () => {
    const { throttle } = clocked();
    expect(throttle.check(TOKEN, TOKEN, peer("100.64.0.7"))).toBe("match");
    exhaust(throttle, peer("100.64.0.9"));
    expect(throttle.check(TOKEN, TOKEN, peer("100.64.0.7"))).toBe("match");
    expect(throttle.check(TOKEN, TOKEN, peer("100.64.0.9"))).toBe("throttled");
  });

  test.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "loopback address %s proves nothing about the next connection",
    (address) => {
      const { throttle } = clocked();
      expect(throttle.check(TOKEN, TOKEN, peer(address))).toBe("match");
      exhaust(throttle, peer(address));
      expect(throttle.check(TOKEN, TOKEN, peer(address))).toBe("throttled");
    },
  );

  test("a real client's success does not clear a guesser's pause", () => {
    const { throttle } = clocked();
    const client = peer("100.64.0.7");
    expect(throttle.check(TOKEN, TOKEN, client)).toBe("match");
    exhaust(throttle, peer());
    expect(throttle.check(TOKEN, TOKEN, client)).toBe("match");
    expect(throttle.check(TOKEN, "one-more", peer())).toBe("throttled");
  });

  test("listeners count separately", () => {
    const { throttle } = clocked();
    exhaust(throttle, peer("127.0.0.1", 1111));
    expect(throttle.check(TOKEN, TOKEN, peer("127.0.0.1", 1111))).toBe("throttled");
    expect(throttle.check(TOKEN, TOKEN, peer("127.0.0.1", 2222))).toBe("match");
  });

  test("a quiet period forgets the count and the remembered values", () => {
    const { throttle, advance } = clocked();
    const attacker = peer();
    exhaust(throttle, attacker);
    advance(GUESS_MEMORY_MS);
    for (let i = 0; i < FREE_WRONG_GUESSES; i++) {
      expect(throttle.check(TOKEN, `guess-${i}`, attacker)).toBe("wrong");
    }
    expect(throttle.check(TOKEN, TOKEN, attacker)).toBe("match");
  });

  test("attempts refused during a pause do not hold the memory open", () => {
    const { throttle, advance } = clocked();
    const attacker = peer();
    exhaust(throttle, attacker);
    advance(FIRST_PAUSE_MS / 2);
    expect(throttle.check(TOKEN, "during-the-pause", attacker)).toBe("throttled");
    advance(GUESS_MEMORY_MS - FIRST_PAUSE_MS / 2);
    expect(throttle.check(TOKEN, "guess-0", attacker)).toBe("wrong");
    expect(throttle.check(TOKEN, TOKEN, attacker)).toBe("match");
  });

  test("reset forgets the pause, the wrong values and every proof", () => {
    const { throttle } = clocked();
    const open = peer("100.64.0.7");
    expect(throttle.check(TOKEN, TOKEN, open)).toBe("match");
    exhaust(throttle, peer());
    throttle.reset();
    expect(throttle.check("guess-0", "guess-0", peer())).toBe("match");

    exhaust(throttle, peer());
    expect(throttle.check(TOKEN, TOKEN, open)).toBe("throttled");
  });

  test("remembered values are bounded, oldest forgotten first", () => {
    const { throttle, advance } = clocked();
    const attacker = peer();
    for (let i = 0; i <= MAX_REMEMBERED_GUESSES; i++) {
      throttle.check(TOKEN, `guess-${i}`, attacker);
      advance(MAX_PAUSE_MS);
    }
    const { listeners } = throttle as unknown as {
      listeners: Map<number, { remembered: Set<string> }>;
    };
    expect(listeners.get(34121)!.remembered.size).toBe(MAX_REMEMBERED_GUESSES);
    // The last pause has lapsed. The newest value is still known, so repeating
    // it starts no new pause; the oldest was forgotten, so it counts again.
    expect(throttle.check(TOKEN, `guess-${MAX_REMEMBERED_GUESSES}`, attacker)).toBe("wrong");
    expect(throttle.check(TOKEN, TOKEN, peer())).toBe("match");
    expect(throttle.check(TOKEN, "guess-0", attacker)).toBe("wrong");
    expect(throttle.check(TOKEN, TOKEN, peer())).toBe("throttled");
  });

  test("proven addresses are bounded, oldest forgotten first", () => {
    const { throttle } = clocked();
    for (let i = 0; i <= MAX_PROVEN_PEERS; i++) {
      expect(throttle.check(TOKEN, TOKEN, peer(`100.64.0.${i}`))).toBe("match");
    }
    exhaust(throttle, peer());
    expect(throttle.check(TOKEN, TOKEN, peer("100.64.0.0"))).toBe("throttled");
    expect(throttle.check(TOKEN, TOKEN, peer(`100.64.0.${MAX_PROVEN_PEERS}`))).toBe("match");
  });
});

describe("gateway guess throttling", () => {
  type Info = { url: string; token: string };

  const bearer = (info: Info, token: string) =>
    requestUrl(`${info.url}__orkestrator/status`, {
      headers: { authorization: `Bearer ${token}`, connection: "close" },
    });

  const login = (info: Info, token: string) =>
    requestUrl(`${info.url}__orkestrator/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" },
      body: `token=${encodeURIComponent(token)}`,
    });

  /** Opens a pause on the gateway's browser listener through wrong bearers. */
  async function openPause(info: Info): Promise<void> {
    for (let i = 0; i <= FREE_WRONG_GUESSES; i++) {
      expect((await bearer(info, `wrong-${i}`)).status).toBe(401);
    }
  }

  test("a pause refuses the correct token on login and on a new bearer connection", async () => {
    const { info } = await startGateway();
    await openPause(info);

    const throttledBearer = await bearer(info, info.token);
    expect(throttledBearer.status).toBe(429);
    expect(Number(throttledBearer.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(throttledBearer.body).not.toContain(info.token);

    const throttledLogin = await login(info, info.token);
    expect(throttledLogin.status).toBe(429);
    expect(throttledLogin.headers["set-cookie"]).toBeUndefined();
    expect(throttledLogin.headers["retry-after"]).toBeDefined();
    expect(throttledLogin.body).toContain("Too many wrong gateway tokens");
  });

  test("wrong tokens on the login form and as bearers share one count", async () => {
    const { info } = await startGateway();
    for (let i = 0; i <= FREE_WRONG_GUESSES; i++) {
      const attempt = i % 2 === 0 ? login(info, `wrong-${i}`) : bearer(info, `wrong-${i}`);
      expect((await attempt).status).toBe(401);
    }
    expect((await bearer(info, "one-more")).status).toBe(429);
  });

  test("a stale bearer repeating itself never starts a pause", async () => {
    const { info } = await startGateway();
    for (let i = 0; i < FREE_WRONG_GUESSES * 3; i++) {
      expect((await bearer(info, "token-before-rotation")).status).toBe(401);
    }
    expect((await bearer(info, info.token)).status).toBe(200);
  });

  test("a signed-in browser and an open bearer connection keep working through a pause", async () => {
    const { info } = await startGateway();
    const signedIn = await login(info, info.token);
    const cookie = signedIn.headers["set-cookie"]![0]!.split(";")[0]!;

    // The same socket for every request, the way a running client reuses one.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const url = new URL(info.url);
    const onOpenConnection = () =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            agent,
            hostname: url.hostname,
            port: url.port,
            path: "/__orkestrator/status",
            headers: { authorization: `Bearer ${info.token}` },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode ?? 0));
          },
        );
        request.on("error", reject);
        request.end();
      });
    try {
      expect(await onOpenConnection()).toBe(200);
      await openPause(info);
      expect((await bearer(info, info.token)).status).toBe(429);

      expect(await onOpenConnection()).toBe(200);
      const browser = await requestUrl(`${info.url}__orkestrator/status`, {
        headers: { cookie },
      });
      expect(browser.status).toBe(200);
    } finally {
      agent.destroy();
    }
  });

  test("guessing through the browser listener leaves the control listener alone", async () => {
    const { info } = await startGateway({ controlBindAddress: "127.0.0.1", controlPort: 0 });
    const browserUrl = { url: info.browserUrl!, token: info.token };
    await openPause(browserUrl);
    expect((await bearer(browserUrl, info.token)).status).toBe(429);
    expect((await bearer({ url: info.controlUrl!, token: info.token }, info.token)).status).toBe(
      200,
    );
  });

  test("a cookie cannot be used to test guesses during a pause", async () => {
    const { info } = await startGateway();
    const cookieRequest = (value: string) =>
      requestUrl(`${info.url}__orkestrator/status`, {
        headers: { cookie: `orkestrator_gateway_auth=${value}`, connection: "close" },
      });

    // Before a pause the old cookie migration still expires a real token.
    const migrated = await cookieRequest(info.token);
    expect(migrated.status).toBe(401);
    expect(migrated.headers["set-cookie"]).toBeDefined();
    expect((await cookieRequest("not-the-token")).headers["set-cookie"]).toBeUndefined();

    const { info: paused } = await startGateway();
    await openPause(paused);
    const answer = await requestUrl(`${paused.url}__orkestrator/status`, {
      headers: { cookie: `orkestrator_gateway_auth=${paused.token}`, connection: "close" },
    });
    expect(answer.status).toBe(401);
    expect(answer.headers["set-cookie"]).toBeUndefined();
  });

  test("wrong cookies count toward the pause, so they are no unlimited way to guess", async () => {
    const { info } = await startGateway();
    for (let i = 0; i <= FREE_WRONG_GUESSES; i++) {
      await requestUrl(`${info.url}__orkestrator/status`, {
        headers: { cookie: `orkestrator_gateway_auth=wrong-${i}`, connection: "close" },
      });
    }
    expect((await bearer(info, info.token)).status).toBe(429);
  });

  test("rotating the token ends a pause", async () => {
    const { gateway, info } = await startGateway({ env: {} });
    const authFileToken = info.token;
    await openPause(info);
    expect((await bearer(info, authFileToken)).status).toBe(429);
    await gateway.setToken("rotated-token-value-123");
    expect((await bearer(info, "rotated-token-value-123")).status).toBe(200);
  });

  test("an empty login submission is not a guess", async () => {
    const { info } = await startGateway();
    for (let i = 0; i < FREE_WRONG_GUESSES * 2; i++) {
      expect((await login(info, "")).status).toBe(401);
    }
    expect((await login(info, info.token)).status).toBe(303);
  });
});
