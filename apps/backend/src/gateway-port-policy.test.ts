import { afterEach, beforeEach, expect, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { logGatewayPortPolicy } from "./gateway-port-policy.js";

const env = { HOME: "/fixture/home", XDG_CONFIG_HOME: "/fixture/config" };

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});

test.each([0, 45000])("second backend logs its actual port policy: %s", async (port) => {
  await logGatewayPortPolicy(
    { dataDir: "/fixture/secondary", port, tailscaleServe: false },
    env,
    async () => ({ pid: 42, url: "http://127.0.0.1:34121/" }),
  );
  expect(logs.records()).toMatchObject([
    {
      level: "info",
      event: "port-policy.second-backend",
      fields: { mainPid: 42, gatewayPort: port || "free", controlPort: "left-to-main" },
    },
  ]);
});

test("implicit free-port Serve logs durable recovery and the strict pin remedy", async () => {
  await logGatewayPortPolicy(
    { dataDir: "/fixture/secondary", port: 0, tailscaleServe: true },
    env,
    async () => null,
  );
  expect(logs.records()).toMatchObject([
    { level: "warn", event: "port-policy.serve-on-free-port" },
  ]);
});
