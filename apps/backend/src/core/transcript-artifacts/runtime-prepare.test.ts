/**
 * Content listener configuration (remote browsers) and on-demand container
 * worker preparation with re-selection of isolation, against a fake Docker
 * CLI that records its fixed argument vectors.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PreviewRunner } from "./contracts.js";
import { WORKER_CONTEXT_LABEL, workerContextDigest } from "./preview-worker-context-digest.js";
import { localWorkerPinFile, prepareWorkerImage } from "./preview-worker-prepare.js";
import {
  PREVIEW_CONTAINER_LABEL,
  PREVIEW_CONTAINER_OWNER_LABEL,
  previewContainerOwner,
} from "./preview-supervisor.js";
import { TranscriptPreviewRunner } from "./preview-runner.js";
import {
  DEFAULT_PREVIEW_WORKER_IMAGE,
  createTranscriptArtifactRuntime,
  resolveContentListenerConfig,
} from "./runtime.js";

const OLD_ID = `sha256:${"6".repeat(64)}`;
const BUILT_ID = `sha256:${"7".repeat(64)}`;
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
 * A fake `docker` CLI: image present only after a build; every call is
 * logged. A label inspect prints the context label the build was given
 * (`localLabel` for an image that is `present` from the start, such as one
 * prepared before an upgrade).
 */
function fakeDocker(
  present = false,
  localLabel = "",
  options: { initialId?: string; orphan?: string } = {},
): { cli: string; log: () => string[][] } {
  const { initialId = BUILT_ID, orphan = "" } = options;
  const dir = scratch("ork-fake-docker-");
  const log = path.join(dir, "calls.log");
  const built = path.join(dir, "built");
  const builtLabel = path.join(dir, "built-label");
  const imageId = path.join(dir, "image-id");
  writeFileSync(imageId, initialId);
  writeFileSync(builtLabel, localLabel);
  if (present) writeFileSync(built, "");
  const cli = path.join(dir, "docker");
  writeFileSync(
    cli,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  version) echo 29.8.0; exit 0 ;;
  build)
    : > '${builtLabel}'
    for arg do
      case "$arg" in
        ${WORKER_CONTEXT_LABEL}=*) printf '%s' "\${arg#*=}" > '${builtLabel}' ;;
      esac
    done
    echo '${BUILT_ID}' > '${imageId}'
    touch '${built}'; echo '${BUILT_ID}'; exit 0 ;;
  image)
    test -f '${built}' || exit 1
    case "$*" in
      *Labels*) cat '${builtLabel}'; echo ;;
      *) cat '${imageId}' ;;
    esac
    exit 0 ;;
  ps) echo '${orphan}'; exit 0 ;;
  rm) exit 0 ;;
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
    const contextDigest = await workerContextDigest(context);
    const builds = docker.log().filter((args) => args[0] === "build");
    expect(builds).toEqual([
      [
        "build",
        "--quiet",
        "--pull=false",
        "--label",
        "orkestrator.artifact-preview-worker=1",
        "--label",
        `orkestrator.artifact-preview-worker.context=${contextDigest}`,
        "--tag",
        DEFAULT_PREVIEW_WORKER_IMAGE,
        context,
      ],
    ]);
    expect(JSON.parse(readFileSync(localWorkerPinFile(dataDir), "utf8"))).toEqual({
      tag: DEFAULT_PREVIEW_WORKER_IMAGE,
      id: BUILT_ID,
      contextDigest,
    });
    expect(runtime.workerPreparation()).toMatchObject({ state: "ready", image: BUILT_ID });
  });

  test("an explicit process configuration is prepared but not switched", async () => {
    const docker = fakeDocker();
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: scratch("ork-runtime-process-"),
      env: {
        ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: docker.cli,
        ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION: "process",
      },
      workerBuildContext: { context: buildContext(), stageScript: null },
      imagePinFile: null,
    });
    cleanups.push(() => runtime.close());
    const before = runtime.runner;
    const result = await runtime.prepareWorker();
    expect(result).toMatchObject({
      state: "ready",
      method: "build",
      image: BUILT_ID,
      isolation: "process",
      interactiveIsolation: "unavailable",
    });
    expect(runtime.runner).toBe(before);
    expect(docker.log().filter((args) => args[0] === "build")).toHaveLength(1);
  });

  for (const isolation of ["auto", "container"] as const) {
    test(`a source checkout stages, builds and reuses the prepared worker after restart (${isolation})`, async () => {
      const docker = fakeDocker();
      const stage = stageScript();
      const options = {
        dataDir: scratch("ork-source-restart-"),
        env: {
          ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: docker.cli,
          ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION: isolation,
        },
        workerBuildContext: { context: null, stageScript: stage.script },
      };
      const first = await createTranscriptArtifactRuntime(options);
      cleanups.push(() => first.close());
      expect(await first.prepareWorker()).toMatchObject({
        state: "ready",
        method: "build",
        image: BUILT_ID,
      });
      // The staged context is removed once the build has read it.
      expect(existsSync(stage.target())).toBe(false);
      await first.close();
      const restarted = await createTranscriptArtifactRuntime(options);
      cleanups.push(() => restarted.close());
      expect(restarted.config).toMatchObject({
        isolation: "container",
        workerImage: { reference: BUILT_ID, pinned: true },
      });
      expect(docker.log().filter((args) => args[0] === "build")).toHaveLength(1);
      expect(docker.log().some((args) => args[0] === "pull")).toBe(false);
    });
  }

  test("without Docker or a build context, preparation is unavailable and says why", async () => {
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: scratch("ork-runtime-nodocker-"),
      env: { ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: "/nonexistent/docker-cli" },
      workerBuildContext: { context: buildContext(), stageScript: null },
    });
    cleanups.push(() => runtime.close());
    expect(runtime.workerPreparation()).toMatchObject({ available: false });
    expect(runtime.workerPreparation().reason).toContain("Docker");
    expect(await runtime.prepareWorker()).toMatchObject({ state: "failed", isolation: "process" });

    const noContext = await createTranscriptArtifactRuntime({
      dataDir: scratch("ork-runtime-nocontext-"),
      env: { ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: fakeDocker().cli },
      workerBuildContext: { context: null, stageScript: null },
    });
    cleanups.push(() => noContext.close());
    expect(noContext.workerPreparation()).toMatchObject({ available: false });
    expect(noContext.workerPreparation().reason).toContain("build context");
  });
});

