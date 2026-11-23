import { describe, expect, test } from "bun:test";
import { IMAGE_CAPABILITIES } from "@orkestrator/protocol/image-manifest";
import { containerNetworkPolicy } from "./containers/network.js";
import { egressEnforcement } from "./egress-gateway.js";

/**
 * Where a new runtime's firewall runs. To-do 7905 (retired) task 1 asked for
 * the OpenCode container qualification on a restricted runtime whose firewall
 * stays inside it; this pins that the current image never creates one, so the
 * topology exists only on runtimes from an older image, whose support is
 * retired.
 */
describe("egressEnforcement", () => {
  const currentGateway = IMAGE_CAPABILITIES["egress-gateway"];
  const currentPolicy = IMAGE_CAPABILITIES["network-policy"];

  test("a restricted runtime of the current image is always behind a gateway", () => {
    for (const override of [undefined, "2", "3"]) {
      expect(
        egressEnforcement({
          networkMode: "restricted",
          networkPolicy: containerNetworkPolicy(currentPolicy, override),
          imageGatewayVersion: currentGateway,
        }),
      ).toBe("gateway");
    }
  });

  test("full access runs no firewall", () => {
    expect(
      egressEnforcement({
        networkMode: "full",
        networkPolicy: containerNetworkPolicy(currentPolicy, undefined),
        imageGatewayVersion: currentGateway,
      }),
    ).toBe("none");
  });

  test("only an image without the gateway or the environment network keeps it in the workload", () => {
    expect(
      egressEnforcement({ networkMode: "restricted", networkPolicy: 3, imageGatewayVersion: 0 }),
    ).toBe("container");
    expect(
      egressEnforcement({
        networkMode: "restricted",
        networkPolicy: containerNetworkPolicy(1, undefined),
        imageGatewayVersion: currentGateway,
      }),
    ).toBe("container");
  });
});
