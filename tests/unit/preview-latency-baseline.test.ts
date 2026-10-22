import { describe, expect, test } from "bun:test";
import { connect as netConnect, createServer, type AddressInfo, type Server } from "node:net";

import type {
  PreviewCapabilities,
  PreviewServiceSnapshot,
} from "@orkestrator/protocol/preview-services";

import {
  assertNoSecrets,
  BaselineFailure,
  formatTable,
  hostKind,
  parseBaselineArgs,
  planRoutes,
  routeResult,
  ROUTES,
  sanitizeDiagnostics,
  sessionCookieFromHead,
  skippedRoute,
  startDecoy,
  startThrottle,
  statusFromHead,
  summarize,
  takeFlags,
  timedExchange,
  tokenFromFileContents,
  updatePeaks,
  TOKEN_ENV,
  UsageError,
  type BaselineResult,
  type ParseDependencies,
} from "../../scripts/preview-latency-baseline";

const TOKEN = "gateway-token-0123456789abcdef";

function dependencies(files: Record<string, string> = {}, mode = 0o100600) {
  const warnings: string[] = [];
  const deps: ParseDependencies = {
    readFile: (path) => {
      const contents = files[path];
      if (contents === undefined) throw new Error("ENOENT");
      return contents;
    },
    fileMode: (path) => (path in files ? mode : null),
    warn: (message) => warnings.push(message),
  };
  return { deps, warnings };
}

const parse = (argv: string[], env: Record<string, string> = { [TOKEN_ENV]: TOKEN }, files = {}) =>
  parseBaselineArgs(argv, env, dependencies(files).deps);

function capabilities(
  overrides: Partial<Record<string, { available: boolean; reason?: string }>> = {},
) {
  const surface = (name: string) => ({ available: true, ...overrides[name] });
  return {
    protocolVersion: 1,
    backendInstanceId: "instance",
    backendEpoch: "epoch",
    registry: { available: true },
    targets: ["container", "worktree", "backend-host"],
    access: { available: true },
    surfaces: {
      desktopTunnel: { ...surface("desktopTunnel"), upstreamSchemes: ["http"] },
      browserTopLevel: { ...surface("browserTopLevel"), upstreamSchemes: ["http", "https"] },
      browserEmbedded: { available: false, platforms: [] },
      legacyPath: surface("legacyPath"),
    },
    relay: { available: false },
    limits: {},
  } as unknown as PreviewCapabilities;
}

function service(
  overrides: { hostPort?: number | null; scheme?: "http" | "https"; state?: string } = {},
) {
  return {
    definition: {
      serviceId: "svc_1",
      environmentId: "env",
      label: "web",
      targetKind: "container",
      applicationPort: 5173,
      scheme: overrides.scheme ?? "http",
    },
    endpoint: {
      state: overrides.state ?? "available",
      hostPort: overrides.hostPort === undefined ? 49152 : overrides.hostPort,
      transportKind: "published-port",
      addressFamily: "ipv4",
    },
  } as unknown as PreviewServiceSnapshot;
}

