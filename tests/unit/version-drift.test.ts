import { describe, test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_RELEASE_BASE,
  OPENCODE_RELEASE_BASE,
  PINNED_TOOLCHAIN_ARTIFACTS,
  PINNED_TOOLCHAIN_VERSIONS,
  pinnedToolchainArtifacts,
  selectPinnedToolchainArtifacts,
} from "../../apps/desktop/electron/toolchain-manifest";

const repoRoot = join(import.meta.dir, "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

/** Every `bun.lock` the repo tracks: the workspace root plus any nested one. */
function lockfilePaths(): string[] {
  const found = existsSync(join(repoRoot, "bun.lock")) ? ["bun.lock"] : [];
  for (const group of ["apps", "bridges", "packages"]) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `${group}/${entry.name}/bun.lock`;
      if (existsSync(join(repoRoot, rel))) found.push(rel);
    }
  }
  return found;
}

/** `bun.lock` is JSONC — trailing commas are legal and `JSON.parse` rejects them. */
function lockfileRootDependencies(rel: string): Record<string, string> {
  const lock = JSON.parse(read(rel).replace(/,(\s*[}\]])/g, "$1")) as {
    workspaces?: Record<string, { dependencies?: Record<string, string> }>;
  };
  return lock.workspaces?.[""]?.dependencies ?? {};
}

/**
 * Bun resolves `workspace:*` siblings from the workspace root rather than
 * recording them in a nested lockfile, so they are not drift when absent.
 */
function externalDependencies(deps: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(deps).filter(([, spec]) => !spec.startsWith("workspace:")),
  );
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

interface ArtifactIntegrityValues {
  target: string;
  values: Array<readonly [field: string, value: string]>;
}

