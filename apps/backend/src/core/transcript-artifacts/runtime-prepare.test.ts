/**
 * Content listener configuration (remote browsers) and on-demand container
 * worker preparation with re-selection of isolation, against a fake Docker
 * CLI that records its fixed argument vectors.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PreviewRunner } from "./contracts.js";
import {
  localWorkerPinFile,
  readPublishedWorkerImage,
  resolvePublishedPinFile,
} from "./preview-worker-prepare.js";
import { TranscriptPreviewRunner } from "./preview-runner.js";
import {
  DEFAULT_PREVIEW_WORKER_IMAGE,
  createTranscriptArtifactRuntime,
  resolveContentListenerConfig,
} from "./runtime.js";

const BUILT_ID = `sha256:${"7".repeat(64)}`;
const DIGEST = `sha256:${"8".repeat(64)}`;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake `docker` CLI: image present only after a build or pull; every call is logged. */
function fakeDocker(): { cli: string; log: () => string[][] } {
  const dir = scratch("ork-fake-docker-");
  const log = path.join(dir, "calls.log");
  const built = path.join(dir, "built");
  const cli = path.join(dir, "docker");
  writeFileSync(
    cli,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  version) echo 29.8.0; exit 0 ;;
  build) touch '${built}'; echo '${BUILT_ID}'; exit 0 ;;
  pull) touch '${built}'; exit 0 ;;
  image) if [ -f '${built}' ]; then echo '${BUILT_ID}'; exit 0; fi; exit 1 ;;
  ps) exit 0 ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(cli, 0o755);
  return {
    cli,
    log: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.split(" "))
        : [],
  };
}

function buildContext(): string {
  const dir = scratch("ork-worker-context-");
  writeFileSync(path.join(dir, "Dockerfile"), "FROM scratch\n");
  return dir;
}

describe("content listener configuration", () => {
  test("defaults to loopback on an ephemeral port", () => {
    expect(resolveContentListenerConfig({})).toEqual({
      bindHost: "127.0.0.1",
      port: 0,
      warnings: [],
    });
  });

  test("a bind address is honoured only with a hosted content origin", () => {
    const ignored = resolveContentListenerConfig({
      ORKESTRATOR_ARTIFACT_CONTENT_BIND: "100.101.102.103",
    });
    expect(ignored.bindHost).toBe("127.0.0.1");
    expect(ignored.warnings.join(" ")).toContain(
      "ignored without ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN",
    );

    const hosted = resolveContentListenerConfig({
      ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN: "https://artifacts.example-content.net",
      ORKESTRATOR_ARTIFACT_CONTENT_BIND: "100.101.102.103",
      ORKESTRATOR_ARTIFACT_CONTENT_PORT: "34200",
    });
    expect(hosted).toEqual({
      bindHost: "100.101.102.103",
      port: 34200,
      publicOrigin: "https://artifacts.example-content.net",
      warnings: [],
    });
    for (const [bind, expected] of [
      ["fd7a:115c:a1e0::5", "fd7a:115c:a1e0::5"],
      ["[::1]", "::1"],
      ["localhost", "127.0.0.1"],
    ] as const) {
      expect(
        resolveContentListenerConfig({
          ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN: "https://artifacts.example-content.net",
          ORKESTRATOR_ARTIFACT_CONTENT_PORT: "34200",
          ORKESTRATOR_ARTIFACT_CONTENT_BIND: bind,
        }).bindHost,
      ).toBe(expected);
    }
  });

  test("wildcard, LAN and public interfaces are refused; the listener stays on loopback", () => {
    for (const bind of ["0.0.0.0", "::", "192.168.1.20", "8.8.8.8", "100.128.0.1", "example.com"]) {
      const config = resolveContentListenerConfig({
        ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN: "https://artifacts.example-content.net",
        ORKESTRATOR_ARTIFACT_CONTENT_PORT: "34200",
        ORKESTRATOR_ARTIFACT_CONTENT_BIND: bind,
      });
      expect(config.bindHost).toBe("127.0.0.1");
      expect(config.warnings.join(" ")).toContain("loopback or Tailscale");
    }
  });

  test("origins must be bare http(s) origins; ports must be ports", () => {
    for (const origin of ["https://x.example/sub/path", "ftp://x.example", "https://u:p@x.example"])
      expect(() =>
        resolveContentListenerConfig({ ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN: origin }),
      ).toThrow();
    const noPort = resolveContentListenerConfig({
      ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN: "https://artifacts.example-content.net/",
    });
    expect(noPort.publicOrigin).toBe("https://artifacts.example-content.net");
    expect(noPort.warnings.join(" ")).toContain("without ORKESTRATOR_ARTIFACT_CONTENT_PORT");
    const badPort = resolveContentListenerConfig({ ORKESTRATOR_ARTIFACT_CONTENT_PORT: "99999" });
    expect(badPort.port).toBe(0);
    expect(badPort.warnings).toHaveLength(1);
  });

  test("the runtime listens where configured and serves only the hosted origin's host", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = probe.port;
    probe.stop(true);
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: scratch("ork-runtime-bind-"),
      env: {
        ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION: "disabled",
        ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN: "https://artifacts.example-content.net",
        ORKESTRATOR_ARTIFACT_CONTENT_PORT: String(port),
        ORKESTRATOR_ARTIFACT_CONTENT_BIND: "127.0.0.1",
      },
      applicationOrigins: ["https://ork.tailnet-name.ts.net"],
    });
    cleanups.push(() => runtime.close());
    expect(runtime.contentServer.origin()).toBe("https://artifacts.example-content.net");
    // Bound where configured; a request naming another host is misdirected.
    const wrongHost = await fetch(`http://127.0.0.1:${port}/a/${"x".repeat(43)}`);
    expect(wrongHost.status).toBe(421);
    const missing = await fetch(`http://127.0.0.1:${port}/a/${"x".repeat(43)}`, {
      headers: { host: "artifacts.example-content.net" },
    });
    expect(missing.status).toBe(404);
  });
});

