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

function getDockerfileBaseImageTag(): string {
  const dockerfile = read("docker/Dockerfile");
  const match = dockerfile.match(/^FROM\s+oven\/bun:(\S+)/m);
  if (!match) {
    throw new Error("Expected `FROM oven/bun:<tag>` in docker/Dockerfile");
  }
  return match[1];
}

describe("version drift between SDK pins and bundled/container CLIs", () => {
  test("Bun: host-bundled runtime matches the container base image", () => {
    // The bridges run on Bun both on the host (bundled binary) and inside the
    // container (oven/bun base). Pinning both to the same version keeps the two
    // bridge runtimes from drifting apart.
    const hostPin = getShellVar("scripts/download-bun.sh", "BUN_VERSION");
    const baseImageTag = getDockerfileBaseImageTag();

    // Base image tag is `<version>-debian`; compare the version segment.
    expect(baseImageTag).toBe(`${hostPin}-debian`);
  });

  test("Bun: host download script pins an exact version, not `latest`", () => {
    const script = read("scripts/download-bun.sh");
    expect(script).not.toContain("releases/latest");
    expect(getShellVar("scripts/download-bun.sh", "BUN_VERSION")).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });

  test("Claude bridge: musl variant is stripped from the vendored runtime tree, not top-level node_modules", () => {
    // The claude-bridge build vendors the SDK into dist/node_modules, which is the
    // tree the SDK actually resolves its native binary from at runtime. Stripping
    // musl from top-level node_modules (the historical location) is a no-op against
    // that runtime path. This guards against regressing to the ineffective form.
    // Verified in oven/bun:1.3.14-debian: the bridge boots and resolves the gnu binary.
    const dockerfile = read("docker/Dockerfile");
    expect(dockerfile).toContain(
      "rm -rf dist/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl",
    );
    expect(dockerfile).not.toContain(
      "rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl",
    );
  });


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

  test("Codex: Linux download target uses the musl triple, not gnu", () => {
    // The Codex Rust releases only publish Linux binaries under the musl
    // triple. Using the gnu triple makes the download 404 (curl -fsSL fails).
    const script = read("scripts/download-codex.sh");

    expect(script).toContain('CODEX_TARGET="${CODEX_ARCH}-unknown-linux-musl"');
    expect(script).not.toContain("unknown-linux-gnu");
  });

  test("Codex: download script maps darwin and both CPU arches", () => {
    const script = read("scripts/download-codex.sh");

    // Darwin target and the arch normalisation the target string depends on.
    expect(script).toContain('CODEX_TARGET="${CODEX_ARCH}-apple-darwin"');
    expect(script).toContain('CODEX_ARCH="x86_64"');
    expect(script).toContain('CODEX_ARCH="aarch64"');
  });

  test("OpenCode: SDK pin, bundled binary, and Docker CLI all match", () => {
    const sdkPin = expectExactVersion("apps/web/package.json", "@opencode-ai/sdk");
    const downloadScriptPin = getShellVar(
      "scripts/download-opencode.sh",
      "OPENCODE_VERSION",
    );
    const dockerfilePin = getDockerfileArg("OPENCODE_CLI_VERSION");

    expect(downloadScriptPin).toBe(sdkPin);
    expect(dockerfilePin).toBe(sdkPin);
  });
});