describe("a locally prepared worker after an upgrade", () => {
  const OTHER_CONTEXT = `sha256:${"9".repeat(64)}`;

  /** The data directory pin a preparation by an earlier version left behind. */
  function preparedEarlier(contextDigest?: string, id = BUILT_ID): string {
    const dataDir = scratch("ork-prepared-earlier-");
    const pin = localWorkerPinFile(dataDir);
    mkdirSync(path.dirname(pin), { recursive: true });
    writeFileSync(
      pin,
      JSON.stringify({
        tag: DEFAULT_PREVIEW_WORKER_IMAGE,
        id,
        ...(contextDigest ? { contextDigest } : {}),
      }),
    );
    return dataDir;
  }

  function capture(): { logger: { info(): void; warn(message: string): void }; warns: string[] } {
    const warns: string[] = [];
    return { logger: { info: () => undefined, warn: (message) => warns.push(message) }, warns };
  }

  for (const [name, previous] of [
    ["another context", OTHER_CONTEXT],
    ["no context label", undefined],
  ] as const) {
    test(`auto falls back to process isolation and offers preparation again (${name})`, async () => {
      const context = buildContext();
      const contextDigest = await workerContextDigest(context);
      const orphan = "a".repeat(64);
      const docker = fakeDocker(true, previous ?? "", { initialId: OLD_ID, orphan });
      const { logger, warns } = capture();
      const options = {
        dataDir: preparedEarlier(previous, OLD_ID),
        env: { ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: docker.cli },
        workerBuildContext: { context, stageScript: null },
        logger,
      };
      const upgraded = await createTranscriptArtifactRuntime(options);
      cleanups.push(() => upgraded.close());
      expect(upgraded.config).toMatchObject({
        isolation: "process",
        isolationSelection: "auto",
        interactiveIsolation: "unavailable",
        workerImage: null,
      });
      expect(upgraded.workerPreparation()).toEqual({
        available: true,
        state: "idle",
        method: null,
        outdated: true,
      });
      expect(warns.join("\n")).toContain("prepared before an upgrade");
      const recovery = docker.log().filter((args) => args[0] === "ps" || args[0] === "rm");
      expect(recovery).toEqual([
        [
          "ps",
          "-aq",
          "--filter",
          `label=${PREVIEW_CONTAINER_LABEL}=1`,
          "--filter",
          `label=${PREVIEW_CONTAINER_OWNER_LABEL}=${previewContainerOwner(options.dataDir)}`,
        ],
        ["rm", "-f", orphan],
      ]);

      // The pinned id's own label was read, not the tag's.
      expect(docker.log().map((args) => args.join(" "))).toContain(
        `image inspect --format {{index .Config.Labels "${WORKER_CONTEXT_LABEL}"}} ${OLD_ID}`,
      );

      expect(await upgraded.prepareWorker()).toMatchObject({
        state: "ready",
        method: "build",
        image: BUILT_ID,
        isolation: "container",
        interactiveIsolation: "container",
      });
      expect(upgraded.config.workerImage).toEqual({ reference: BUILT_ID, pinned: true });
      expect(upgraded.runner.status().workerImage).toEqual({ reference: BUILT_ID, pinned: true });
      expect(upgraded.workerPreparation().outdated).toBeUndefined();
      expect(JSON.parse(readFileSync(localWorkerPinFile(options.dataDir), "utf8"))).toEqual({
        tag: DEFAULT_PREVIEW_WORKER_IMAGE,
        id: BUILT_ID,
        contextDigest,
      });
      await upgraded.close();

      // The next start runs the re-prepared worker straight away.
      const restarted = await createTranscriptArtifactRuntime(options);
      cleanups.push(() => restarted.close());
      expect(restarted.config).toMatchObject({
        isolation: "container",
        workerImage: { reference: BUILT_ID, pinned: true },
      });
      expect(restarted.runner.status().workerImage).toEqual({ reference: BUILT_ID, pinned: true });
      expect(restarted.workerPreparation().outdated).toBeUndefined();
    });
  }

  test("an explicit container setting keeps running an outdated worker and says so", async () => {
    const { logger, warns } = capture();
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: preparedEarlier(OTHER_CONTEXT),
      env: {
        ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: fakeDocker(true, OTHER_CONTEXT).cli,
        ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION: "container",
      },
      workerBuildContext: { context: buildContext(), stageScript: null },
      logger,
    });
    cleanups.push(() => runtime.close());
    expect(runtime.config).toMatchObject({
      isolation: "container",
      isolationSelection: "configured",
      workerImage: { reference: BUILT_ID, pinned: true },
    });
    expect(runtime.workerPreparation()).toMatchObject({ available: true, outdated: true });
    expect(warns.join("\n")).toContain("keeps running it until it is prepared again");
  });

  test("an image Docker cannot inspect is missing, not outdated", async () => {
    const { logger, warns } = capture();
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: preparedEarlier(OTHER_CONTEXT),
      env: {
        ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: fakeDocker().cli,
        ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION: "container",
      },
      workerBuildContext: { context: buildContext(), stageScript: null },
      logger,
    });
    cleanups.push(() => runtime.close());
    expect(runtime.config.workerImage).toEqual({
      reference: DEFAULT_PREVIEW_WORKER_IMAGE,
      pinned: false,
    });
    expect(runtime.workerPreparation().outdated).toBeUndefined();
    expect(warns.join("\n")).not.toContain("prepared again");
  });

  test("an explicit worker image is never checked against the shipped context", async () => {
    const docker = fakeDocker(true, OTHER_CONTEXT);
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: scratch("ork-explicit-image-"),
      env: {
        ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: docker.cli,
        ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE: "example/worker:2",
      },
      workerBuildContext: { context: buildContext(), stageScript: null },
      imagePinFile: null,
    });
    cleanups.push(() => runtime.close());
    expect(runtime.config).toMatchObject({
      isolation: "container",
      workerImage: { reference: "example/worker:2", pinned: false },
    });
    expect(runtime.workerPreparation().outdated).toBeUndefined();
    expect(docker.log().some((args) => args.join(" ").includes("Labels"))).toBe(false);
  });

  test("a source checkout ships no context, so its prepared worker is used without staging", async () => {
    const docker = fakeDocker(true);
    const stage = stageScript();
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: preparedEarlier(),
      env: { ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: docker.cli },
      workerBuildContext: { context: null, stageScript: stage.script },
    });
    cleanups.push(() => runtime.close());
    expect(runtime.config).toMatchObject({
      isolation: "container",
      workerImage: { reference: BUILT_ID, pinned: true },
    });
    expect(runtime.workerPreparation().outdated).toBeUndefined();
    expect(() => stage.target()).toThrow();
    expect(docker.log().some((args) => args.join(" ").includes("Labels"))).toBe(false);
  });

  test("a shipped context that cannot be hashed proves nothing stale and is built unlabelled", async () => {
    const context = buildContext();
    symlinkSync("Dockerfile", path.join(context, "linked"));
    await expect(workerContextDigest(context)).rejects.toThrow();
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: preparedEarlier(OTHER_CONTEXT),
      env: { ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: fakeDocker(true, OTHER_CONTEXT).cli },
      workerBuildContext: { context, stageScript: null },
    });
    cleanups.push(() => runtime.close());
    expect(runtime.config.workerImage).toEqual({ reference: BUILT_ID, pinned: true });
    expect(runtime.workerPreparation().outdated).toBeUndefined();

    const docker = fakeDocker();
    const dataDir = scratch("ork-unhashable-prepare-");
    expect(
      await prepareWorkerImage({
        docker: docker.cli,
        tag: DEFAULT_PREVIEW_WORKER_IMAGE,
        dataDir,
        buildContext: { context, stageScript: null },
      }),
    ).toMatchObject({ ok: true, method: "build", reference: BUILT_ID });
    expect(
      docker
        .log()
        .find((args) => args[0] === "build")
        ?.join(" "),
    ).not.toContain(WORKER_CONTEXT_LABEL);
    expect(JSON.parse(readFileSync(localWorkerPinFile(dataDir), "utf8"))).toEqual({
      tag: DEFAULT_PREVIEW_WORKER_IMAGE,
      id: BUILT_ID,
    });
  });
});
