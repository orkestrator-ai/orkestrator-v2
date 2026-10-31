import { expect, mock, test } from "bun:test";
import { logGatewayPortPolicy } from "./gateway-port-policy.js";

const env = { HOME: "/fixture/home", XDG_CONFIG_HOME: "/fixture/config" };

test.each([0, 45000])("second backend logs its actual port policy: %s", async (port) => {
  const logger = { info: mock(() => {}), warn: mock(() => {}) };
  await logGatewayPortPolicy(
    { dataDir: "/fixture/secondary", port, tailscaleServe: false },
    env,
    logger,
    async () => ({ pid: 42, url: "http://127.0.0.1:34121/" }),
  );
  expect(logger.info).toHaveBeenCalledWith(
    expect.stringContaining(port ? "asks for gateway port 45000" : "takes a free gateway port"),
  );
  expect(logger.info).toHaveBeenCalledWith(
    expect.stringContaining("leaves the fixed Control MCP port to it"),
  );
  expect(logger.warn).not.toHaveBeenCalled();
});

test("implicit free-port Serve logs durable recovery and the strict pin remedy", async () => {
  const logger = { info: mock(() => {}), warn: mock(() => {}) };
  await logGatewayPortPolicy(
    { dataDir: "/fixture/secondary", port: 0, tailscaleServe: true },
    env,
    logger,
    async () => null,
  );
  expect(logger.info).not.toHaveBeenCalled();
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining("owned Serve targets are recovered across restarts"),
  );
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining("--port with --strict-gateway-port"),
  );
});
