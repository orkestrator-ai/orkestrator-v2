import { afterEach, expect, spyOn, test } from "bun:test";
import { parseOptions } from "../src/options.js";
import { GatewayContext } from "../src/gateway-context.js";
import { GatewayLifecycle } from "../src/gateway-lifecycle.js";
import { askServeArguments } from "../../../packages/cli/src/client/service-setup.js";
import {
  captureIo,
  createSandbox,
  type ClientSandbox,
} from "../../../packages/cli/tests/support/client-harness.js";
const sandboxes: ClientSandbox[] = [];
afterEach(async () => {
  for (const box of sandboxes.splice(0)) await box.cleanup();
});
const tailscaleReady = {
  hasTailscaleAddress: () => true,
  findTailscaleCli: () => "/usr/bin/tailscale",
  tailscaleOperatorNeeded: () => null,
  grantTailscaleOperator: () => false,
};
const installCommand = ["bunx", "orkestrator", "service", "install", "--yes"];
function scripted(answers: string[]) {
  const io = captureIo({});
  io.question = async () => answers.shift() ?? null;
  return { io };
}
test.each(["ssh", "tailnet"])(
  "%s settings determine startup listeners with Tailscale available",
  async (access) => {
    const box = await createSandbox();
    sandboxes.push(box);
    const { io } = scripted(access === "ssh" ? ["3", "y"] : ["2", "y", "y"]);
    const args = await askServeArguments(io, { installCommand, probe: tailscaleReady });
    const options = parseOptions(args, {});
    const ctx = new GatewayContext(
      {
        dataDir: box.root,
        rendererRoot: box.root,
        backend: { invoke: async () => null },
        bindAddress: options.host,
        allowNonTailscaleBind: options.allowNonTailscaleBind,
        loopbackClientPort: options.loopbackClientPort,
        env: {},
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        interfaces: {
          tailscale0: [
            {
              address: "100.64.0.10",
              family: "IPv4",
              internal: false,
              netmask: "255.255.255.255",
              cidr: "100.64.0.10/32",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      },
      {
        gatewayCredentialMatches: () => false,
        gatewayCredentialExpiresAt: () => null,
        isOriginAllowed: () => false,
      },
    );
    const lifecycle = new GatewayLifecycle(ctx, { handle: async () => {} });
    const addresses: string[] = [];
    // Simulate socket creation so this test needs no real Tailscale interface.
    const listener = spyOn(lifecycle, "listen").mockImplementation(async (bindAddress, port) => {
      addresses.push(bindAddress);
      return { bindAddress, port, url: `http://${bindAddress}:${port}` };
    });
    try {
      await lifecycle.start();
      expect(addresses).toEqual(
        access === "ssh" ? ["127.0.0.1", "127.0.0.1"] : ["100.64.0.10", "127.0.0.1"],
      );
    } finally {
      listener.mockRestore();
      await lifecycle.stop();
    }
  },
);
