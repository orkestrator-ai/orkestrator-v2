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
import { workerContextDigest } from "./preview-worker-context-digest.js";
import {
  localWorkerPinFile,
  prepareWorkerImage,
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

/**
 * A fake `docker` CLI: image present only after a build or pull; every call
 * is logged. A label inspect prints `label` (the pulled image's context label).
 */
function fakeDocker(label = "", present = false): { cli: string; log: () => string[][] } {
  const dir = scratch("ork-fake-docker-");
  const log = path.join(dir, "calls.log");
  const built = path.join(dir, "built");
  const pulled = path.join(dir, "pulled");
  if (present) {
    writeFileSync(built, "");
    writeFileSync(pulled, "");
  }
  const cli = path.join(dir, "docker");
  writeFileSync(
    cli,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  version) echo 29.8.0; exit 0 ;;
  build) touch '${built}'; echo '${BUILT_ID}'; exit 0 ;;
  pull) touch '${pulled}'; exit 0 ;;
  image)
    for reference do :; done
    case "$reference" in
      *@sha256:*) test -f '${pulled}' || exit 1 ;;
      *) test -f '${built}' || exit 1 ;;
    esac
    case "$*" in *Labels*) echo '${label}' ;; *) echo '${BUILT_ID}' ;; esac
    exit 0 ;;
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

function publishedPin(contextDigest: string): string {
  const file = path.join(scratch("ork-published-pin-"), "published-image.json");
  writeFileSync(
    file,
    JSON.stringify({
      image: "ghcr.io/example/artifact-preview-worker",
      digest: DIGEST,
      contextDigest,
    }),
  );
  return file;
}

/** Stage through the actual subprocess path; expose the target to check cleanup. */
function stageScript(): { script: string; target: () => string } {
  const dir = scratch("ork-stage-script-");
  const script = path.join(dir, "stage.ts");
  const record = path.join(dir, "target");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
import path from "node:path";
writeFileSync(${JSON.stringify(record)}, process.argv[2]);
writeFileSync(path.join(process.argv[2], "Dockerfile"), "FROM scratch\\n");
`,
  );
  return { script, target: () => readFileSync(record, "utf8") };
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

  test("a published digest built from the shipped context is pulled exactly; an explicit process configuration is not switched", async () => {
    const context = buildContext();
    const contextDigest = await workerContextDigest(context);
    const docker = fakeDocker(contextDigest);
    const pinDir = scratch("ork-published-pin-");
    const pinFile = path.join(pinDir, "published-image.json");
    writeFileSync(
      pinFile,
      JSON.stringify({
        image: "ghcr.io/example/artifact-preview-worker",
        tag: "1",
        digest: DIGEST,
        contextDigest,
      }),
    );
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: scratch("ork-runtime-pull-"),
      env: {
        ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: docker.cli,
        ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION: "process",
      },
      workerBuildContext: { context, stageScript: null },
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
    // The pulled image's context label is checked against the pin.
    expect(docker.log().at(-1)?.join(" ")).toBe(
      `image inspect --format {{index .Config.Labels "orkestrator.artifact-preview-worker.context"}} ghcr.io/example/artifact-preview-worker@${DIGEST}`,
    );
  });

  test("a pin for another context, a failed pull or a disagreeing label falls back to building", async () => {
    const context = buildContext();
    const contextDigest = await workerContextDigest(context);
    const other = `sha256:${"9".repeat(64)}`;
    const published = (digest: string) => ({
      reference: `ghcr.io/example/artifact-preview-worker@${DIGEST}`,
      repository: "ghcr.io/example/artifact-preview-worker",
      digest: DIGEST,
      contextDigest: digest,
    });
    const prepare = (docker: { cli: string }, digest: string) =>
      prepareWorkerImage({
        docker: docker.cli,
        tag: DEFAULT_PREVIEW_WORKER_IMAGE,
        dataDir: scratch("ork-prepare-fallback-"),
        published: published(digest),
        buildContext: { context, stageScript: null },
      });

    // Another context: never pulled.
    const stale = fakeDocker(contextDigest);
    expect(await prepare(stale, other)).toEqual({
      ok: true,
      method: "build",
      reference: BUILT_ID,
      pinned: true,
      publishedSkipped: "context_mismatch",
    });
    expect(stale.log().some((args) => args[0] === "pull")).toBe(false);

    // The registry served an image labelled for another context.
    const mislabelled = fakeDocker(other);
    expect(await prepare(mislabelled, contextDigest)).toMatchObject({
      ok: true,
      method: "build",
      reference: BUILT_ID,
      publishedSkipped: "label_mismatch",
    });
    expect(mislabelled.log().map((args) => args[0])).toEqual([
      "version",
      "pull",
      "image",
      "build",
      "image",
    ]);

    // Docker cannot pull at all.
    const offline = scratch("ork-fake-docker-offline-");
    const offlineCli = path.join(offline, "docker");
    writeFileSync(
      offlineCli,
      `#!/bin/sh
case "$1" in
  version) echo 29.8.0; exit 0 ;;
  build) echo '${BUILT_ID}'; exit 0 ;;
  image) case "$*" in *Labels*) exit 1 ;; *) echo '${BUILT_ID}'; exit 0 ;; esac ;;
  *) exit 1 ;;
