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
  Bun.build({
    entrypoints: [path.join(repositoryRoot, "apps/backend/src/main.ts")],
    outdir: outputRoot,
    target: "bun",
    format: "esm",
    external: ["sharp"],
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
