import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function expectExactVersion(pkgJsonRel: string, depName: string): string {
  const pkg = JSON.parse(read(pkgJsonRel)) as {
    dependencies?: Record<string, string>;
  };
  const raw = pkg.dependencies?.[depName];
  if (!raw) {
    throw new Error(`Expected ${pkgJsonRel} to declare ${depName}`);
  }
  expect(raw).not.toMatch(/^[\^~]/);
  return raw;
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
  test("Claude: bundled binary and Docker CLI match", () => {
    const downloadScriptPin = getShellVar(
      "scripts/download-claude.sh",
      "CLAUDE_VERSION",
    );
    const dockerfilePin = getDockerfileArg("CLAUDE_CLI_VERSION");

    expect(dockerfilePin).toBe(downloadScriptPin);
  });

  test("Claude: agent SDK dependency is exact-pinned", () => {
    expectExactVersion(
      "bridges/claude-bridge/package.json",
      "@anthropic-ai/claude-agent-sdk",
    );
  });

  test("Codex: SDK pin, bundled binary, and Docker CLI all match", () => {
    const sdkPin = expectExactVersion(
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

  test("Codex: bundled binary download uses the Rust release artifact URL", () => {
    const script = read("scripts/download-codex.sh");

    expect(script).toContain(
      'CODEX_URL="https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${CODEX_FILENAME}.tar.gz"',
    );
    expect(script).toContain('CODEX_FILENAME="codex-${CODEX_TARGET}"');
  });

  test("OpenCode: SDK pin, bundled binary, and Docker CLI all match", () => {
    const sdkPin = expectExactVersion("package.json", "@opencode-ai/sdk");
    const downloadScriptPin = getShellVar(
      "scripts/download-opencode.sh",
      "OPENCODE_VERSION",
    );
    const dockerfilePin = getDockerfileArg("OPENCODE_CLI_VERSION");

    expect(downloadScriptPin).toBe(sdkPin);
    expect(dockerfilePin).toBe(sdkPin);
  });
});
