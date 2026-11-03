/**
 * Process checks on installed executables: the `--version` probe and macOS
 * code-signature verification and repair. Each spawn is bounded by a timeout.
 */
import type { spawn } from "node:child_process";
import type { ToolchainArtifact } from "./manifest.js";

export async function probeExecutable(
  executablePath: string,
  artifact: ToolchainArtifact,
  timeoutMs: number,
  spawnProcess: typeof spawn,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(executablePath, ["--version"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${artifact.name} version check timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `${artifact.name} could not execute from the Orkestrator toolchain cache: ${error.message}`,
        ),
      );
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString("utf8");
      if (code !== 0) {
        reject(
          new Error(
            `${artifact.name} version check failed (code ${code ?? "unknown"}, signal ${signal ?? "none"})`,
          ),
        );
      } else if (!output.includes(artifact.version)) {
        reject(
          new Error(
            `${artifact.name} reported an unexpected version: ${output.trim() || "no output"}`,
          ),
        );
      } else {
        resolve();
      }
    });
  });
}

export async function verifyMacCodeSignature(
  executablePath: string,
  label: string,
  timeoutMs: number,
  spawnProcess: typeof spawn,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--verbose=2", executablePath],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${label} code-signature check timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(errors).toString("utf8").trim();
      reject(
        new Error(
          `${label} has an invalid macOS code signature (code ${code ?? "unknown"}, signal ${signal ?? "none"})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  });
}

async function runCodesign(
  args: string[],
  failureMessage: string,
  timeoutMs: number,
  spawnProcess: typeof spawn,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnProcess("/usr/bin/codesign", args, { stdio: ["ignore", "ignore", "pipe"] });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${failureMessage} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(errors).toString("utf8").trim();
      reject(
        new Error(
          `${failureMessage} (code ${code ?? "unknown"}, signal ${signal ?? "none"})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  });
}

export async function repairInvalidMacSignature(
  executablePath: string,
  artifact: ToolchainArtifact,
  timeoutMs: number,
  spawnProcess: typeof spawn,
): Promise<void> {
  await runCodesign(
    ["--remove-signature", executablePath],
    `${artifact.name} invalid signature could not be removed`,
    timeoutMs,
    spawnProcess,
  ).catch((error: unknown) => {
    // codesign exits non-zero when no removable signature exists. The following
    // forced signature is still authoritative, so only retain unexpected I/O errors.
    if (error instanceof Error && /code [1-9]/.test(error.message)) return;
    throw error;
  });
  await runCodesign(
    ["--sign", "-", "--force", executablePath],
    `${artifact.name} could not be ad-hoc signed after source verification`,
    timeoutMs,
    spawnProcess,
  );
}
