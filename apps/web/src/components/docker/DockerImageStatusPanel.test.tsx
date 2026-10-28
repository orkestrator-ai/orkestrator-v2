import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HostMaintenanceSnapshot, HostTask } from "@orkestrator/protocol/host-maintenance";
import type { DockerTopology, ImageStatus } from "@orkestrator/protocol/image-manifest";
import * as realBackend from "@/lib/backend";

const realBackendSnapshot = { ...realBackend };

let imageStatus: ImageStatus;
let topology: DockerTopology;
const getDockerImageStatus = mock(async () => imageStatus);
const getDockerTopology = mock(async (_refresh?: boolean) => topology);
let imageTask: HostTask | undefined;
const getHostMaintenance = mock(
  async () =>
    ({ tasks: imageTask ? { "image-update": imageTask } : {} }) as HostMaintenanceSnapshot,
);
const runningTask: HostTask = {
  id: "task-1",
  kind: "image-update",
  state: "running",
  stage: "Downloading ghcr.io/orkestrator-ai/orkestrator-v2:2.34.0",
  error: null,
  result: null,
  startedAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
  completedAt: null,
};
const startHostImageUpdate = mock(async () => runningTask);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getDockerImageStatus,
  getDockerTopology,
  getHostMaintenance,
  startHostImageUpdate,
}));

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

afterEach(() => {
  cleanup();
  imageTask = undefined;
  startHostImageUpdate.mockClear();
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

  const missingImage: ImageStatus = {
    state: "missing",
    imageRef: "orkestrator-v2:latest",
    imageId: null,
    registryDigest: null,
    architecture: null,
    manifest: null,
    missingCapabilities: [],
    remediation: "Docker is running, but the environment image has not been downloaded yet.",
  };

  test("reports a missing image apart from Docker, and downloads it on request", async () => {
    imageStatus = missingImage;
    topology = { ...localEngine, kind: "desktop", serverVersion: "29.9.2" };
    render(<DockerImageStatusPanel />);

    expect(await screen.findByText("Not downloaded")).toBeTruthy();
    expect(screen.getByText("Docker Desktop 29.9.2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download image" }));

    expect(
      await screen.findByText("Downloading ghcr.io/orkestrator-ai/orkestrator-v2:2.34.0"),
    ).toBeTruthy();
    expect(startHostImageUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
  });

  test("shows a download an environment create already started", async () => {
    imageStatus = missingImage;
    topology = localEngine;
    imageTask = runningTask;
    render(<DockerImageStatusPanel />);

    expect(
      await screen.findByText("Downloading ghcr.io/orkestrator-ai/orkestrator-v2:2.34.0"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
  });

  test("an unreachable Docker hides the image instead of calling it missing", async () => {
    imageStatus = {
      ...missingImage,
      state: "unavailable",
      remediation: "Docker could not be reached. Start Docker and retry.",
    };
    topology = {
      kind: "unavailable",
      rootless: false,
      osType: null,
      architecture: null,
      serverVersion: null,
      supportsLocalResources: false,
      remediation: "Docker could not be reached. Start Docker and retry.",
    };
    render(<DockerImageStatusPanel />);

    expect(await screen.findByText("Not reachable")).toBeTruthy();
    expect(screen.queryByText("Not downloaded")).toBeNull();
    expect(screen.queryByText("orkestrator-v2:latest")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download image" })).toBeNull();
  });
});
