/**
 * The build-context digest a published preview worker image is bound to:
 * stable for the same bytes, sensitive to any file or path change, blind to
 * the seccomp profile only, and independent of where staging runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  WORKER_CONTEXT_DIGEST,
  WORKER_CONTEXT_LABEL,
  workerContextDigest,
} from "./preview-worker-context-digest.js";

import { prepareWorkerImage } from "./preview-worker-prepare.js";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ork-context-digest-"));
  cleanups.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

const BASE = {
  Dockerfile: "FROM scratch\n",
  "preview-worker.mjs": "export {};\n",
  "licenses/d3@7.9.0/LICENSE": "ISC\n",
};

describe("worker context digest", () => {
  test("the same bytes give the same digest whatever the creation order", async () => {
    const first = await workerContextDigest(context(BASE));
    const reversed = Object.fromEntries(Object.entries(BASE).reverse());
    expect(await workerContextDigest(context(reversed))).toBe(first);
    expect(first).toMatch(WORKER_CONTEXT_DIGEST);
  });

  test("any content, path or framing change changes the digest", async () => {
    const base = await workerContextDigest(context(BASE));
    const variants: Record<string, string>[] = [
      { ...BASE, "preview-worker.mjs": "export {}; \n" },
      { ...BASE, "extra.js": "" },
      {
        Dockerfile: BASE.Dockerfile,
        "preview-worker.mjs": BASE["preview-worker.mjs"],
        "licenses/d3@7.9.1/LICENSE": "ISC\n",
      },
      // Bytes moved across a file boundary must not collide.
      { ...BASE, Dockerfile: "FROM scratch\nexport {};\n", "preview-worker.mjs": "" },
    ];
    for (const changed of variants)
      expect(await workerContextDigest(context(changed))).not.toBe(base);
  });

  test("only the top-level seccomp profile is excluded", async () => {
    const base = await workerContextDigest(context(BASE));
    expect(await workerContextDigest(context({ ...BASE, "seccomp_profile.json": "{}" }))).toBe(
      base,
    );
    expect(
      await workerContextDigest(context({ ...BASE, "licenses/seccomp_profile.json": "{}" })),
    ).not.toBe(base);
  });

  test("a symlink in the context is refused", async () => {
    const dir = context(BASE);
    symlinkSync(path.join(dir, "Dockerfile"), path.join(dir, "linked"));
    await expect(workerContextDigest(dir)).rejects.toThrow("unexpected entry");
  });

  test("the publish workflow labels images with the label preparation checks", async () => {
    const root = path.resolve(import.meta.dir, "../../../../..");
    const workflow = Bun.YAML.parse(
      await Bun.file(path.join(root, ".github/workflows/publish-preview-worker.yml")).text(),
    ) as { env: Record<string, string> };
    expect(workflow.env.CONTEXT_LABEL).toBe(WORKER_CONTEXT_LABEL);
    expect(
      await Bun.file(path.join(root, "docker/artifact-preview-worker/publish.sh")).text(),
    ).toContain(`--label "${WORKER_CONTEXT_LABEL}=$context_digest"`);
  });

  test("staging gives the same context from any working directory", async () => {
    const root = path.resolve(import.meta.dir, "../../../../..");
    const script = path.join(root, "docker/artifact-preview-worker/stage-context.ts");
    const scratch = mkdtempSync(path.join(tmpdir(), "ork-context-stage-"));
    cleanups.push(scratch);
    const digests: string[] = [];
    for (const [name, cwd] of [
      ["root", root],
      ["backend", path.join(root, "apps/backend")],
      ["elsewhere", scratch],
    ] as const) {
      const target = path.join(scratch, name);
      const staged = Bun.spawnSync([process.execPath, script, target], {
        cwd,
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(staged.exitCode, staged.stderr.toString()).toBe(0);
      digests.push(await workerContextDigest(target));
    }
    expect(new Set(digests).size).toBe(1);
    // Exercise staging and published-context comparison as one preparation flow,
    // using the same real script release builds and CI run.
    const reference = `ghcr.io/example/worker@sha256:${"a".repeat(64)}`;
    const calls: string[][] = [];
    const prepared = await prepareWorkerImage({
      docker: "docker",
      tag: "worker:local",
      dataDir: scratch,
      published: {
        reference,
        repository: "ghcr.io/example/worker",
        digest: `sha256:${"a".repeat(64)}`,
        contextDigest: digests[0]!,
      },
      buildContext: { context: null, stageScript: script },
      runDocker: async (_docker, args) => {
        calls.push(args);
        return { code: 0, stdout: args[0] === "image" ? digests[0]! : "", stderr: "" };
      },
    });
    expect(prepared).toEqual({ ok: true, method: "pull", reference, pinned: true });
    expect(calls.map((args) => args[0])).toEqual(["version", "pull", "image"]);
  }, 60_000);
});

// On macOS this compares release-host staging with Linux using the pinned Bun.
// The publish workflow additionally compares independent macOS/ARM64 CI installs.
test.skipIf(process.env.ORKESTRATOR_TEST_CROSS_HOST_WORKER !== "1")(
  "native and Linux staging produce identical bytes",
  async () => {
    const root = path.resolve(import.meta.dir, "../../../../..");
    const scratch = mkdtempSync(path.join(tmpdir(), "ork-cross-host-context-"));
    cleanups.push(scratch);
    const native = path.join(scratch, "native");
    const linux = path.join(scratch, "linux");
    mkdirSync(linux);
    const staged = Bun.spawnSync(
      [
        process.execPath,
        path.join(root, "docker/artifact-preview-worker/stage-context.ts"),
        native,
      ],
      { stdout: "ignore", stderr: "pipe", timeout: 60_000 },
    );
    expect(staged.exitCode, staged.stderr.toString()).toBe(0);
    const { packageManager } = JSON.parse(
      await Bun.file(path.join(root, "package.json")).text(),
    ) as { packageManager: string };
    const container = Bun.spawnSync(
      [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=bind,source=${root},target=/source,readonly`,
        "--mount",
        `type=bind,source=${linux},target=/context`,
        "--workdir",
        "/source",
        "--entrypoint",
        "bun",
        `oven/bun:${packageManager.split("@")[1]}`,
        "/source/docker/artifact-preview-worker/stage-context.ts",
        "/context",
      ],
      { stdout: "ignore", stderr: "pipe", timeout: 60_000 },
    );
    expect(container.exitCode, container.stderr.toString()).toBe(0);
    expect(await workerContextDigest(linux)).toBe(await workerContextDigest(native));
  },
  120_000,
);
