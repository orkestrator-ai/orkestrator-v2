import { describe, expect, mock, test } from "bun:test";
import { createServer, type OutgoingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import {
  checkHttpHealth,
  confirmRunningServerHealth,
  isHealthyHttpResponse,
  OPENCODE_INSTANCE_WARM_TIMEOUT_MS,
  waitForUnhealthy,
  warmOpenCodeInstance,
} from "./commands-server-health.js";
import {
  LOCAL_SERVER_REUSE_FIRST_PROBE_TIMEOUT_MS,
  LOCAL_SERVER_REUSE_HEALTH_INTERVAL_MS,
  LOCAL_SERVER_REUSE_RETRY_PROBE_TIMEOUT_MS,
} from "./commands-server-health.js";

describe("confirmRunningServerHealth", () => {
  test("exits when the child dies after the first failed probe", async () => {
    let alive = true;
    const checkHealth = mock(async () => {
      alive = false;
      return false;
    });
    const delay = mock(async () => undefined);

    expect(
      await confirmRunningServerHealth(1234, undefined, () => alive, { checkHealth, delay }),
    ).toEqual({ healthy: false, failedProbes: 1 });
    expect(checkHealth).toHaveBeenCalledTimes(1);
    expect(checkHealth).toHaveBeenCalledWith(
      1234,
      "/global/health",
      undefined,
      LOCAL_SERVER_REUSE_FIRST_PROBE_TIMEOUT_MS,
    );
    expect(delay).not.toHaveBeenCalled();
  });

  test("uses the longer timeout for retry probes and counts each failure", async () => {
    const timeouts: number[] = [];
    const checkHealth = mock(
      async (
        _port: number,
        _path?: string,
        _headers?: Record<string, string>,
        timeoutMs?: number,
      ) => {
        timeouts.push(timeoutMs ?? -1);
        return false;
      },
    );
    const delay = mock(async () => undefined);

    expect(
      await confirmRunningServerHealth(1234, undefined, () => true, { checkHealth, delay }),
    ).toEqual({ healthy: false, failedProbes: 3 });
    expect(timeouts).toEqual([
      LOCAL_SERVER_REUSE_FIRST_PROBE_TIMEOUT_MS,
      LOCAL_SERVER_REUSE_RETRY_PROBE_TIMEOUT_MS,
      LOCAL_SERVER_REUSE_RETRY_PROBE_TIMEOUT_MS,
    ]);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(LOCAL_SERVER_REUSE_HEALTH_INTERVAL_MS);
  });
});

describe("warmOpenCodeInstance", () => {
  test("names the directory on an authenticated status read with the long deadline", async () => {
    const checkHealth = mock(async () => true);
    const headers = { Authorization: "Basic test" };

    expect(await warmOpenCodeInstance(4321, "/workspace", headers, { checkHealth })).toBe(true);
    expect(checkHealth).toHaveBeenCalledTimes(1);
    expect(checkHealth).toHaveBeenCalledWith(
      4321,
      "/session/status?directory=%2Fworkspace",
      headers,
      OPENCODE_INSTANCE_WARM_TIMEOUT_MS,
    );
    // Longer than the 30 s bridge request deadline the status read uses.
    expect(OPENCODE_INSTANCE_WARM_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  test("reports a server that does not finish loading without throwing", async () => {
    const checkHealth = mock(async () => false);

    expect(await warmOpenCodeInstance(4321, "/workspace", {}, { checkHealth, timeoutMs: 5 })).toBe(
      false,
    );
    expect(checkHealth).toHaveBeenCalledWith(4321, expect.any(String), {}, 5);
  });
});

describe("isHealthyHttpResponse", () => {
  test("accepts any non-HTML 2xx, including plain text and no content type", () => {
    expect(isHealthyHttpResponse(200, "application/json")).toBe(true);
    expect(isHealthyHttpResponse(204, undefined)).toBe(true);
    expect(isHealthyHttpResponse(200, "text/plain; charset=utf-8")).toBe(true);
  });

  test("refuses HTML pages and non-2xx statuses", () => {
    expect(isHealthyHttpResponse(200, "text/html")).toBe(false);
    expect(isHealthyHttpResponse(200, " Text/HTML; charset=utf-8")).toBe(false);
    expect(isHealthyHttpResponse(401, "application/json")).toBe(false);
    expect(isHealthyHttpResponse(503, undefined)).toBe(false);
    expect(isHealthyHttpResponse(undefined, undefined)).toBe(false);
  });
});

describe("checkHttpHealth", () => {
  async function withServer(
    status: number,
    headers: OutgoingHttpHeaders,
    body: string,
    run: (port: number) => Promise<void>,
  ): Promise<void> {
    const server = createServer((_request, response) => {
      response.writeHead(status, headers);
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await run((server.address() as AddressInfo).port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test("treats a 1.x JSON health answer as healthy", async () => {
    await withServer(
      200,
      { "content-type": "application/json" },
      '{"healthy":true,"version":"1.19.4"}',
      async (port) => expect(await checkHttpHealth(port)).toBe(true),
    );
  });

  test("treats OpenCode 2.x's web app fallback on /global/health as unhealthy", async () => {
    // What `opencode serve` 2.2.2 returns for GET /global/health, before auth.
    await withServer(
      200,
      { "content-type": "text/html" },
      "<!doctype html><html></html>",
      async (port) => expect(await checkHttpHealth(port)).toBe(false),
    );
  });

  test("waitForUnhealthy returns after the first HTML response while the port stays open", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      expect(request.url).toBe("/global/health");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      // One attempt proves immediate success without a wall-clock assertion.
      await expect(
        waitForUnhealthy((server.address() as AddressInfo).port, 1),
      ).resolves.toBeUndefined();
      expect(requests).toBe(1);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
