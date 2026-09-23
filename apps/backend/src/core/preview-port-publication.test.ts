import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { publishedPortArguments } from "./commands-containers.js";
import { desiredGeneratedDefinitions } from "./preview-service-registry.js";
import { createPreviewHarness, type PreviewHarness } from "./preview-test-support.js";
import { isPortMapping } from "./storage-shared-core.js";

describe("published port arguments", () => {
  test("automatic mappings let Docker choose a loopback host port; fixed and UDP mappings are kept", () => {
    expect(
      publishedPortArguments(
        [
          { containerPort: 5173, hostPort: 0, protocol: "tcp", hostPortMode: "auto" },
          { containerPort: 8080, hostPort: 18080, protocol: "tcp" },
          { containerPort: 5353, hostPort: 15353, protocol: "udp" },
        ],
        undefined,
      ),
    ).toEqual([
      "-p",
      "127.0.0.1::5173/tcp",
      "-p",
      "127.0.0.1:18080:8080/tcp",
      "-p",
      "127.0.0.1:15353:5353/udp",
    ]);
  });

  test("an explicit TCP mapping of the entry port takes precedence over its automatic publication", () => {
    expect(publishedPortArguments([], 3000)).toEqual(["-p", "127.0.0.1::3000/tcp"]);
    expect(
      publishedPortArguments([{ containerPort: 3000, hostPort: 3001, protocol: "tcp" }], 3000),
    ).toEqual(["-p", "127.0.0.1:3001:3000/tcp"]);
    // A UDP mapping on the same number does not publish the HTTP entry port.
    expect(
      publishedPortArguments([{ containerPort: 3000, hostPort: 3001, protocol: "udp" }], 3000),
    ).toEqual(["-p", "127.0.0.1:3001:3000/udp", "-p", "127.0.0.1::3000/tcp"]);
  });
});

describe("port mapping validation", () => {
  test("zero is valid only with the explicit automatic mode", () => {
    expect(
      isPortMapping({ containerPort: 3000, hostPort: 0, protocol: "tcp", hostPortMode: "auto" }),
    ).toBe(true);
    expect(isPortMapping({ containerPort: 3000, hostPort: 0, protocol: "tcp" })).toBe(false);
    expect(
      isPortMapping({ containerPort: 3000, hostPort: 3001, protocol: "tcp", hostPortMode: "auto" }),
    ).toBe(false);
    expect(
      isPortMapping({
        containerPort: 3000,
        hostPort: 3001,
        protocol: "tcp",
        hostPortMode: "dynamic",
      }),
    ).toBe(false);
    expect(isPortMapping({ containerPort: 3000, hostPort: 3001, protocol: "tcp" })).toBe(true);
  });
});

describe("automatic mappings become preview services", () => {
  let harness: PreviewHarness;
  beforeEach(async () => {
    harness = await createPreviewHarness();
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  test("seeded like fixed mappings and resolved from Docker's actual binding", async () => {
    await harness.addContainerEnvironment("a", {
      portMappings: [{ containerPort: 5173, hostPort: 0, protocol: "tcp", hostPortMode: "auto" }],
    });
    const environment = (await harness.storage.getEnvironment("a"))!;
    expect(environment.portMappings).toEqual([
      { containerPort: 5173, hostPort: 0, protocol: "tcp", hostPortMode: "auto" },
    ]);
    expect(desiredGeneratedDefinitions(environment).map((definition) => definition.key)).toEqual([
      "mapping:5173",
    ]);
    harness.docker.containers.set("container-a", {
      id: "container-a",
      environmentId: "a",
      owner: harness.owner,
      ports: { "5173/tcp": [{ HostIp: "127.0.0.1", HostPort: "49321" }] },
    });
    await harness.runtime.init();
    await harness.runtime.registry.settle();
    expect(
      harness.runtime.registry.snapshot({ environmentId: "a" }).services[0]!.endpoint.hostPort,
    ).toBe(49321);
  });
});