describe("argument and token parsing", () => {
  test("defaults and the environment token", () => {
    const options = parse(["--url", "https://build.tailnet.ts.net"]);
    expect(options.token).toBe(TOKEN);
    expect(options.samples).toBe(50);
    expect(options.warmups).toBe(5);
    expect(options.path).toBe("/");
    expect(options.routes).toEqual([...ROUTES]);
    expect(options.direct).toEqual({ kind: "auto" });
    expect(options.timeoutMs).toBe(10_000);
  });

  test("never accepts a secret on the command line", () => {
    for (const flag of ["--token", "--token=abc", "--credential", "--cookie=x"]) {
      expect(() => parse(["--url", "http://127.0.0.1:1", flag, "value"])).toThrow(
        /never go on the command line/,
      );
    }
  });

  test("requires exactly one token source", () => {
    expect(() => parse(["--url", "http://127.0.0.1:1"], {})).toThrow(/token is required/);
    expect(() =>
      parse(
        ["--url", "http://127.0.0.1:1", "--token-file", "/t"],
        { [TOKEN_ENV]: TOKEN },
        {
          "/t": TOKEN,
        },
      ),
    ).toThrow(/not both/);
  });

  test("reads a raw token or a gateway-auth.json file and warns on loose permissions", () => {
    expect(tokenFromFileContents(`${TOKEN}\n`)).toBe(TOKEN);
    expect(tokenFromFileContents(JSON.stringify({ token: TOKEN }, null, 2))).toBe(TOKEN);
    expect(() => tokenFromFileContents("{}")).toThrow(UsageError);
    expect(() => tokenFromFileContents("two words")).toThrow(UsageError);
    const loose = dependencies({ "/auth.json": JSON.stringify({ token: TOKEN }) }, 0o100644);
    const options = parseBaselineArgs(
      ["--url", "http://127.0.0.1:1", "--token-file", "/auth.json"],
      {},
      loose.deps,
    );
    expect(options.token).toBe(TOKEN);
    expect(loose.warnings).toEqual([expect.stringContaining("chmod 600")]);
  });

  test("errors never echo the token file contents", () => {
    const error = (() => {
      try {
        parse(["--url", "http://127.0.0.1:1", "--token-file", "/t"], {}, { "/t": `{${TOKEN}` });
      } catch (caught) {
        return caught as Error;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(UsageError);
    expect(error!.message).not.toContain(TOKEN);
  });

  test("subcommand flags are split from the baseline options", () => {
    const { values, rest } = takeFlags(
      ["--url", "http://x", "--seconds", "5", "--read-kib=32", "--path", "/endless"],
      ["seconds", "read-kib"],
    );
    expect(Object.fromEntries(values)).toEqual({ seconds: "5", "read-kib": "32" });
    expect(rest).toEqual(["--url", "http://x", "--path", "/endless"]);
    expect(() => takeFlags(["--seconds"], ["seconds"])).toThrow(/needs a value/);
  });

  test("validates the URL, numbers, routes, direct mode, path and addresses", () => {
    expect(() => parse(["--url", "ftp://x"])).toThrow(/http/);
    expect(() => parse(["--url", "http://x/api"])).toThrow(/bare origin/);
    expect(() => parse(["--url", `http://user:${TOKEN}@x`])).toThrow(/bare origin/);
    expect(() => parse(["--url", "http://x", "--samples", "0"])).toThrow(/--samples/);
    expect(() => parse(["--url", "http://x", "--warmups", "1.5"])).toThrow(/--warmups/);
    expect(() => parse(["--url", "http://x", "--routes", "legacy,ssh"])).toThrow(/Unknown route/);
    expect(() => parse(["--url", "http://x", "--direct", "a b"])).toThrow(/--direct/);
    expect(() => parse(["--url", "http://x", "--path", "health"])).toThrow(/--path/);
    expect(() => parse(["--url", "http://x", "--publication-address", "name"])).toThrow(/IP/);
    expect(() => parse(["--url", "http://x", "--bogus", "1"])).toThrow(/Unknown option/);
    expect(() => parse(["--url", "http://x", "--samples", "1", "--samples", "2"])).toThrow(/twice/);
    const options = parse([
      "--url=http://100.64.0.2:34121",
      "--routes",
      "legacy,desktop-tunnel",
      "--direct",
      "[fd7a:115c:a1e0::1]",
      "--samples=7",
      "--warmups",
      "0",
    ]);
    expect(options.routes).toEqual(["legacy", "desktop-tunnel"]);
    expect(options.direct).toEqual({ kind: "host", host: "fd7a:115c:a1e0::1" });
    expect(options.samples).toBe(7);
    expect(options.warmups).toBe(0);
  });
});

describe("summary statistics", () => {
  test("uses the bench's nearest-rank method", () => {
    expect(summarize([])).toBeNull();
    expect(summarize([5])).toEqual({ p50: 5, p95: 5, max: 5 });
    const values = Array.from({ length: 100 }, (_, index) => 100 - index);
    expect(summarize(values)).toEqual({ p50: 51, p95: 96, max: 100 });
    expect(summarize([0.123, 0.456])).toEqual({ p50: 0.46, p95: 0.46, max: 0.46 });
  });

  test("counts transport failures and 5xx, and keeps statuses", () => {
    const result = routeResult([
      { ok: true, connectMs: 1, firstByteMs: 2, status: 200 },
      { ok: true, connectMs: 3, firstByteMs: 4, status: 404 },
      { ok: true, connectMs: 9, firstByteMs: 9, status: 502 },
      { ok: false, failure: "timeout" },
    ]);
    expect(result.status).toBe("measured");
    expect(result.samples).toBe(4);
    expect(result.failures).toBe(2);
    expect(result.statuses).toEqual({ "200": 1, "404": 1, "502": 1 });
    expect(result.failureKinds).toEqual({ "http-502": 1, timeout: 1 });
    expect(result.firstByteMs).toEqual({ p50: 4, p95: 4, max: 4 });
    expect(routeResult([{ ok: false, failure: "ECONNRESET" }]).status).toBe("failed");
  });

  test("parses status lines and the session cookie without keeping anything else", () => {
    expect(statusFromHead(Buffer.from("HTTP/1.1 303 See Other\r\n"))).toBe(303);
    expect(statusFromHead(Buffer.from("garbage"))).toBeNull();
    const head =
      "HTTP/1.1 303 See Other\r\nSet-Cookie: other=1; Path=/\r\nset-cookie: __Host-orkestrator-preview=att_x.secret; Path=/; Secure";
    expect(sessionCookieFromHead(head)).toBe("att_x.secret");
    expect(sessionCookieFromHead("HTTP/1.1 403 Forbidden")).toBeNull();
  });
});

describe("route planning and skip reasons", () => {
  const url = new URL("https://build.tailnet.ts.net");
  const base = { routes: [...ROUTES], direct: { kind: "auto" } as const, url };

  test("runs every route when the backend offers it", () => {
    const plans = planRoutes({ options: base, capabilities: capabilities(), service: service() });
    expect(plans.direct).toEqual({ run: true, host: "build.tailnet.ts.net", port: 49152 });
    expect(plans.legacy).toEqual({ run: true, port: 49152 });
    expect(plans["desktop-tunnel"]).toEqual({ run: true });
    expect(plans["private-origin"]).toEqual({ run: true });
  });

  const reason = (plan: ReturnType<typeof planRoutes>[keyof ReturnType<typeof planRoutes>]) =>
    plan.run ? null : plan.result.reason;

  test("skips with the backend's own reason when a surface is off", () => {
    const plans = planRoutes({
      options: base,
      capabilities: capabilities({
        desktopTunnel: {
          available: false,
          reason: "Service preview transport is disabled in settings.",
        },
        browserTopLevel: { available: false, reason: "Publication is not configured." },
      }),
      service: service(),
    });
    expect(reason(plans["desktop-tunnel"])).toBe(
      "Service preview transport is disabled in settings.",
    );
    expect(reason(plans["private-origin"])).toBe("Publication is not configured.");
  });

  test("never sends the direct route to a client-local process by default", () => {
    const loopback = { ...base, url: new URL("http://127.0.0.1:44001") };
    const plans = planRoutes({
      options: loopback,
      capabilities: capabilities(),
      service: service(),
    });
    expect(reason(plans.direct)).toContain("client-local process");
    const explicit = planRoutes({
      options: { ...loopback, direct: { kind: "host", host: "127.0.0.1" } },
      capabilities: capabilities(),
      service: service(),
    });
    expect(explicit.direct).toEqual({ run: true, host: "127.0.0.1", port: 49152 });
  });

  test("explains relay services, HTTPS services, unselected routes and endpoints", () => {
    const relay = planRoutes({
      options: base,
      capabilities: capabilities(),
      service: service({ hostPort: null }),
    });
    expect(reason(relay.direct)).toContain("no host port");
    expect(reason(relay.legacy)).toContain("no host port");
    const https = planRoutes({
      options: base,
      capabilities: capabilities(),
      service: service({ scheme: "https" }),
    });
    expect(reason(https["desktop-tunnel"])).toContain("HTTP services only");
    expect(https["private-origin"]).toEqual({ run: true });
    const some = planRoutes({
      options: { ...base, routes: ["legacy"], direct: { kind: "off" } },
      capabilities: capabilities(),
      service: service(),
    });
    expect(reason(some.direct)).toBe("not selected with --routes");
    const stopped = planRoutes({
      options: base,
      capabilities: capabilities(),
      service: service({ state: "unavailable" }),
    });
    expect(reason(stopped.legacy)).toBe("the service endpoint is unavailable");
  });

  test("classifies the backend host without printing it", () => {
    expect(hostKind("localhost")).toBe("loopback");
    expect(hostKind("[::1]")).toBe("loopback");
    expect(hostKind("100.101.102.103")).toBe("tailnet-address");
    expect(hostKind("fd7a:115c:a1e0::5")).toBe("tailnet-address");
    expect(hostKind("192.168.1.4")).toBe("ip-address");
    expect(hostKind("build.tailnet.ts.net")).toBe("name");
  });
});

describe("output never carries secrets", () => {
  function result(): BaselineResult {
    const routes = Object.fromEntries(
      ROUTES.map((route) => [route, skippedRoute("skipped", "not selected with --routes")]),
    ) as BaselineResult["routes"];
    routes.legacy = routeResult([{ ok: true, connectMs: 1, firstByteMs: 2, status: 200 }]);
    return {
      schema: "orkestrator.preview-latency-baseline.v1",
      label: "test",
      startedAt: "2026-10-22T00:00:00.000Z",
      finishedAt: "2026-10-22T00:00:01.000Z",
      client: { platform: "darwin", arch: "arm64", bun: "1.4.3" },
      backend: {
        scheme: "https",
        hostKind: "name",
        capabilities: {
          access: true,
          desktopTunnel: true,
          browserTopLevel: false,
          legacyPath: true,
          relay: false,
        },
      },
      service: {
        targetKind: "worktree",
        transportKind: "backend-loopback",
        scheme: "http",
        addressFamily: "ipv4",
      },
      config: {
        samples: 1,
        warmups: 0,
        path: "/",
        timeoutMs: 1000,
        intervalMs: 0,
        direct: "auto",
      },
      routes,
      diagnostics: { before: null, afterSampling: null, afterRelease: null },
    };
  }

  test("a complete result passes the check and the table names every route", () => {
    const json = JSON.stringify(result());
    expect(() => assertNoSecrets(json, [TOKEN])).not.toThrow();
    const table = formatTable(result());
    for (const route of ROUTES) expect(table).toContain(`| ${route} |`);
    expect(table).toContain("- direct: not selected with --routes");
    expect(() => assertNoSecrets(table, [TOKEN])).not.toThrow();
  });

  test("refuses output containing a secret value or a secret-named field", () => {
    const leaked = { ...result(), label: `run ${TOKEN}` };
    expect(() => assertNoSecrets(JSON.stringify(leaked), [TOKEN])).toThrow(BaselineFailure);
    for (const key of ["token", "credential", "grant", "cookie", "session", "code", "url"]) {
      const named = { ...result(), service: { ...result().service, [key]: "x" } };
      expect(() => assertNoSecrets(JSON.stringify(named), [])).toThrow(/refusing to print/);
    }
  });

  test("watch keeps the peak of every gauge and of the access counts", () => {
    const peaks: Record<string, number> = {};
    updatePeaks(peaks, {
      metrics: { gauges: { "tunnel.queued_bytes": 4096, "tunnel.sockets": 3 } },
      access: { attachments: 2, resources: 3 },
    });
    updatePeaks(peaks, {
      metrics: { gauges: { "tunnel.queued_bytes": 1024, "tunnel.sockets": 5 } },
      access: { attachments: 1, resources: 0 },
    });
    updatePeaks(peaks, null);
    expect(peaks).toEqual({
      "tunnel.queued_bytes": 4096,
      "tunnel.sockets": 5,
      "access.attachments": 2,
      "access.resources": 3,
    });
  });

  test("diagnostics keep numbers only", () => {
    const clean = sanitizeDiagnostics({
      metrics: {
        counters: { "http.failed{connect-timeout}": 2 },
        histograms: { "tunnel.open_ms": { count: 3, p50: 1, p95: 2, max: 4 } },
        gauges: { "tunnel.queued_bytes": 0 },
      },
      access: { attachments: 1, note: "free text" },
      publication: { origin: "https://s-abc.preview.example" },
      settings: { transport: true },
    });
    expect(clean).toEqual({
      metrics: {
        counters: { "http.failed{connect-timeout}": 2 },
        histograms: { "tunnel.open_ms": { count: 3, p50: 1, p95: 2, max: 4 } },
        gauges: { "tunnel.queued_bytes": 0 },
      },
      access: { attachments: 1 },
    });
    expect(sanitizeDiagnostics(null)).toBeNull();
  });
});

describe("network helpers", () => {
  async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    return (server.address() as AddressInfo).port;
  }

  test("timedExchange measures one request and reports a refused port", async () => {
    const server = createServer((socket) =>
      socket.once("data", () => socket.end("HTTP/1.1 204 No Content\r\n\r\n")),
    );
    const port = await listen(server);
    try {
      const request = Buffer.from("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
      const ok = await timedExchange(
        (signal) =>
          new Promise((resolve, reject) => {
            const socket = netConnect({ host: "127.0.0.1", port }, () => resolve(socket));
            socket.once("error", reject);
            signal.addEventListener("abort", () => socket.destroy());
          }),
        request,
        2_000,
      );
      expect(ok).toMatchObject({ ok: true, status: 204 });
      if (ok.ok) expect(ok.firstByteMs).toBeGreaterThanOrEqual(ok.connectMs);
      const refused = await timedExchange(
        () => Promise.reject(new BaselineFailure("ECONNREFUSED")),
        request,
        2_000,
      );
      expect(refused).toEqual({ ok: false, failure: "ECONNREFUSED" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("the decoy counts connections and answers with its marker", async () => {
    const decoy = await startDecoy(0, ["127.0.0.1"]);
    const port = decoy.port;
    try {
      expect(decoy.connections()).toBe(0);
      const response = await new Promise<string>((resolve, reject) => {
        const socket = netConnect({ host: "127.0.0.1", port }, () =>
          socket.write("GET / HTTP/1.1\r\nhost: x\r\n\r\n"),
        );
        let text = "";
        socket.on("data", (chunk) => (text += chunk.toString()));
        socket.on("end", () => resolve(text));
        socket.on("error", reject);
      });
      expect(response).toContain("x-service-marker: decoy");
      expect(decoy.connections()).toBe(1);
      expect(decoy.requests()).toBe(1);
    } finally {
      await decoy.close();
    }
  });

  test("the throttle delays each direction and preserves bytes and EOF", async () => {
    const echo = createServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => socket.end(Buffer.concat(chunks)));
    });
    const target = await listen(echo);
    const throttle = await startThrottle({
      listenHost: "127.0.0.1",
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort: target,
      latencyMs: 40,
      rateKiB: 1024,
    });
    try {
      const payload = Buffer.alloc(64 * 1024, 7);
      const started = performance.now();
      const echoed = await new Promise<Buffer>((resolve, reject) => {
        const socket = netConnect({ host: "127.0.0.1", port: throttle.port, allowHalfOpen: true });
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("end", () => resolve(Buffer.concat(chunks)));
        socket.on("error", reject);
        socket.end(payload);
      });
      const elapsed = performance.now() - started;
      expect(echoed.equals(payload)).toBe(true);
      // Two one-way latencies plus 64 KiB each way at 1 MiB/s (~62 ms each).
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(throttle.stats()).toMatchObject({
        connections: 1,
        upBytes: payload.length,
        downBytes: payload.length,
      });
    } finally {
      await throttle.close();
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
  });
});
