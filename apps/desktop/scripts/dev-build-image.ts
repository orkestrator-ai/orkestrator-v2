import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { resolveRuntimeProfile } from "../electron/runtime-profile.js";
import { parseDevArguments } from "./dev/arguments.js";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");

try {
  const args = parseDevArguments(process.argv.slice(2));
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: args.profile,
    flavor: "agent-test",
  });
  const result = spawnSync(
    "docker",
    [
      "build",
      "-t",
      profile.dockerImage,
      "-f",
      path.join(repositoryRoot, "docker", "Dockerfile"),
      repositoryRoot,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`Built isolated development image ${profile.dockerImage}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
