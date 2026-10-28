import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// macOS is where setsockopt on a reset TCP socket returns EINVAL. Windows
// explicitly ignores native TOS failures, and Linux has different semantics.
test.skipIf(process.platform !== "darwin")(
  "Electron's native reset-socket errno is guarded and fetch rejects without an uncaught exception",
  async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "orkestrator-socket-tos-"));
    try {
      const fixture = path.join(temporary, "runtime.mjs");
      const build = await Bun.build({
        entrypoints: [path.join(import.meta.dir, "fixtures/socket-tos-guard-runtime.ts")],
        target: "node",
        format: "esm",
        outdir: temporary,
        naming: "runtime.mjs",
      });
      expect(build.success).toBe(true);
      const run = (mode: string) =>
        spawnSync(path.join(import.meta.dir, "../node_modules/.bin/electron"), [fixture, mode], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 64 * 1024,
        });

      // Prove the same real race crashes the unguarded runtime. Merely checking
      // a rejected fetch could pass even if undici stopped calling the setter.
      const unguarded = run("unguarded");
      expect(unguarded.error).toBeUndefined();
      expect(unguarded.status).toBe(1);
      expect(unguarded.stderr).toContain("syscall: 'setTypeOfService'");
      expect(unguarded.stderr).toContain("code: 'EINVAL'");

      const guarded = run("guarded");
      expect(guarded.error).toBeUndefined();
      expect(guarded.stderr).toBe("");
      expect(guarded.status).toBe(0);
      expect(guarded.stdout).toBe("guarded reset fetch rejected normally\n");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  40_000,
);
