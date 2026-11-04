import { describe, expect, test } from "bun:test";
import { GatewayHostPolicy } from "../src/gateway-host-policy";
import { requestUrl, startGateway } from "./gateway-test-harness.js";

const policy = (allowedOrigins: string[] = [], machine = "desk.example.org") =>
  new GatewayHostPolicy(allowedOrigins, machine);

describe("GatewayHostPolicy", () => {
  test.each([
    ["an IPv4 literal", "127.0.0.1:34121"],
    ["a Tailscale address", "100.101.102.103:34121"],
    ["a LAN address", "192.168.1.20"],
    ["an IPv6 literal", "[fd7a:115c:a1e0::1]:34121"],
    ["IPv6 loopback", "[::1]:34121"],
    ["localhost", "localhost:5173"],
    ["localhost in capitals", "LOCALHOST:5173"],
    ["a name under localhost", "preview.localhost:8080"],
    ["a MagicDNS short name", "beelink:34121"],
    ["a MagicDNS full name", "beelink.tailnet-1234.ts.net"],
    ["a Serve name with a port", "beelink.tailnet-1234.ts.net:8443"],
    ["a name with a trailing dot", "beelink.tailnet-1234.ts.net."],
    ["this machine's host name", "desk.example.org:34121"],
    ["this machine's mDNS name", "desk.local:34121"],
  ])("allows %s", (_label, host) => {
    expect(policy().allows(host)).toBe(true);
  });

  test("a request with no Host header is not a rebound page", () => {
    expect(policy().allows(undefined)).toBe(true);
  });

  test.each([
    ["a public name", "attacker.example:34121"],
    ["a name that embeds an address", "127.0.0.1.attacker.example"],
    ["a name that embeds an allowed suffix", "beelink.ts.net.attacker.example"],
    ["a name ending like the suffix", "attacker-ts.net"],
    ["a name ending like localhost", "attackerlocalhost.example"],
    ["another machine's mDNS name", "other.local"],
    ["an empty value", ""],
    ["user information", "127.0.0.1@attacker.example"],
    ["a path", "attacker.example/127.0.0.1"],
    ["a path after an address", "127.0.0.1/@attacker.example"],
    ["a fragment after an address", "127.0.0.1#attacker.example"],
    ["a query after an address", "127.0.0.1?attacker.example"],
  ])("refuses %s", (_label, host) => {
    expect(policy().allows(host)).toBe(false);
  });

  test("an allowed origin admits its own host, with its own port", () => {
    const allowed = policy(["https://gateway.example", "http://lan.example:8080"]);
    expect(allowed.allows("gateway.example")).toBe(true);
    expect(allowed.allows("GATEWAY.example")).toBe(true);
    expect(allowed.allows("lan.example:8080")).toBe(true);
    expect(allowed.allows("lan.example:9090")).toBe(false);
    expect(allowed.allows("other.example")).toBe(false);
  });

  test("a wildcard origin admits names under it, and `*` admits anything", () => {
    const wildcard = policy(["https://*.gateway.example"]);
    expect(wildcard.allows("one.gateway.example")).toBe(true);
    expect(wildcard.allows("gateway.example")).toBe(false);
    expect(policy(["*"]).allows("anything.example")).toBe(true);
  });

  test("a single-label machine name still gets its mDNS form", () => {
    expect(policy([], "desk").allows("desk.local")).toBe(true);
  });
});

describe("gateway Host check", () => {
  const rebound = { host: "attacker.example" };

  test("a rebound name gets 421 from every route, even with a valid credential", async () => {
    const { info } = await startGateway();
    const authorization = `Bearer ${info.token}`;
    for (const [route, method] of [
      ["__orkestrator/status", "GET"],
      ["__orkestrator/login", "GET"],
      ["__orkestrator/invoke", "POST"],
      ["__orkestrator/status", "OPTIONS"],
      ["", "GET"],
    ] as const) {
      const response = await requestUrl(`${info.url}${route}`, {
        method,
        headers: { ...rebound, authorization },
      });
      expect(response.status).toBe(421);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  test("a rebound page's same-host Origin no longer passes the origin check", async () => {
    const { info } = await startGateway();
    const response = await requestUrl(`${info.url}__orkestrator/status`, {
      headers: { ...rebound, origin: "http://attacker.example" },
    });
    expect(response.status).toBe(421);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("the same-host rule still serves a name the gateway answers to", async () => {
    const { info } = await startGateway();
    const response = await requestUrl(`${info.url}__orkestrator/status`, {
      headers: {
        host: "desk.tailnet.ts.net",
        origin: "https://desk.tailnet.ts.net",
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("https://desk.tailnet.ts.net");
  });

  test("the refusal says how to allow a name of your own, and allowing it works", async () => {
    const { info } = await startGateway();
    const refused = await requestUrl(`${info.url}__orkestrator/status`, {
      headers: { host: "gateway.example" },
    });
    expect(refused.status).toBe(421);
    expect(refused.body).toContain("--allowed-origins");

    const proxied = await startGateway({ allowedOrigins: ["https://gateway.example"] });
    const allowed = await requestUrl(`${proxied.info.url}__orkestrator/status`, {
      headers: { host: "gateway.example", authorization: `Bearer ${proxied.info.token}` },
    });
    expect(allowed.status).toBe(200);
  });

  test("a WebSocket upgrade under a rebound name is refused before any route sees it", async () => {
    const { info } = await startGateway();
    const { connect } = await import("node:net");
    const url = new URL(info.url);
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
        socket.write(
          [
            "GET /__orkestrator/terminal HTTP/1.1",
            "Host: attacker.example",
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "",
            "",
          ].join("\r\n"),
        );
      });
      let received = "";
      socket.on("data", (chunk) => {
        received += chunk.toString("utf8");
      });
      socket.on("close", () => resolve(received));
      socket.on("error", reject);
    });
    expect(answer).toStartWith("HTTP/1.1 421");
  });
});
