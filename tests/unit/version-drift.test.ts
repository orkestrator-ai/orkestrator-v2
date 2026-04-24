import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function stripRange(version: string): string {
  return version.replace(/^[\^~]/, "");
}

function getPkgDep(pkgJsonRel: string, depName: string): string {
  const pkg = JSON.parse(read(pkgJsonRel)) as {
    dependencies?: Record<string, string>;
  };
  const raw = pkg.dependencies?.[depName];
  if (!raw) {
    throw new Error(`Expected ${pkgJsonRel} to declare ${depName}`);
  }
  return stripRange(raw);
}

function getDockerfileArg(argName: string): string {
  const dockerfile = read("docker/Dockerfile");
  const match = dockerfile.match(new RegExp(`^ARG\\s+${argName}=(\\S+)`, "m"));
  if (!match) {
    throw new Error(`Expected ARG ${argName} in docker/Dockerfile`);
  }
  return match[1];
}

function getShellVar(scriptRel: string, varName: string): string {
  const script = read(scriptRel);
  const match = script.match(new RegExp(`^${varName}="([^"]+)"`, "m"));
  if (!match) {
    throw new Error(`Expected ${varName} in ${scriptRel}`);
  }
  return match[1];
}

describe("version drift between SDK pins and bundled/container CLIs", () => {
  test("Codex: SDK pin, bundled binary, and Docker CLI all match", () => {
    const sdkPin = getPkgDep(
      "bridges/codex-bridge/package.json",
      "@openai/codex-sdk",
    );
    const downloadScriptPin = getShellVar(
      "scripts/download-codex.sh",
      "CODEX_VERSION",
    );
    const dockerfilePin = getDockerfileArg("CODEX_CLI_VERSION");

    expect(downloadScriptPin).toBe(sdkPin);
    expect(dockerfilePin).toBe(sdkPin);
  });

  test("OpenCode: SDK pin, bundled binary, and Docker CLI all match", () => {
    const sdkPin = getPkgDep("package.json", "@opencode-ai/sdk");
    const downloadScriptPin = getShellVar(
      "scripts/download-opencode.sh",
      "OPENCODE_VERSION",
    );
    const dockerfilePin = getDockerfileArg("OPENCODE_CLI_VERSION");

    expect(downloadScriptPin).toBe(sdkPin);
    expect(dockerfilePin).toBe(sdkPin);
  });
});
