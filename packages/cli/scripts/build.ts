import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const outputRoot = path.join(packageRoot, "dist");
const resourcesRoot = path.join(packageRoot, "resources");

await Promise.all([
  rm(outputRoot, { recursive: true, force: true }),
  rm(resourcesRoot, { recursive: true, force: true }),
]);
await Promise.all([
  mkdir(outputRoot, { recursive: true }),
  mkdir(path.join(resourcesRoot, "claude-bridge", "dist"), { recursive: true }),
  mkdir(path.join(resourcesRoot, "codex-bridge", "dist"), { recursive: true }),
]);

const builds = await Promise.all([
  // The client bundle must stay independent of the backend: the launcher
  // imports it first to decide whether a service should start at all.
  Bun.build({
    entrypoints: [path.join(packageRoot, "src/client.ts")],
    outdir: outputRoot,
    target: "bun",
    format: "esm",
  }),
  // `serve --supervised`: kept separate from the backend so the supervisor
  // stays small and works against backends newer than itself.
  Bun.build({
    entrypoints: [path.join(packageRoot, "src/supervisor/main.ts")],
    outdir: outputRoot,
    naming: "supervisor.js",
    target: "bun",
    format: "esm",
  }),
  Bun.build({
    entrypoints: [path.join(repositoryRoot, "apps/backend/src/main.ts")],
    outdir: outputRoot,
    target: "bun",
    format: "esm",
    external: ["sharp", "playwright-core"],
  }),
  Bun.build({
    entrypoints: [path.join(repositoryRoot, "bridges/claude-bridge/src/index.ts")],
    outdir: path.join(resourcesRoot, "claude-bridge", "dist"),
    target: "node",
    format: "esm",
    external: ["@anthropic-ai/claude-agent-sdk"],
  }),
  Bun.build({
    entrypoints: [path.join(repositoryRoot, "bridges/codex-bridge/src/index.ts")],
    outdir: path.join(resourcesRoot, "codex-bridge", "dist"),
    target: "node",
    format: "esm",
  }),
]);

let failed = false;
for (const result of builds) {
  if (result.success) continue;
  failed = true;
  for (const log of result.logs) console.error(log);
}
if (failed) process.exit(1);

for (const result of builds) {
  for (const artifact of result.outputs) {
    console.log(`${path.relative(packageRoot, artifact.path)} ${artifact.size} bytes`);
  }
}

// The backend diffs a target release's requirements against its own when
// offering an update, and a supervised install checks the package it staged
// against the manifest the user approved. Both read this copy. A subprocess
// keeps the generator's backend imports out of this package's typecheck.
const requirements = Bun.spawnSync(
  [
    process.execPath,
    path.join(repositoryRoot, "scripts/release-requirements.ts"),
    "generate",
    "--out",
    path.join(resourcesRoot, "release-requirements.json"),
  ],
  { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" },
);
if (requirements.exitCode !== 0) process.exit(requirements.exitCode ?? 1);