function findCrossArtifactIntegrityCollisions(
  artifacts: ArtifactIntegrityValues[],
): Array<{
  field: string;
  target: string;
  collidesWith: string;
  collidingField: string;
}> {
  const seen = new Map<string, { field: string; target: string }>();
  const collisions: Array<{
    field: string;
    target: string;
    collidesWith: string;
    collidingField: string;
  }> = [];
  for (const artifact of artifacts) {
    for (const [field, value] of artifact.values) {
      const previous = seen.get(value);
      if (previous && previous.target !== artifact.target) {
        collisions.push({
          field,
          target: artifact.target,
          collidesWith: previous.target,
          collidingField: previous.field,
        });
      } else if (!previous) {
        seen.set(value, { field, target: artifact.target });
      }
    }
  }
  return collisions;
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

  test("Codex: managed binary, download script, and Docker CLI all match", () => {
    // The bridge no longer depends on @openai/codex-sdk — it talks to
    // `codex app-server` over JSON-RPC — so config/codex-version.json is the only
    // pin, and the CLI version still matters for the binary and the image.
    const configPin = (
      JSON.parse(read("config/codex-version.json")) as { version: string }
    ).version;

    expect(getShellVar("scripts/download-codex.sh", "CODEX_VERSION")).toBe(configPin);
    expect(getDockerfileArg("CODEX_CLI_VERSION")).toBe(configPin);
    expect(PINNED_TOOLCHAIN_VERSIONS.codex).toBe(configPin);
  });

  test("Codex: the bridge does not depend on the Codex SDK", () => {
    // A stray dependency would resurrect a second execution path and re-introduce
    // the drift this consolidation removed.
    const pkg = JSON.parse(read("bridges/codex-bridge/package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.["@openai/codex-sdk"]).toBeUndefined();
    expect(pkg.devDependencies?.["@openai/codex-sdk"]).toBeUndefined();
  });

  test("Codex: no lockfile anywhere still resolves the removed Codex SDK", () => {
    // package.json alone was not enough. bridges/codex-bridge/bun.lock kept
    // resolving @openai/codex-sdk (and its ~100MB platform binaries) for three
    // upgrades after ADR 0001 removed the dependency, because no test read a
    // lockfile. That file ships: .dockerignore does not exclude bun.lock and the
    // image `mv`s the bridge to /opt/codex-bridge, leaving a lockfile with no
    // workspace root above it, where `bun install` would resurrect the second
    // execution path at a version that no longer matches the pin.
    for (const lockfile of lockfilePaths()) {
      expect(read(lockfile), `${lockfile} still resolves @openai/codex-sdk`).not.toContain(
        "@openai/codex-sdk",
      );
    }
  });

  test("every nested lockfile agrees with its own package.json", () => {
    // A nested lockfile is only safe while it describes the package next to it.
    // Once it drifts it is a lie that survives every package.json-only check.
    for (const lockfile of lockfilePaths()) {
      if (lockfile === "bun.lock") continue;
      const packageRel = lockfile.replace(/bun\.lock$/, "package.json");
      const manifest = JSON.parse(read(packageRel)) as {
        dependencies?: Record<string, string>;
      };
      const locked = lockfileRootDependencies(lockfile);

      expect(locked, `${lockfile} disagrees with ${packageRel}`).toEqual(
        externalDependencies(manifest.dependencies ?? {}),
      );
    }
  });

  test("Codex: config/codex-version.json is the single source of truth for every pin", () => {
    // The app-server binary and the generated protocol bindings are only valid
    // as a matched pair, so every place that names a Codex version has to agree
    // with this one file.
    const config = JSON.parse(read("config/codex-version.json")) as {
      version: string;
      appServerProtocol: { generatedFrom: string; outputDir: string };
    };

    expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(config.appServerProtocol.generatedFrom).toBe(config.version);
    expect(config.appServerProtocol.outputDir).toBe(
      "bridges/codex-bridge/src/app-server/generated",
    );
    expect(getShellVar("scripts/download-codex.sh", "CODEX_VERSION")).toBe(config.version);
    expect(getDockerfileArg("CODEX_CLI_VERSION")).toBe(config.version);
    expect(PINNED_TOOLCHAIN_VERSIONS.codex).toBe(config.version);
  });

  test("Codex: committed app-server protocol manifest matches the pinned version", () => {
    // A full regeneration needs the pinned binary, which normal CI does not
    // have. This cheap check still catches the common failure: bumping the
    // version without regenerating the bindings.
    const config = JSON.parse(read("config/codex-version.json")) as {
      version: string;
      appServerProtocol: { outputDir: string };
    };
    const manifest = JSON.parse(
      read(join(config.appServerProtocol.outputDir, "protocol-manifest.json")),
    ) as {
      codexVersion: string;
      typescriptDigest: string;
      schemaDigest: string;
      typescriptFileCount: number;
      schemaFileCount: number;
      clientRequestMethods: string[];
      serverNotificationMethods: string[];
      serverRequestMethods: string[];
    };

    expect(manifest.codexVersion).toBe(config.version);
    expect(manifest.typescriptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.schemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.typescriptFileCount).toBeGreaterThan(0);
    expect(manifest.schemaFileCount).toBeGreaterThan(0);

    // Every method the bridge depends on must exist in the pinned protocol.
    // These are the exact methods bridges/codex-bridge/src/app-server calls.
    for (const method of [
      "initialize",
      "thread/start",
      "thread/resume",
      "thread/read",
      "thread/list",
      "thread/unsubscribe",
      "thread/name/set",
      "turn/start",
      "turn/interrupt",
      "model/list",
    ]) {
      expect(manifest.clientRequestMethods).toContain(method);
    }
    for (const method of [
      "thread/started",
      "turn/started",
      "turn/completed",
      "item/started",
      "item/completed",
      "item/agentMessage/delta",
      "item/commandExecution/outputDelta",
      "item/fileChange/patchUpdated",
      "error",
    ]) {
      expect(manifest.serverNotificationMethods).toContain(method);
    }
    // The router must stay exhaustive over this union.
    expect(manifest.serverRequestMethods.length).toBeGreaterThan(0);
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
    // The backend drives build pipelines through the same SDK. Checking only the
    // web workspace is how native chat can look healthy while pipelines still
    // speak the previous contract — the exact split docs/upgrade-agents.md warns
    // about, which was documented as enforced here long before it actually was.
    const backendPin = expectExactVersion("apps/backend/package.json", "@opencode-ai/sdk");
    const downloadScriptPin = getShellVar(
      "scripts/download-opencode.sh",
      "OPENCODE_VERSION",
    );
    const dockerfilePin = getDockerfileArg("OPENCODE_CLI_VERSION");

    expect(backendPin).toBe(sdkPin);
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

  test("Codex: every managed platform ships the code-mode host next to codex", () => {
    // Codex spawns `codex-code-mode-host` from its own directory for every
    // code-mode turn. 0.147.0 shipped without it, which made every model that
    // defaults to code mode fail with "failed to spawn code-mode host".
    const script = read("scripts/download-codex.sh");
    expect(script).toContain('CODEX_HOST_FILENAME="codex-code-mode-host-${CODEX_TARGET}"');
    expect(script).toContain("$BINARIES_DIR/codex-code-mode-host");
    expect(read("docker/Dockerfile")).toContain("-name codex-code-mode-host");

    const codexArtifacts = PINNED_TOOLCHAIN_ARTIFACTS.filter((entry) => entry.name === "codex");
    expect(codexArtifacts.length).toBe(4);
    for (const artifact of codexArtifacts) {
      const host = artifact.companions
        ?.find((companion) => companion.fileName === "codex-code-mode-host");
      expect(host, `${artifact.platform}-${artifact.architecture} has no code-mode host`)
        .toBeDefined();
      // The companion is a separate release asset, so nothing else guarantees
      // it was refreshed from the same release as the executable beside it.
      expect(host!.archive.url.startsWith(`${CODEX_RELEASE_BASE}/`)).toBe(true);
      expect(host!.archive.sha256).not.toBe(artifact.archive.sha256);
      expect(host!.executable.sha256).not.toBe(artifact.executable.sha256);
    }

    // Only `bun run verify:toolchains:live` can prove a digest matches the
    // release it names. Within the Codex release, every target and companion is
    // a distinct native asset, so duplicate digests identify a copied block.
    const digests = new Map<string, string>();
    for (const artifact of codexArtifacts) {
      const target = `${artifact.name}:${artifact.platform}:${artifact.architecture}`;
      const claim = (label: string, sha256: string) => {
        const existing = digests.get(sha256);
        expect(existing, `${label} reuses the SHA-256 already pinned by ${existing}`)
          .toBeUndefined();
        digests.set(sha256, label);
      };
      claim(`${target} archive`, artifact.archive.sha256);
      claim(`${target} executable`, artifact.executable.sha256);
      for (const companion of artifact.companions ?? []) {
        claim(`${target} ${companion.fileName} archive`, companion.archive.sha256);
        claim(`${target} ${companion.fileName} executable`, companion.executable.sha256);
      }
    }

    // A companion asset name carries its own target, so a copied block that was
    // never retargeted downloads another platform's helper with this platform's
    // expectations and only fails at install time.
    for (const artifact of codexArtifacts) {
      const target = artifact.archive.entryPath.replace(/^codex-/, "");
      for (const companion of artifact.companions ?? []) {
        expect(companion.archive.url).toBe(
          `${CODEX_RELEASE_BASE}/${companion.fileName}-${target}.tar.gz`,
        );
        expect(companion.archive.entryPath).toBe(`${companion.fileName}-${target}`);
      }
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
    const nodeVersion = dockerfile.match(/^ARG NODE_VERSION=(\d+\.\d+\.\d+)$/m)?.[1];

    expect(nodeVersion).toBeDefined();
    expect(Number(nodeVersion!.split(".")[0])).toBeGreaterThanOrEqual(22);
    expect(dockerfile).toContain('npm install -g "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}"');
    expect(dockerfile).toContain('npm install -g "@openai/codex@${CODEX_CLI_VERSION}"');
    expect(dockerfile).toContain('--version "$OPENCODE_CLI_VERSION"');
    // The three CLI paths the backend resolves at runtime.
    expect(dockerfile).toContain("ENV CLAUDE_CLI_PATH=/usr/local/share/npm-global/bin/claude");
    expect(dockerfile).toContain("ENV CODEX_CLI_PATH=/usr/local/share/npm-global/bin/codex");
    expect(dockerfile).toContain("ENV OPENCODE_CLI_PATH=/home/node/.opencode/bin/opencode");
    expect(dockerfile).toContain("/home/node/.opencode/bin");
    expect(dockerfile).toContain('RUN "$CLAUDE_CLI_PATH" --version');
    expect(dockerfile).toContain('&& "$CODEX_CLI_PATH" --version');
    expect(dockerfile).toContain('&& "$OPENCODE_CLI_PATH" --version');
  });

  test("managed manifest covers every supported platform and architecture with immutable checksums", () => {
    const expected = new Set<string>();
    for (const platform of ["darwin", "linux"]) {
      for (const architecture of ["arm64", "x64"]) {
        for (const name of Object.keys(PINNED_TOOLCHAIN_VERSIONS)) {
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
      if (artifact.archive.bundleIntegrity) {
        expect(artifact.archive.bundleIntegrity.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(artifact.archive.bundleIntegrity.fileCount).toBeGreaterThan(0);
        expect(artifact.archive.bundleIntegrity.totalSize).toBeGreaterThan(0);
      }
      expect(artifact.archive.size).toBeGreaterThan(0);
      expect(artifact.executable.size).toBeGreaterThan(0);
      expect(artifact.version).toBe(PINNED_TOOLCHAIN_VERSIONS[artifact.name]);
      return `${artifact.name}:${artifact.platform}:${artifact.architecture}`;
    }));

    expect(actual).toEqual(expected);
    expect(PINNED_TOOLCHAIN_ARTIFACTS).toHaveLength(expected.size);
  });

  test("no pinned checksum is shared between two different artifacts", () => {
    /**
     * Shape checks (`/^[a-f0-9]{64}$/`) cannot tell a real digest from a
     * plausible one, and nothing in CI downloads the releases: live verification
     * is `RUN_LIVE_TOOLCHAIN_ARTIFACTS=1 bun scripts/verify-toolchain-artifacts.ts`
     * (see `bun run verify:toolchains:live`), which is a manual step in the
     * upgrade guide.
     *
     * The realistic offline-detectable failure is a version bump that updates
     * every version string but re-uses one artifact's digest for another — a
     * copy-paste while filling in the twelve entries from `--emit` output.
     * Distinct binaries cannot share a digest or an exact byte count, so any
     * collision here is a manifest mistake, and it would otherwise sail through
     * the entire suite.
     */
    const values = PINNED_TOOLCHAIN_ARTIFACTS.map((artifact) => ({
      target: `${artifact.name}:${artifact.platform}:${artifact.architecture}`,
      values: [
        ["archive.url", artifact.archive.url],
        ["archive.sha256", artifact.archive.sha256],
        // Cursor's launcher script is intentionally byte-identical across
        // targets; its target-specific runtime files and containing archive
        // are pinned independently.
        ...(artifact.archive.bundleRoot
          ? []
          : [["executable.sha256", artifact.executable.sha256] as const]),
        ...(artifact.archive.bundleIntegrity
          ? [["archive.bundleIntegrity.sha256", artifact.archive.bundleIntegrity.sha256] as const]
          : []),
        ...(artifact.executable.installedSha256
          ? [["executable.installedSha256", artifact.executable.installedSha256] as const]
          : []),
      ] as Array<readonly [string, string]>,
    }));
    expect(findCrossArtifactIntegrityCollisions(values)).toEqual([]);

    // Regression: include the field independently from the lookup key. A copied
    // archive digest must collide with another artifact's executable digest.
    expect(findCrossArtifactIntegrityCollisions([
      { target: "first", values: [["archive.sha256", "same-digest"]] },
      { target: "second", values: [["executable.sha256", "same-digest"]] },
    ])).toEqual([{
      field: "executable.sha256",
      target: "second",
      collidesWith: "first",
      collidingField: "archive.sha256",
    }]);

    // Sizes may legitimately repeat across fields of the same artifact, but two
    // different downloads having byte-identical archives would mean one URL
    // points at the wrong release.
    const archiveSizes = PINNED_TOOLCHAIN_ARTIFACTS.map((artifact) => artifact.archive.size);
    expect(new Set(archiveSizes).size).toBe(archiveSizes.length);
  });

  test("selects exactly one complete tool set for each supported target", () => {
    for (const platform of ["darwin", "linux"] as const) {
      for (const architecture of ["arm64", "x64"] as const) {
        const selected = pinnedToolchainArtifacts(platform, architecture);
        expect(selected.map((artifact) => artifact.name).sort()).toEqual(
          Object.keys(PINNED_TOOLCHAIN_VERSIONS).sort(),
        );
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

  test("rejects incomplete or duplicate target manifests", () => {
    const darwinArm64 = pinnedToolchainArtifacts("darwin", "arm64");
    expect(darwinArm64).toHaveLength(Object.keys(PINNED_TOOLCHAIN_VERSIONS).length);

    expect(() =>
      selectPinnedToolchainArtifacts(
        darwinArm64.filter((artifact) => artifact.name !== "claude"),
        "darwin",
        "arm64",
      )
    ).toThrow("Pinned toolchain manifest is incomplete for darwin-arm64");

    expect(() =>
      selectPinnedToolchainArtifacts(
        [darwinArm64[0], darwinArm64[0], darwinArm64[1]],
        "darwin",
        "arm64",
      )
    ).toThrow("Pinned toolchain manifest is incomplete for darwin-arm64");
  });
});
