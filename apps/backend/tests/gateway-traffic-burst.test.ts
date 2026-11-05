import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { configureLogger, resetLogger, type LogOutput } from "@orkestrator/protocol/logger";
import { readGatewayMetrics, startGateway, waitUntil } from "./gateway-test-harness.js";

afterEach(() => resetLogger());

/** Only traffic time moves; HTTP, backend work and completion latency stay real. */
function trafficClock() {
  let now = 1_000_000;
  let tick: (() => void) | undefined;
  return {
    options: {
      now: () => now,
      schedule(callback: () => void) {
        tick = callback;
        return () => {
          tick = undefined;
        };
      },
    },
    advance(ms: number) {
      now += ms;
      tick?.();
    },
  };
}

function burstFields(logged: LogOutput[]) {
  return logged
    .filter((output) => output.record?.event === "traffic.burst")
    .map((output) => output.record!.fields!);
}

/** A real upgrade request; rejected/unsupported paths must be attributed too. */
async function rejectedUpgrade(baseUrl: string, pathname: string): Promise<void> {
  const url = new URL(pathname, baseUrl);
  await new Promise<void>((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\n` +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
          "X-Forwarded-For: 100.64.0.8\r\nUser-Agent: Chrome/140.0.0 private-client-text\r\n\r\n",
      );
    });
    socket.resume();
    socket.setTimeout(2_000, () => socket.destroy(new Error("Upgrade did not close")));
    socket.once("error", reject);
    socket.once("close", () => resolve());
  });
}

describe("gateway traffic burst", () => {
  for (const startupDelay of [999, 1_001]) {
    test(`names request spike attribution with startup at ${startupDelay}ms`, async () => {
      const logged: LogOutput[] = [];
      configureLogger({ sink: (output) => logged.push(output) });
      const clock = trafficClock();
      const { gateway, info } = await startGateway({
        trafficSummary: clock.options,
        backend: {
          hasCommand: (command) => command === "list_environments",
          invoke: async () => null,
        },
      });
      // Startup can end on either side of the constructor's window boundary.
      // Dispatch is held in one traffic window regardless of HTTP wall time.
      clock.advance(startupDelay);
      const headers = {
        authorization: `Bearer ${info.token}`,
        "x-forwarded-for": "100.64.0.7",
      };

      const requests: Promise<Response>[] = [];
      for (let i = 0; i < 100; i += 1) {
        requests.push(fetch(new URL("/__orkestrator/status", info.browserUrl), { headers }));
      }
      for (let i = 0; i < 5; i += 1) {
        requests.push(
          fetch(new URL("/__orkestrator/invoke", info.browserUrl), {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              command: "list_environments",
              args: { secret: "never-logged" },
            }),
          }),
        );
      }
      const responses = await Promise.all(requests);
      expect(responses.every((response) => response.ok)).toBe(true);
      await Promise.all(responses.map((response) => response.arrayBuffer()));
      clock.advance(7_000);

      expect(burstFields(logged)).toHaveLength(1);
      const fields = burstFields(logged)[0]!;
      expect(fields).toMatchObject({
        requests: 105,
        sources: "100.64.0.7=105",
        routes: "status=100,invoke=5",
        clients: "bun=105",
        invokes: "list_environments=5",
      });
      expect(fields.connections).toBeGreaterThan(0);
      expect(fields.listeners).toStartWith("browser=");
      await gateway.stop();
      expect(burstFields(logged)).toHaveLength(1);
      expect(logged.map((output) => output.line).join("\n")).not.toContain("never-logged");
      expect(logged.map((output) => output.line).join("\n")).not.toContain(info.token);
    });
  }

  for (const fails of [false, true]) {
    test(`attributes delayed invoke ${fails ? "failure" : "success"} before burst closure`, async () => {
      const logged: LogOutput[] = [];
      configureLogger({ sink: (output) => logged.push(output) });
      const clock = trafficClock();
      const gate = Promise.withResolvers<void>();
      let entered = 0;
      const secret = "AValidLookingSecretToken1234567890";
      const { gateway, info } = await startGateway({
        trafficSummary: clock.options,
        backend: {
          hasCommand: (command) => command === "registered_command",
          async invoke(command) {
            entered += 1;
            await gate.promise;
            if (fails || command !== "registered_command") throw new Error("Invoke failed");
            return { ok: true };
          },
        },
      });
      const headers = { authorization: `Bearer ${info.token}` };
      const pending = Array.from({ length: 102 }, (_, i) =>
        fetch(new URL("/__orkestrator/invoke", info.browserUrl), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            command: i < 100 ? "registered_command" : i === 100 ? secret : `${secret} invalid`,
            args: { secret: "never-logged" },
          }),
        }),
      );
      try {
        await waitUntil(() => entered === 102, "Deferred invokes did not arrive");
        clock.advance(7_000);
        // All invokes are still pending when the originating warning is written.
        expect(burstFields(logged)).toHaveLength(1);
        expect(burstFields(logged)[0]).toMatchObject({
          requests: 102,
          routes: "invoke=102",
          invokes: "registered_command=100,__unknown__=2",
        });
        expect((await readGatewayMetrics(info)).commands).toEqual({});

        // Resolve during another open burst: completions cannot move command
        // attribution from the first burst into this one.
        const responses = await Promise.all(
          Array.from({ length: 100 }, () =>
            fetch(new URL("/__orkestrator/status", info.browserUrl), { headers }),
          ),
        );
        await Promise.all(responses.map((response) => response.arrayBuffer()));
        gate.resolve();
        const completed = await Promise.all(pending);
        expect(completed.filter((response) => response.ok)).toHaveLength(fails ? 0 : 100);
        await Promise.all(completed.map((response) => response.arrayBuffer()));
        const metrics = await readGatewayMetrics(info);
        expect(metrics.commands.registered_command).toMatchObject({
          count: 100,
          failures: fails ? 100 : 0,
        });
        expect(metrics.commands.__unknown__).toMatchObject({ count: 2, failures: 2 });
        await gateway.stop();
        expect(burstFields(logged)).toHaveLength(2);
        expect(burstFields(logged)[1]).toMatchObject({
          requests: 102,
          routes: "status=100,metrics=2",
          invokes: "",
        });
        const lines = logged.map((output) => output.line).join("\n");
        expect(lines).not.toContain(secret);
        expect(lines).not.toContain("never-logged");
        expect(lines).not.toContain(info.token);
      } finally {
        gate.resolve();
        await Promise.all(pending).then((responses) =>
          Promise.all(
            responses.map((response) => (response.bodyUsed ? undefined : response.arrayBuffer())),
          ),
        );
      }
    });
  }

  for (const [pathname, route] of [
    ["/__orkestrator/terminal", "upgrade-terminal"],
    ["/__orkestrator/nodes/private-node-id/terminal", "upgrade-node-relay"],
    ["/__orkestrator/preview/tunnel", "upgrade-preview-tunnel"],
    ["/private-path", "upgrade-other"],
  ]) {
    test(`attributes an upgrade-only burst to ${route} once`, async () => {
      const logged: LogOutput[] = [];
      configureLogger({ sink: (output) => logged.push(output) });
      const clock = trafficClock();
      const { gateway, info } = await startGateway({ trafficSummary: clock.options });
      await Promise.all(
        Array.from({ length: 100 }, () =>
          rejectedUpgrade(info.browserUrl!, `${pathname}?secret=private-query-text`),
        ),
      );
      clock.advance(7_000);
      expect(burstFields(logged)).toHaveLength(1);
      expect(burstFields(logged)[0]).toMatchObject({
        requests: 100,
        connections: 100,
        peakRequests: 100,
        peakConnections: 100,
        sources: "100.64.0.8=100",
        clients: "chrome=100",
        routes: `${route}=100`,
        listeners: "browser=100",
        invokes: "",
      });
      await gateway.stop();
      expect(burstFields(logged)).toHaveLength(1);
      const lines = logged.map((output) => output.line).join("\n");
      for (const secret of [
        "private-node-id",
        "private-path",
        "private-query-text",
        "private-client-text",
      ]) {
        expect(lines).not.toContain(secret);
      }
    });
  }
});
