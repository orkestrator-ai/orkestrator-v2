import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BRIDGE_RUNTIMES_DIRECTORY,
  BUNDLED_BRIDGES,
  ON_DEMAND_BRIDGES,
  RUNTIME_DESCRIPTOR,
  RUNTIME_SUBDIRECTORY,
} from "./bridges.js";

const packageRoot = path.resolve(import.meta.dir, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const outputRoot = path.join(packageRoot, "dist");
const resourcesRoot = path.join(packageRoot, "resources");

const bridgeOutput = (name: string) => path.join(resourcesRoot, name, "dist");

await Promise.all([
  rm(outputRoot, { recursive: true, force: true }),
  rm(resourcesRoot, { recursive: true, force: true }),
]);
await Promise.all([
  mkdir(outputRoot, { recursive: true }),
  ...[...BUNDLED_BRIDGES, ...ON_DEMAND_BRIDGES].map((bridge) =>
    mkdir(bridgeOutput(bridge.name), { recursive: true }),
  ),
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
  Bun.build({
    entrypoints: [path.join(repositoryRoot, "apps/backend/src/main.ts")],
    outdir: outputRoot,
    target: "bun",
    format: "esm",
    external: ["sharp", "playwright-core"],
  }),
  ...[...BUNDLED_BRIDGES, ...ON_DEMAND_BRIDGES].map((bridge) =>
    Bun.build({
      entrypoints: [path.join(repositoryRoot, "bridges", bridge.name, "src/index.ts")],
      outdir: bridgeOutput(bridge.name),
      target: "node",
      format: "esm",
      external: bridge.external,
    }),
  ),
]);

let failed = false;
for (const result of builds) {
  if (result.success) continue;
  failed = true;
  for (const log of result.logs) console.error(log);
}
if (failed) process.exit(1);

/**
 * Stage an on-demand bridge's install inputs beside its bundle: the committed
 * runtime manifest and lockfile, the repository patches the manifest names,
 * and a descriptor whose digest names the backend's install directory. The
 * digest covers the bundle too, so a rebuilt bridge never reuses an install
 * staged for different code.
 */
async function stageRuntime(name: string): Promise<string> {
  const source = path.join(packageRoot, BRIDGE_RUNTIMES_DIRECTORY, name);
  const destination = path.join(resourcesRoot, name, RUNTIME_SUBDIRECTORY);
  await mkdir(destination, { recursive: true });

  const manifestText = await readFile(path.join(source, "package.json"), "utf8");
  const lockfileText = await readFile(path.join(source, "bun.lock"), "utf8");
  await writeFile(path.join(destination, "package.json"), manifestText);
  await writeFile(path.join(destination, "bun.lock"), lockfileText);

  const hash = createHash("sha256").update(manifestText).update(lockfileText);
  const manifest = JSON.parse(manifestText) as { patchedDependencies?: Record<string, string> };
  for (const file of Object.values(manifest.patchedDependencies ?? {}).sort()) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(repositoryRoot, file), target);
    hash.update(await readFile(target));
  }
  hash.update(await readFile(path.join(bridgeOutput(name), "index.js")));

  const digest = hash.digest("hex").slice(0, 16);
  await writeFile(
    path.join(destination, RUNTIME_DESCRIPTOR),
    `${JSON.stringify({ bridge: name, digest }, null, 2)}\n`,
  );
  return path.join(destination, RUNTIME_DESCRIPTOR);
}

const descriptors = await Promise.all(ON_DEMAND_BRIDGES.map((bridge) => stageRuntime(bridge.name)));

for (const result of builds) {
  for (const artifact of result.outputs) {
    console.log(`${path.relative(packageRoot, artifact.path)} ${artifact.size} bytes`);
  }
}
for (const descriptor of descriptors) console.log(path.relative(packageRoot, descriptor));
