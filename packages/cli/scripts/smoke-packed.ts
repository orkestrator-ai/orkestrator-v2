import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const manifest = await Bun.file(path.join(packageRoot, "package.json")).json() as {
  version?: string;
};
if (typeof manifest.version !== "string") {
  throw new Error("CLI package version is missing");
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} exited with ${exitCode}`);
  }
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-packed-smoke-"));
try {
  await run([
    process.execPath,
    "pm",
    "pack",
    "--cwd",
    packageRoot,
    "--destination",
    temporaryRoot,
  ], packageRoot);
  await run([process.execPath, "init", "-y"], temporaryRoot);
  await run([
    process.execPath,
    "add",
    path.join(temporaryRoot, `orkestrator-${manifest.version}.tgz`),
  ], temporaryRoot);

  const dataDir = path.join(temporaryRoot, "data");
  const executable = path.join(temporaryRoot, "node_modules", ".bin", "orkestrator");
  const backend = Bun.spawn([
    executable,
    "--host", "127.0.0.1",
    "--port", "0",
    "--allow-non-tailscale-bind",
    "--data-dir", dataDir,
  ], {
    cwd: temporaryRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const timeout = setTimeout(() => backend.kill("SIGTERM"), 10_000);
  const reader = backend.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let ready = false;
  while (!ready) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      try {
        if (JSON.parse(line).type === "orkestrator-backend-ready") ready = true;
      } catch {
        // Human-readable startup logs precede the readiness contract.
      }
    }
  }
  clearTimeout(timeout);
  reader.releaseLock();

  if (!ready) {
    const stderr = await new Response(backend.stderr).text();
    throw new Error(`Installed package did not become ready: ${stderr}`);
  }

  backend.kill("SIGTERM");
  const exitCode = await backend.exited;
  if (exitCode !== 0) {
    throw new Error(`Installed package exited with ${exitCode}`);
  }
  console.log("Installed tarball started and stopped cleanly");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
