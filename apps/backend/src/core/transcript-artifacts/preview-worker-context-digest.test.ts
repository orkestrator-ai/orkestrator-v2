/**
 * The build-context digest a prepared preview worker image is labelled with:
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

describe("what the worker bundle holds", () => {
  // `rich-transcripts.md` promises that changing the transcript's presentation
  // runtime asks no install to rebuild its worker image. This is that promise.
  test("the transcript's presentation runtime is not in it, and the verifying runtime is", async () => {
    const build = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "preview-worker-entry.ts")],
      target: "node",
      format: "esm",
      external: ["playwright-core"],
    });
    expect(build.success).toBe(true);
    const bundle = await build.outputs[0]!.text();
    expect(bundle).toContain("installDesignRuntime");
    // The text Find searches before a document is shown is read at verification
    // with a copy of the frame's walk, not with the presentation runtime (5780).
    expect(bundle).toContain("staticHtmlDocumentText");
    for (const name of [
      "installStaticHtmlPresentationRuntime",
      "orkestrator-static-html",
      "static-html-presentation",
    ])
      expect(bundle).not.toContain(name);
  });
});

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
    // Exercise staging and labelling as one preparation flow, using the same
    // real script release builds and CI run.
    const id = `sha256:${"b".repeat(64)}`;
    const calls: string[][] = [];
    const prepared = await prepareWorkerImage({
      docker: "docker",
      tag: "worker:local",
      dataDir: scratch,
      buildContext: { context: null, stageScript: script },
      runDocker: async (_docker, args) => {
        calls.push(args);
        return { code: 0, stdout: args[0] === "image" ? id : "", stderr: "" };
      },
    });
    expect(prepared).toEqual({ ok: true, method: "build", reference: id, pinned: true });
    expect(calls.map((args) => args[0])).toEqual(["version", "build", "image"]);
    expect(calls[1]).toContain(`${WORKER_CONTEXT_LABEL}=${digests[0]}`);
  }, 60_000);
});

// On macOS this compares release-host staging with Linux using the pinned Bun.
// This Docker check is opt-in via ORKESTRATOR_TEST_CROSS_HOST_WORKER=1.
// CI separately compares independent Linux x64, Linux ARM64 and macOS installs.
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
