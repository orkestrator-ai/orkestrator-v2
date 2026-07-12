import { cp, mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const destination = path.join(packageRoot, "dist", "node_modules", "@anthropic-ai");
const sdkLink = path.join(packageRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk");
const sdkRoot = await realpath(sdkLink);

await rm(path.join(packageRoot, "dist", "node_modules"), { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(sdkRoot, path.join(destination, "claude-agent-sdk"), { recursive: true, dereference: true });

const optionalRoot = path.dirname(sdkRoot);
for (const name of await readdir(optionalRoot)) {
  if (!name.startsWith("claude-agent-sdk-")) continue;
  await cp(await realpath(path.join(optionalRoot, name)), path.join(destination, name), {
    recursive: true,
    dereference: true,
  });
}
