import { afterEach, describe, expect, test } from "bun:test";
import { configureLogger, resetLogger, type LogOutput } from "@orkestrator/protocol/logger";
import { startGateway } from "./gateway-test-harness.js";

afterEach(() => resetLogger());

describe("gateway traffic burst", () => {
  test("names the forwarded device, routes and invoke commands of a request spike", async () => {
    const logged: LogOutput[] = [];
    configureLogger({ sink: (output) => logged.push(output) });
    const { gateway, info } = await startGateway();
    const headers = {
      authorization: `Bearer ${info.token}`,
      // What Tailscale Serve adds; the harness listens on loopback, as Serve's upstream does.
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
          body: JSON.stringify({ command: "list_environments", args: { secret: "never-logged" } }),
        }),
      );
    }
    const responses = await Promise.all(requests);
    expect(responses.every((response) => response.ok)).toBe(true);
    await Promise.all(responses.map((response) => response.arrayBuffer()));

    await gateway.stop();

    const bursts = logged.filter((output) => output.record?.event === "traffic.burst");
    expect(bursts).toHaveLength(1);
    const fields = bursts[0]!.record!.fields!;
    expect(fields).toMatchObject({
      requests: 105,
      sources: "100.64.0.7=105",
      routes: "status=100,invoke=5",
      clients: "bun=105",
      invokes: "list_environments=5",
    });
    expect(fields.connections).toBeGreaterThan(0);
    expect(fields.listeners).toStartWith("browser=");
    expect(bursts[0]!.line).not.toContain("never-logged");
    expect(bursts[0]!.line).not.toContain(info.token);
  });
});
