import { cp, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const output = path.join(packageRoot, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(packageRoot, "src/main.ts")],
  outdir: output,
  target: "bun",
  sourcemap: "external",
  external: ["node-pty"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

async function copyResolvedPackage(source: string, destination: string): Promise<void> {
  await cp(await realpath(source), destination, { recursive: true, dereference: true });
}

await copyResolvedPackage(
  path.join(repositoryRoot, "node_modules/node-pty"),
  path.join(output, "node_modules/node-pty"),
);

// Sharp is bundled, but selects its platform-native @img packages dynamically.
const sharpRoot = await realpath(path.join(repositoryRoot, "node_modules/sharp"));
await copyResolvedPackage(
  path.join(path.dirname(sharpRoot), "@img"),
  path.join(output, "node_modules/@img"),
);

for (const artifact of result.outputs) {
  console.log(`${path.relative(packageRoot, artifact.path)} ${artifact.size} bytes`);
}
