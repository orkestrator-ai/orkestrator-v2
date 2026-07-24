import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_RELEASE_BASE,
  OPENCODE_RELEASE_BASE,
  PINNED_TOOLCHAIN_ARTIFACTS,
  PINNED_TOOLCHAIN_VERSIONS,
  pinnedToolchainArtifacts,
} from "../../apps/desktop/electron/toolchain-manifest";

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

describe("version drift between SDK pins and managed/container CLIs", () => {
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


  test("Claude: managed binary, download script, and Docker CLI match", () => {
    const downloadScriptPin = getShellVar(
      "scripts/download-claude.sh",
      "CLAUDE_VERSION",
    );
    const dockerfilePin = getDockerfileArg("CLAUDE_CLI_VERSION");

    expect(dockerfilePin).toBe(downloadScriptPin);
    expect(PINNED_TOOLCHAIN_VERSIONS.claude).toBe(downloadScriptPin);
  });

  test("Claude: agent SDK dependency is exact-pinned", () => {
    expectExactVersion(
      "bridges/claude-bridge/package.json",
      "@anthropic-ai/claude-agent-sdk",
    );
  });

  test("Codex: SDK pin, managed binary, download script, and Docker CLI all match", () => {
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
    expect(PINNED_TOOLCHAIN_VERSIONS.codex).toBe(sdkPin);
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

  test("OpenCode: SDK pin, managed binary, download script, and Docker CLI all match", () => {
    const sdkPin = expectExactVersion("apps/web/package.json", "@opencode-ai/sdk");
    const downloadScriptPin = getShellVar(
      "scripts/download-opencode.sh",
      "OPENCODE_VERSION",
    );
    const dockerfilePin = getDockerfileArg("OPENCODE_CLI_VERSION");

    expect(downloadScriptPin).toBe(sdkPin);
    expect(dockerfilePin).toBe(sdkPin);
    expect(PINNED_TOOLCHAIN_VERSIONS.opencode).toBe(sdkPin);
  });

  test("OpenCode: bundled binary download uses the same release base as the managed manifest", () => {
    // The managed manifest and the bundling script must resolve to the same
    // GitHub org. OpenCode moved from `sst` to `anomalyco`; without this the two
    // could be updated independently and silently ship binaries from different
    // repositories while every other test stayed green.
    const script = read("scripts/download-opencode.sh");

    expect(script).toContain(
      'OPENCODE_URL="https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${OPENCODE_ARCHIVE}"',
    );
    expect(OPENCODE_RELEASE_BASE).toBe(
      `https://github.com/anomalyco/opencode/releases/download/v${PINNED_TOOLCHAIN_VERSIONS.opencode}`,
    );
    for (const artifact of PINNED_TOOLCHAIN_ARTIFACTS.filter((entry) => entry.name === "opencode")) {
      expect(artifact.archive.url.startsWith(`${OPENCODE_RELEASE_BASE}/`)).toBe(true);
    }
  });

  test("OpenCode: download script names macOS zips and Linux tarballs like the release assets", () => {
    const script = read("scripts/download-opencode.sh");

    expect(script).toContain('OPENCODE_FILENAME="opencode-${PLATFORM}-${OPENCODE_ARCH}"');
    expect(script).toContain('OPENCODE_ARCHIVE="$OPENCODE_FILENAME.tar.gz"');
    expect(script).toContain('OPENCODE_ARCHIVE="$OPENCODE_FILENAME.zip"');

    for (const artifact of PINNED_TOOLCHAIN_ARTIFACTS.filter((entry) => entry.name === "opencode")) {
      const expectedExtension = artifact.platform === "linux" ? ".tar.gz" : ".zip";
      expect(artifact.archive.url.endsWith(
        `opencode-${artifact.platform}-${artifact.architecture}${expectedExtension}`,
      )).toBe(true);
      expect(artifact.archive.format).toBe(artifact.platform === "linux" ? "tar.gz" : "zip");
    }
  });

  test("Codex: managed manifest and download script share one release base", () => {
    expect(CODEX_RELEASE_BASE).toBe(
      `https://github.com/openai/codex/releases/download/rust-v${PINNED_TOOLCHAIN_VERSIONS.codex}`,
    );
    for (const artifact of PINNED_TOOLCHAIN_ARTIFACTS.filter((entry) => entry.name === "codex")) {
      expect(artifact.archive.url.startsWith(`${CODEX_RELEASE_BASE}/`)).toBe(true);
    }
  });

  test("Claude: managed manifest and download script build the same npm tarball URL", () => {
    const script = read("scripts/download-claude.sh");

    expect(script).toContain('PACKAGE_NAME="claude-code-${PLATFORM}-${CLAUDE_ARCH}"');
    expect(script).toContain(
      'CLAUDE_URL="https://registry.npmjs.org/@anthropic-ai/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${CLAUDE_VERSION}.tgz"',
    );
    expect(script).toContain('cp "$TEMP_DIR/package/claude" "$BINARIES_DIR/claude"');

    for (const artifact of PINNED_TOOLCHAIN_ARTIFACTS.filter((entry) => entry.name === "claude")) {
      const pkg = `claude-code-${artifact.platform}-${artifact.architecture}`;
      expect(artifact.archive.url).toBe(
        `https://registry.npmjs.org/@anthropic-ai/${pkg}/-/${pkg}-${PINNED_TOOLCHAIN_VERSIONS.claude}.tgz`,
      );
      expect(artifact.archive.entryPath).toBe("package/claude");
    }
  });

  test("every managed artifact URL carries its own pinned version", () => {
    // Guards the failure mode where PINNED_TOOLCHAIN_VERSIONS, the Dockerfile and
    // the download scripts are all bumped but a URL keeps a stale version: the
    // stale binary's size and digest would still agree with each other, so the
    // installer would happily verify and install the wrong release.
    for (const artifact of PINNED_TOOLCHAIN_ARTIFACTS) {
      expect(artifact.version).toBe(PINNED_TOOLCHAIN_VERSIONS[artifact.name]);
      expect(artifact.archive.url).toContain(artifact.version);
    }
  });

  test("every managed artifact allowlists the host it actually downloads from", () => {
    for (const artifact of PINNED_TOOLCHAIN_ARTIFACTS) {
      const { hostname, protocol } = new URL(artifact.archive.url);
      expect(protocol).toBe("https:");
      expect(artifact.archive.allowedHosts).toContain(hostname);
    }
  });

  test("only artifacts that are re-signed locally omit pinned installed digests", () => {
    // `repairInvalidMacSignature` re-signs the binary with the *local* codesign,
    // whose output is not reproducible across machines. Pinning a post-repair
    // digest in the manifest makes installation fail on any machine that
    // produces different bytes, which blocks app startup entirely. Those
    // artifacts must rely on the install record written at install time instead.
    for (const artifact of PINNED_TOOLCHAIN_ARTIFACTS) {
      const { repairInvalidMacSignature, installedSha256, installedSize } = artifact.executable;
      if (repairInvalidMacSignature) {
        expect(artifact.platform).toBe("darwin");
        expect(installedSha256).toBeUndefined();
        expect(installedSize).toBeUndefined();
      } else {
        expect(installedSha256 === undefined).toBe(installedSize === undefined);
      }
    }

    // OpenCode ships unsigned macOS binaries on both architectures, so both must
    // opt into repair or installation fails on that architecture.
    const darwinOpenCode = PINNED_TOOLCHAIN_ARTIFACTS
      .filter((artifact) => artifact.name === "opencode" && artifact.platform === "darwin");
    expect(darwinOpenCode).toHaveLength(2);
    for (const artifact of darwinOpenCode) {
      expect(artifact.executable.repairInvalidMacSignature).toBe(true);
    }
  });

  test("Docker: the pinned CLI versions are what the image actually installs", () => {
    const dockerfile = read("docker/Dockerfile");

    expect(dockerfile).toContain('npm install -g "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}"');
    expect(dockerfile).toContain('npm install -g "@openai/codex@${CODEX_CLI_VERSION}"');
    expect(dockerfile).toContain('--version "$OPENCODE_CLI_VERSION"');
    // The three CLI paths the backend resolves at runtime.
    expect(dockerfile).toContain("ENV CLAUDE_CLI_PATH=/usr/local/share/npm-global/bin/claude");
    expect(dockerfile).toContain("ENV CODEX_CLI_PATH=/usr/local/share/npm-global/bin/codex");
    expect(dockerfile).toContain("ENV OPENCODE_CLI_PATH=/home/node/.opencode/bin/opencode");
    expect(dockerfile).toContain("/home/node/.opencode/bin");
  });

  test("managed manifest covers every supported platform and architecture with immutable checksums", () => {
    const expected = new Set<string>();
    for (const platform of ["darwin", "linux"]) {
      for (const architecture of ["arm64", "x64"]) {
        for (const name of ["claude", "codex", "opencode"]) {
          expected.add(`${name}:${platform}:${architecture}`);
        }
      }
    }

    const actual = new Set(PINNED_TOOLCHAIN_ARTIFACTS.map((artifact) => {
      expect(artifact.archive.url).toMatch(/^https:\/\//);
      expect(artifact.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.executable.sha256).toMatch(/^[a-f0-9]{64}$/);
      if (artifact.executable.installedSha256) {
        expect(artifact.executable.installedSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(artifact.executable.installedSize).toBeGreaterThan(0);
      }
      expect(artifact.archive.size).toBeGreaterThan(0);
      expect(artifact.executable.size).toBeGreaterThan(0);
      expect(artifact.version).toBe(PINNED_TOOLCHAIN_VERSIONS[artifact.name]);
      return `${artifact.name}:${artifact.platform}:${artifact.architecture}`;
    }));

    expect(actual).toEqual(expected);
    expect(PINNED_TOOLCHAIN_ARTIFACTS).toHaveLength(expected.size);
  });

  test("selects exactly one complete tool set for each supported target", () => {
    for (const platform of ["darwin", "linux"] as const) {
      for (const architecture of ["arm64", "x64"] as const) {
        const selected = pinnedToolchainArtifacts(platform, architecture);
        expect(selected.map((artifact) => artifact.name).sort()).toEqual(["claude", "codex", "opencode"]);
        expect(selected.every((artifact) => (
          artifact.platform === platform && artifact.architecture === architecture
        ))).toBe(true);
      }
    }
  });

  test("rejects unsupported toolchain platforms and architectures", () => {
    expect(() => pinnedToolchainArtifacts("win32", "x64")).toThrow("Unsupported toolchain platform");
    expect(() => pinnedToolchainArtifacts("darwin", "ia32")).toThrow("Unsupported toolchain architecture");
  });
});
