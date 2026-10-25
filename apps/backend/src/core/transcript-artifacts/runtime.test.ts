import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DESKTOP_ARTIFACT_SHELL_ORIGIN } from "./interactive-csp.js";
import { PROCESS_INTERACTIVE_REFUSAL } from "./preview-runner.js";
import {
  DEFAULT_PREVIEW_WORKER_IMAGE,
  createTranscriptArtifactRuntime,
  resolveWorkerImage,
} from "./runtime.js";

/** Forces `auto` to fall back to process isolation regardless of the host. */
const NO_DOCKER = { ORKESTRATOR_ARTIFACT_PREVIEW_DOCKER: "/nonexistent/docker-cli" };
const IMAGE = process.env.ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE ?? DEFAULT_PREVIEW_WORKER_IMAGE;
const imageId = (() => {
  const inspect = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return inspect.status === 0 ? inspect.stdout.trim() : null;
})();
if (!imageId)
  console.warn(`[runtime.test] Docker cases skipped: Docker or image ${IMAGE} unavailable`);
const dockerTest = imageId ? test : test.skip;

describe("transcript artifact runtime factory", () => {
  test("builds runner, preparer and a separate content listener from configuration", async () => {
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: "/tmp/unused",
      env: {
        ...NO_DOCKER,
        ORKESTRATOR_ARTIFACT_FRAME_ANCESTORS: "http://127.0.0.1:34121, https://app.example.com",
      },
    });
    try {
      expect(runtime.config).toMatchObject({
        isolation: "process",
        isolationSelection: "auto",
        interactiveIsolation: "unavailable",
        workerImage: null,
      });
      expect(runtime.config.frameAncestors).toEqual([
        DESKTOP_ARTIFACT_SHELL_ORIGIN,
        "http://127.0.0.1:34121",
        "https://app.example.com",
      ]);
      // Application on 127.0.0.1 → content on a different loopback host name.
      expect(runtime.contentServer.origin()).toMatch(/^http:\/\/localhost:\d+$/);
      const prepared = await runtime.preparer.prepare({
        artifactId: "art_runtime001",
        revision: 1,
        html: "<p>x</p>",
        dependencyIds: [],
        assets: [],
      });
      expect(prepared.ok).toBe(true);
      if (prepared.ok)
        expect(prepared.prepared.contentSecurityPolicy).toContain(
          `frame-ancestors ${DESKTOP_ARTIFACT_SHELL_ORIGIN} http://127.0.0.1:34121 https://app.example.com`,
        );
      // Explicit ancestors are kept when the gateway reports its origins.
      runtime.setApplicationOrigins({ application: ["http://127.0.0.1:4100/"] });
      expect(runtime.config.frameAncestors).toEqual([
        DESKTOP_ARTIFACT_SHELL_ORIGIN,
        "http://127.0.0.1:34121",
        "https://app.example.com",
      ]);
    } finally {
      await runtime.close();
    }
    expect(runtime.contentServer.origin()).toBeNull();
  });

  test("default ancestors are the desktop shell plus the gateway's real origins, never loopback wildcards", async () => {
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: "/tmp/unused",
      env: { ...NO_DOCKER },
    });
    try {
      // Before the gateway binds only the desktop shell may frame documents.
      expect(runtime.config.frameAncestors).toEqual([DESKTOP_ARTIFACT_SHELL_ORIGIN]);
      const status = runtime.setApplicationOrigins({
        application: ["http://127.0.0.1:4100/", "https://host.tailnet.ts.net"],
        development: ["http://127.0.0.1:1420"],
      });
      expect(status.available).toBe(true);
      expect(runtime.config.frameAncestors).toEqual([
        DESKTOP_ARTIFACT_SHELL_ORIGIN,
        "http://127.0.0.1:4100",
        "https://host.tailnet.ts.net",
        "http://127.0.0.1:1420",
      ]);
      expect(runtime.config.frameAncestors.join(" ")).not.toContain("*");
      expect(runtime.config.contentOrigin).toMatch(/^http:\/\/localhost:\d+$/);
      // A localhost application origin moves the content host to 127.0.0.1.
      runtime.setApplicationOrigins({ application: ["http://localhost:4100"] });
      expect(runtime.config.contentOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(runtime.contentServer.origin()).toBe(runtime.config.contentOrigin);
    } finally {
      await runtime.close();
    }
  });

  test("a hosted content origin on the application's site is refused with a reason", async () => {
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: "/tmp/unused",
      env: { ...NO_DOCKER, ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN: "https://art.example.com" },
      applicationOrigins: ["https://app.example.org"],
    });
    try {
      expect(runtime.contentServer.origin()).toBe("https://art.example.com");
      const status = runtime.setApplicationOrigins({ application: ["https://ork.example.com"] });
      expect(status).toMatchObject({ available: false, origin: null });
      expect(status.reason).toContain("same site");
      expect(runtime.contentServer.origin()).toBeNull();
      expect(runtime.config.contentOrigin).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  test("process isolation refuses interactive previews unless explicitly allowed", async () => {
    const refused = await createTranscriptArtifactRuntime({
      dataDir: "/tmp/unused",
      env: { ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION: "process" },
    });
    const allowed = await createTranscriptArtifactRuntime({
      dataDir: "/tmp/unused",
      env: {
        ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION: "process",
        ORKESTRATOR_ARTIFACT_PREVIEW_ALLOW_PROCESS_INTERACTIVE: "1",
      },
    });
    try {
      expect(refused.config).toMatchObject({
        isolation: "process",
        isolationSelection: "configured",
        interactiveIsolation: "unavailable",
      });
      expect(refused.runner.status().interactiveIsolation).toBe("unavailable");
      expect(refused.runner.status().interactiveReason).toBe(PROCESS_INTERACTIVE_REFUSAL);
      expect(allowed.config.interactiveIsolation).toBe("process");
      expect(allowed.runner.status().interactiveIsolation).toBe("process");
    } finally {
      await Promise.all([refused.close(), allowed.close()]);
    }
  });

  test("disabled mode never starts work", async () => {
    const runtime = await createTranscriptArtifactRuntime({
      dataDir: "/tmp/unused",
      env: { ORKESTRATOR_ARTIFACT_PREVIEW_ISOLATION: "disabled" },
      applicationHost: "localhost",
    });
    try {
      expect(runtime.contentServer.origin()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(runtime.runner.status()).toMatchObject({ available: false, isolation: "unavailable" });
      await expect(
        runtime.runner.run(
          { kind: "mermaid", source: "flowchart TD\n A-->B", theme: "light" },
          { environmentId: "e", conversationKey: "c", operationId: "op_x" },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ error: { code: "renderer_unavailable" } });
    } finally {
      await runtime.close();
    }
  });

  test("rejects unsafe configuration before binding", async () => {
    await expect(
      createTranscriptArtifactRuntime({
        dataDir: "/tmp/unused",
        env: { ...NO_DOCKER, ORKESTRATOR_ARTIFACT_FRAME_ANCESTORS: "*" },
      }),
    ).rejects.toThrow();
    await expect(
      createTranscriptArtifactRuntime({
        dataDir: "/tmp/unused",
        env: { ...NO_DOCKER, ORKESTRATOR_ARTIFACT_CONTENT_ORIGIN: "https://x.example/sub/path" },
      }),
    ).rejects.toThrow();
  });

  test("worker image references: digests are pinned, tags fall back with a warning", async () => {
    const digest = `example/worker@sha256:${"b".repeat(64)}`;
    expect(await resolveWorkerImage(digest, "/nonexistent/docker", null)).toEqual({
      reference: digest,
      pinned: true,
    });
    const unpinned = await resolveWorkerImage("worker:1", "/nonexistent/docker", null);
    expect(unpinned).toMatchObject({ reference: "worker:1", pinned: false });
    expect(unpinned.warning).toContain("no digest pin");
    const dir = mkdtempSync(path.join(tmpdir(), "ork-image-pin-"));
    try {
      const pinFile = path.join(dir, "image-pin.json");
      writeFileSync(pinFile, JSON.stringify({ tag: "worker:1", id: `sha256:${"c".repeat(64)}` }));
      const missing = await resolveWorkerImage("worker:1", "/nonexistent/docker", pinFile);
      expect(missing).toMatchObject({ reference: "worker:1", pinned: false });
      expect(missing.warning).toContain("not present");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  dockerTest(
    "auto selects the container worker when Docker and the image are present, pinned by id",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "ork-image-pin-"));
      const pinFile = path.join(dir, "image-pin.json");
      writeFileSync(pinFile, JSON.stringify({ tag: IMAGE, id: imageId }));
      const runtime = await createTranscriptArtifactRuntime({
        dataDir: dir,
        env: process.env.ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE
          ? { ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE: IMAGE }
          : {},
        imagePinFile: pinFile,
      });
      try {
        expect(runtime.config).toMatchObject({
          isolation: "container",
          isolationSelection: "auto",
          interactiveIsolation: "container",
          workerImage: { reference: imageId, pinned: true },
        });
        expect(runtime.runner.status()).toMatchObject({
          isolation: "container",
          interactiveIsolation: "container",
          isolationSelection: "auto",
          workerImage: { reference: imageId, pinned: true },
        });
      } finally {
        await runtime.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

test("gateway wildcard and underscore hosts never become inferred frame ancestors", async () => {
  const runtime = await createTranscriptArtifactRuntime({
    dataDir: "/tmp/unused",
    env: { ...NO_DOCKER },
    applicationOrigins: [
      "https://*.example.com",
      "https://under_score.example.com",
      "https://valid.example.com",
    ],
  });
  try {
    expect(runtime.config.frameAncestors).toEqual([
      DESKTOP_ARTIFACT_SHELL_ORIGIN,
      "https://valid.example.com",
    ]);
    expect(() =>
      runtime.setApplicationOrigins({
        application: ["https://*.example.com", "https://under_score.example.com"],
      }),
    ).not.toThrow();
    expect(runtime.config.frameAncestors).toEqual([DESKTOP_ARTIFACT_SHELL_ORIGIN]);
  } finally {
    await runtime.close();
  }
});