esac
`,
    );
    chmodSync(offlineCli, 0o755);
    expect(await prepare({ cli: offlineCli }, contextDigest)).toMatchObject({
      ok: true,
      method: "build",
      publishedSkipped: "pull_failed",
    });
  });

  test("at startup a present published image is preferred only when built from the shipped context", async () => {
    const context = buildContext();
    const contextDigest = await workerContextDigest(context);
    const reference = `ghcr.io/example/artifact-preview-worker@${DIGEST}`;
    const start = async (pinned: string) => {
      const pinFile = path.join(scratch("ork-startup-pin-"), "published-image.json");
      writeFileSync(
        pinFile,
        JSON.stringify({
          image: "ghcr.io/example/artifact-preview-worker",
          digest: DIGEST,
          contextDigest: pinned,
        }),
      );
      const runtime = await createTranscriptArtifactRuntime({
        dataDir: scratch("ork-runtime-startup-"),
        env: { ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: fakeDocker(contextDigest, true).cli },
        workerBuildContext: { context, stageScript: null },
        publishedPinFile: pinFile,
        imagePinFile: null,
      });
      cleanups.push(() => runtime.close());
      return runtime.config.workerImage?.reference;
    };
    expect(await start(contextDigest)).toBe(reference);
    // A pin left from another context names an image built from other sources.
    expect(await start(`sha256:${"9".repeat(64)}`)).toBe(DEFAULT_PREVIEW_WORKER_IMAGE);
  });

  for (const isolation of ["auto", "container"] as const) {
    test(`a source checkout stages, pulls and reuses the published worker after restart (${isolation})`, async () => {
      const contextDigest = await workerContextDigest(buildContext());
      const docker = fakeDocker(contextDigest);
      const stage = stageScript();
      const options = {
        dataDir: scratch("ork-source-restart-"),
        env: {
          ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: docker.cli,
          ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION: isolation,
        },
        workerBuildContext: { context: null, stageScript: stage.script },
        publishedPinFile: publishedPin(contextDigest),
      };
      const first = await createTranscriptArtifactRuntime(options);
      cleanups.push(() => first.close());
      expect(await first.prepareWorker()).toMatchObject({ state: "ready", method: "pull" });
      expect(existsSync(stage.target())).toBe(false);
      await first.close();
      const restarted = await createTranscriptArtifactRuntime(options);
      cleanups.push(() => restarted.close());
      expect(restarted.config).toMatchObject({
        isolation: "container",
        workerImage: {
          reference: `ghcr.io/example/artifact-preview-worker@${DIGEST}`,
          pinned: true,
        },
      });
      expect(existsSync(stage.target())).toBe(false);
      expect(docker.log().filter((args) => args[0] === "pull")).toHaveLength(1);
      expect(docker.log().some((args) => args[0] === "build")).toBe(false);
      // No default local tag was created by pulling.
      expect(existsSync(localWorkerPinFile(options.dataDir))).toBe(false);
    });
  }

  for (const label of ["", `sha256:${"9".repeat(64)}`]) {
    test(`startup rejects a published image with a missing or wrong label (${label || "missing"})`, async () => {
      const context = buildContext();
      const docker = fakeDocker(label);
      const options = {
        dataDir: scratch("ork-rejected-restart-"),
        env: { ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: docker.cli },
        workerBuildContext: { context, stageScript: null },
        publishedPinFile: publishedPin(await workerContextDigest(context)),
      };
      const first = await createTranscriptArtifactRuntime(options);
      cleanups.push(() => first.close());
      expect(await first.prepareWorker()).toMatchObject({
        state: "ready",
        method: "build",
        image: BUILT_ID,
      });
      await first.close();
      const restarted = await createTranscriptArtifactRuntime(options);
      cleanups.push(() => restarted.close());
      expect(restarted.config.workerImage).toEqual({ reference: BUILT_ID, pinned: true });
      expect(docker.log().filter((args) => args[0] === "pull")).toHaveLength(1);
    });
  }

  test("a published pin alone, with no build context to check it against, is not usable", async () => {
    const pinFile = path.join(scratch("ork-published-only-"), "published-image.json");
    writeFileSync(
      pinFile,
      JSON.stringify({
        image: "ghcr.io/example/artifact-preview-worker",
        digest: DIGEST,
        contextDigest: DIGEST,
      }),
    );
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: scratch("ork-runtime-published-only-"),
      env: { ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: fakeDocker().cli },
      workerBuildContext: { context: null, stageScript: null },
      publishedPinFile: pinFile,
      imagePinFile: null,
    });
    cleanups.push(() => runtime.close());
    expect(runtime.workerPreparation()).toMatchObject({ available: false });
    expect(runtime.workerPreparation().reason).toContain("build context");
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
  test("only a valid repository, digest and context digest are accepted", () => {
    const dir = scratch("ork-pin-");
    const write = (value: unknown) => {
      const file = path.join(dir, `${Math.random()}.json`);
      writeFileSync(file, JSON.stringify(value));
      return file;
    };
    expect(
      readPublishedWorkerImage(
        write({ image: "ghcr.io/a/b", digest: DIGEST, contextDigest: BUILT_ID }),
      ),
    ).toEqual({
      reference: `ghcr.io/a/b@${DIGEST}`,
      repository: "ghcr.io/a/b",
      digest: DIGEST,
      contextDigest: BUILT_ID,
    });
    for (const bad of [
      { image: "ghcr.io/a/b:latest", digest: DIGEST, contextDigest: BUILT_ID },
      { image: "ghcr.io/a/b; rm -rf /", digest: DIGEST, contextDigest: BUILT_ID },
      { image: "ghcr.io/a/b", digest: "sha256:short", contextDigest: BUILT_ID },
      // A pin that does not name its build context is never pulled.
      { image: "ghcr.io/a/b", digest: DIGEST },
      { image: "ghcr.io/a/b", digest: DIGEST, contextDigest: "sha256:short" },
      { image: null, digest: null, contextDigest: null },
    ])
      expect(readPublishedWorkerImage(write(bad))).toBeNull();
    const checkedIn = resolvePublishedPinFile();
    expect(checkedIn).toBeDefined();
    const pin = JSON.parse(readFileSync(checkedIn!, "utf8"));
    if (pin.image === null && pin.digest === null && pin.contextDigest === null)
      expect(readPublishedWorkerImage(checkedIn)).toBeNull();
    else
      expect(readPublishedWorkerImage(checkedIn)).toEqual({
        reference: `${pin.image}@${pin.digest}`,
        repository: pin.image,
        digest: pin.digest,
        contextDigest: pin.contextDigest,
      });
  });
});
