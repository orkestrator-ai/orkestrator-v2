/**
 * Install the pinned agent binaries for this host: `mise run toolchain:install`.
 *
 * This is `orkestrator toolchain install`, run from source so it needs no
 * built package. There is one implementation (`@orkestrator/toolchain/install`,
 * driven by `packages/cli/src/client/commands/toolchain.ts`); this file only
 * supplies the version and forwards the arguments, so the mise task and the
 * published CLI cannot drift apart.
 *
 *   mise run toolchain:install                       # what the data directory enables
 *   mise run toolchain:install --tool claude --tool codex
 *   mise run toolchain:install --dry-run
 *   mise run toolchain:install --data-dir /srv/orkestrator
 */
import path from "node:path";
import { runClientProcess } from "../packages/cli/src/client/main";

const manifest = (await Bun.file(
  path.join(import.meta.dir, "..", "packages", "cli", "package.json"),
).json()) as { version?: string };

process.exitCode = await runClientProcess(
  ["toolchain", "install", ...process.argv.slice(2)],
  manifest.version ?? "0.0.0",
);
