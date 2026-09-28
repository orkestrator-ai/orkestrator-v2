import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { DockerTopology, ImageStatus } from "@orkestrator/protocol/image-manifest";
import * as realBackend from "@/lib/backend";

const realBackendSnapshot = { ...realBackend };

let imageStatus: ImageStatus;
let topology: DockerTopology;
const getDockerImageStatus = mock(async () => imageStatus);
const getDockerTopology = mock(async (_refresh?: boolean) => topology);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getDockerImageStatus,
  getDockerTopology,
}));

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

afterEach(() => {
  cleanup();
});

const { DockerImageStatusPanel } = await import("./DockerImageStatusPanel");

const localEngine: DockerTopology = {
  kind: "local-engine",
  rootless: false,
  osType: "linux",
  architecture: "x86_64",
  serverVersion: "29.7.2",
  supportsLocalResources: true,
  remediation: null,
};

describe("DockerImageStatusPanel", () => {
  test("shows the immutable identity and declared contracts of a compatible image", async () => {
    imageStatus = {
      state: "compatible",
      imageRef: "orkestrator-v2:latest",
      imageId: `sha256:${"a".repeat(64)}`,
      registryDigest: null,
      architecture: "amd64",
      manifest: {
        appVersion: "2.17.0",
        sourceRevision: "b27421dcfa8d",
        capabilities: { "workspace-prepare": 1 },
        agents: {},
        runtimes: {},
      },
      missingCapabilities: [],
      remediation: null,
    };
    topology = localEngine;
    render(<DockerImageStatusPanel />);

    expect(await screen.findByText("Compatible")).toBeTruthy();
    expect(screen.getByText("aaaaaaaaaaaa")).toBeTruthy();
    expect(screen.getByText("workspace-prepare v1")).toBeTruthy();
    expect(screen.getByText("Local Docker Engine 29.7.2")).toBeTruthy();
  });

  test("explains a legacy image and a remote daemon with fixed remediation", async () => {
    imageStatus = {
      state: "legacy",
      imageRef: "orkestrator-v2:latest",
      imageId: `sha256:${"b".repeat(64)}`,
      registryDigest: null,
      architecture: "arm64",
      manifest: null,
      missingCapabilities: ["workspace-prepare"],
      remediation: "The environment image predates image manifests.",
    };
    topology = {
      ...localEngine,
      kind: "remote",
      supportsLocalResources: false,
      remediation: "Run the standalone backend on the Docker host.",
    };
    render(<DockerImageStatusPanel />);

    expect(await screen.findByText("Legacy image")).toBeTruthy();
    expect(screen.getByText("workspace-prepare")).toBeTruthy();
    expect(screen.getByText("The environment image predates image manifests.")).toBeTruthy();
    expect(screen.getByText("Run the standalone backend on the Docker host.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh image status" })).toBeTruthy();
  });
});