describe("worker preparation", () => {
  test("builds the shipped context with fixed arguments, pins it and switches auto isolation to container", async () => {
    const docker = fakeDocker();
    const dataDir = scratch("ork-runtime-prepare-");
    const context = buildContext();
    const runtime = await createTranscriptArtifactRuntime({
      dataDir,
      env: { ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: docker.cli },
      workerBuildContext: { context, stageScript: null },
      publishedPinFile: null,
      imagePinFile: null,
    });
    cleanups.push(() => runtime.close());
    expect(runtime.config.isolation).toBe("process");
    expect(runtime.config.interactiveIsolation).toBe("unavailable");
    expect(runtime.workerPreparation()).toMatchObject({ available: true, state: "idle" });
    const before = runtime.runner;
    const switched: PreviewRunner[] = [];
    runtime.onRunnerChange((runner) => switched.push(runner));

    const [result, shared] = await Promise.all([runtime.prepareWorker(), runtime.prepareWorker()]);
    expect(shared).toEqual(result);
    expect(result).toMatchObject({
      available: true,
      state: "ready",
      method: "build",
      image: BUILT_ID,
      isolation: "container",
      interactiveIsolation: "container",
    });
    expect(runtime.runner).not.toBe(before);
    expect(switched).toEqual([runtime.runner]);
    expect(runtime.runner).toBeInstanceOf(TranscriptPreviewRunner);
    expect(runtime.runner.status()).toMatchObject({
      interactiveIsolation: "container",
      workerImage: { reference: BUILT_ID, pinned: true },
    });
    expect(runtime.config).toMatchObject({
      isolation: "container",
      interactiveIsolation: "container",
      workerImage: { reference: BUILT_ID, pinned: true },
    });
    const builds = docker.log().filter((args) => args[0] === "build");
    expect(builds).toEqual([
      [
        "build",
        "--quiet",
        "--pull=false",
        "--label",
        "orkestrator.artifact-preview-worker=1",
        "--tag",
        DEFAULT_PREVIEW_WORKER_IMAGE,
        context,
      ],
    ]);
    expect(JSON.parse(readFileSync(localWorkerPinFile(dataDir), "utf8"))).toEqual({
      tag: DEFAULT_PREVIEW_WORKER_IMAGE,
      id: BUILT_ID,
    });
    expect(runtime.workerPreparation()).toMatchObject({ state: "ready", image: BUILT_ID });
  });

  test("a published digest is pulled exactly; an explicit process configuration is not switched", async () => {
    const docker = fakeDocker();
    const pinDir = scratch("ork-published-pin-");
    const pinFile = path.join(pinDir, "published-image.json");
    writeFileSync(
      pinFile,
      JSON.stringify({
        image: "ghcr.io/example/artifact-preview-worker",
        tag: "1",
        digest: DIGEST,
      }),
    );
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: scratch("ork-runtime-pull-"),
      env: {
        ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: docker.cli,
        ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION: "process",
      },
      workerBuildContext: { context: null, stageScript: null },
      publishedPinFile: pinFile,
      imagePinFile: null,
    });
    cleanups.push(() => runtime.close());
    const before = runtime.runner;
    const result = await runtime.prepareWorker();
    expect(result).toMatchObject({
      state: "ready",
      method: "pull",
      image: `ghcr.io/example/artifact-preview-worker@${DIGEST}`,
      isolation: "process",
      interactiveIsolation: "unavailable",
    });
    expect(runtime.runner).toBe(before);
    expect(docker.log().find((args) => args[0] === "pull")).toEqual([
      "pull",
      "--quiet",
      `ghcr.io/example/artifact-preview-worker@${DIGEST}`,
    ]);
    expect(docker.log().some((args) => args[0] === "build")).toBe(false);
  });

  test("without Docker or a build context, preparation is unavailable and says why", async () => {
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: scratch("ork-runtime-nodocker-"),
      env: { ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: "/nonexistent/docker-cli" },
      workerBuildContext: { context: buildContext(), stageScript: null },
      publishedPinFile: null,
    });
    cleanups.push(() => runtime.close());
    expect(runtime.workerPreparation()).toMatchObject({ available: false });
    expect(runtime.workerPreparation().reason).toContain("Docker");
    expect(await runtime.prepareWorker()).toMatchObject({ state: "failed", isolation: "process" });

    const noContext = await createTranscriptArtifactRuntime({
      dataDir: scratch("ork-runtime-nocontext-"),
      env: { ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: fakeDocker().cli },
      workerBuildContext: { context: null, stageScript: null },
      publishedPinFile: null,
    });
    cleanups.push(() => noContext.close());
    expect(noContext.workerPreparation()).toMatchObject({ available: false });
    expect(noContext.workerPreparation().reason).toContain("build context");
  });
});

describe("published image pin", () => {
  test("only a valid repository and digest are accepted; the checked-in pin is unpublished", () => {
    const dir = scratch("ork-pin-");
    const write = (value: unknown) => {
      const file = path.join(dir, `${Math.random()}.json`);
      writeFileSync(file, JSON.stringify(value));
      return file;
    };
    expect(readPublishedWorkerImage(write({ image: "ghcr.io/a/b", digest: DIGEST }))).toEqual({
      reference: `ghcr.io/a/b@${DIGEST}`,
      repository: "ghcr.io/a/b",
      digest: DIGEST,
    });
    for (const bad of [
      { image: "ghcr.io/a/b:latest", digest: DIGEST },
      { image: "ghcr.io/a/b; rm -rf /", digest: DIGEST },
      { image: "ghcr.io/a/b", digest: "sha256:short" },
      { image: null, digest: null },
    ])
      expect(readPublishedWorkerImage(write(bad))).toBeNull();
    const checkedIn = resolvePublishedPinFile();
    expect(checkedIn).toBeDefined();
    expect(readPublishedWorkerImage(checkedIn)).toBeNull();
  });
});
