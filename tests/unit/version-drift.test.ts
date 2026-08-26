import { describe, test, expect } from "bun:test";
import { semver } from "bun";
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

/** Every tracked `package.json`: the workspace root plus each workspace member. */
function packageManifestPaths(): string[] {
  const found = ["package.json"];
  for (const group of ["apps", "bridges", "packages"]) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `${group}/${entry.name}/package.json`;
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

/** The resolved version bun actually installs, not the range package.json declares. */
function lockfileResolvedVersion(rel: string, name: string): string {
  const lock = JSON.parse(read(rel).replace(/,(\s*[}\]])/g, "$1")) as {
    packages?: Record<string, unknown[]>;
  };
  const entry = lock.packages?.[name]?.[0];
  if (typeof entry !== "string") {
    throw new Error(`Expected ${rel} to resolve ${name}`);
  }
  // "playwright@1.61.1" — the name may itself contain "@" for a scoped package.
  const version = entry.slice(entry.lastIndexOf("@") + 1);
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Unexpected resolved spec for ${name} in ${rel}: ${entry}`);
  }
  return version;
}

/**
 * The Dockerfile with comment lines removed. Assertions about what the image
 * does must read this: a `#` line quoting an instruction is documentation, and
 * matching it would let the instruction be deleted without failing anything.
 */
function dockerfileInstructions(): string {
  return read("docker/Dockerfile")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
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

function findCrossArtifactIntegrityCollisions(artifacts: ArtifactIntegrityValues[]): Array<{
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

/**
 * Every agent Orkestrator ships, and how each one's version reaches a running
 * environment.
 *
 * This table exists because the per-agent checks below grew one at a time, and
 * each new agent got whatever subset its author remembered. That asymmetry was
 * not cosmetic: Pi's container digests were bound to the manifest while
 * Cursor's and Grok's were not, and `@cursor/sdk` had no pin check at all — so
 * a hand-edited `GROK_SHA` would have shipped
 * unnoticed. The tests that follow iterate this table, and one of them asserts
 * the table covers every name in `PINNED_TOOLCHAIN_VERSIONS`, so another
 * managed CLI cannot be added with less coverage than the five here.
 */
interface AgentPins {
  /** `ARG <name>=` in docker/Dockerfile. */
  dockerArg: string;
  /**
   * How the image gets the binary, which decides whether the Dockerfile
   * carries its own digests:
   *  - `npm`/`installer` resolve the version through a package manager, which
   *    does its own integrity checking, so there is nothing to pin here.
   *  - `pinned-archive` curls an exact URL and verifies it with `sha256sum`.
   *    Those digest literals are a *second* copy of the manifest's, and are
   *    what `container digests` below proves cannot drift.
   */
  containerInstall: "npm" | "installer" | "pinned-archive";
  /**
   * SDK packages pinned in a package.json.
   *
   * `tracksCli` is the load-bearing field. Pi and OpenCode publish the SDK and
   * the binary as the same program two ways, so a split gives the user two
   * different agents behind one platform name. Claude's Agent SDK has its own
   * release train and deliberately does *not* track the CLI.
   */
  sdkPins?: { file: string; dep: string; tracksCli: boolean }[];
}

const AGENT_PINS: Record<string, AgentPins> = {
  claude: {
    dockerArg: "CLAUDE_CLI_VERSION",
    containerInstall: "npm",
    sdkPins: [
      {
        file: "bridges/claude-bridge/package.json",
        dep: "@anthropic-ai/claude-agent-sdk",
        tracksCli: false,
      },
      { file: "bridges/claude-bridge/package.json", dep: "@anthropic-ai/sdk", tracksCli: false },
      // The published `orkestrator` CLI pins the Agent SDK a second time. Its
      // dependencies are only what the bundler leaves external, so this is a
      // real runtime pin for npm users rather than a stale duplicate.
      {
        file: "packages/cli/package.json",
        dep: "@anthropic-ai/claude-agent-sdk",
        tracksCli: false,
      },
    ],
  },
  codex: {
    dockerArg: "CODEX_CLI_VERSION",
    containerInstall: "npm",
    // No SDK by design; `Codex: the bridge does not depend on the Codex SDK`
    // is what keeps it that way.
  },
  opencode: {
    dockerArg: "OPENCODE_CLI_VERSION",
    containerInstall: "installer",
    sdkPins: [
      { file: "apps/web/package.json", dep: "@opencode-ai/sdk", tracksCli: true },
      // The backend drives build pipelines through the same SDK. Checking only
      // the web workspace is how native chat can look healthy while pipelines
      // still speak the previous contract.
      { file: "apps/backend/package.json", dep: "@opencode-ai/sdk", tracksCli: true },
    ],
  },
  grok: {
    dockerArg: "GROK_BUILD_VERSION",
    containerInstall: "pinned-archive",
  },
  pi: {
    dockerArg: "PI_CLI_VERSION",
    containerInstall: "pinned-archive",
    sdkPins: [
      {
        file: "bridges/pi-bridge/package.json",
        dep: "@earendil-works/pi-coding-agent",
        tracksCli: true,
      },
      { file: "bridges/pi-bridge/package.json", dep: "@earendil-works/pi-ai", tracksCli: true },
      {
        file: "bridges/pi-bridge/package.json",
        dep: "@earendil-works/pi-agent-core",
        tracksCli: true,
      },
    ],
  },
};

describe("every shipped agent, uniformly", () => {
  test("the coverage table names every agent the manifest pins", () => {
    // The guarantee the rest of this block rests on. Without it, a seventh
    // agent silently gets zero of the checks below.
    expect(Object.keys(AGENT_PINS).sort()).toEqual(Object.keys(PINNED_TOOLCHAIN_VERSIONS).sort());
  });

  for (const [agent, pins] of Object.entries(AGENT_PINS)) {
    describe(agent, () => {
      const pinned = PINNED_TOOLCHAIN_VERSIONS[agent as keyof typeof PINNED_TOOLCHAIN_VERSIONS];

      test("the image installs the version the manifest pins", () => {
        expect(getDockerfileArg(pins.dockerArg)).toBe(pinned);
      });

      test("every managed artifact is present and carries the pinned version", () => {
        const artifacts = PINNED_TOOLCHAIN_ARTIFACTS.filter((entry) => entry.name === agent);
        // Four targets: darwin/linux x arm64/x64. A missing one is an agent
        // that cannot be installed on that host at all.
        expect(artifacts.length).toBe(4);
        for (const artifact of artifacts) expect(artifact.version).toBe(pinned);
      });

      if (pins.containerInstall === "pinned-archive") {
        test("container digests cannot drift from the manifest", () => {
          // The image does not read the manifest; it curls an exact URL and
          // checks it with `sha256sum`, so these digests are a second copy.
          // Both have to be the same literal or a container and a local
          // worktree are running different builds of the same agent.
          const dockerfile = read("docker/Dockerfile");
          for (const architecture of ["arm64", "x64"] as const) {
            const artifact = PINNED_TOOLCHAIN_ARTIFACTS.find(
              (candidate) =>
                candidate.name === agent &&
                candidate.platform === "linux" &&
                candidate.architecture === architecture,
            );
            expect(artifact, `no linux/${architecture} artifact for ${agent}`).toBeDefined();
            expect(
              dockerfile.includes(artifact!.archive.sha256),
              `docker/Dockerfile does not pin the manifest's linux/${architecture} ` +
                `${agent} digest ${artifact!.archive.sha256}`,
            ).toBe(true);
          }
        });
      }

      for (const { file, dep, tracksCli } of pins.sdkPins ?? []) {
        test(`${dep} in ${file} is exact-pinned`, () => {
          // Exact, never a range: a `^` here means two machines installing the
          // same commit can drive different agent code.
          const version = expectExactVersion(file, dep);
          if (tracksCli) {
            expect(
              version,
              `${dep} and the ${agent} CLI are the same program published twice; ` +
                `they must not split`,
            ).toBe(pinned);
          }
        });
      }
    });
  }
});

describe("version drift between SDK pins and managed/container CLIs", () => {
  test("Cursor SDK is exact-pinned without a managed Cursor CLI", () => {
    expect(expectExactVersion("bridges/cursor-bridge/package.json", "@cursor/sdk")).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
    expect(Object.keys(PINNED_TOOLCHAIN_VERSIONS)).not.toContain("cursor");
    expect(PINNED_TOOLCHAIN_ARTIFACTS.some((artifact) => artifact.name === "cursor")).toBe(false);
    expect(dockerfileInstructions()).not.toContain("CURSOR_AGENT_VERSION");
  });

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
    expect(getShellVar("scripts/download-bun.sh", "BUN_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("Bun: package metadata requires the pinned runtime version", () => {
    const hostPin = getShellVar("scripts/download-bun.sh", "BUN_VERSION");
    const rootPackage = JSON.parse(read("package.json")) as { packageManager?: string };
    const cliPackage = JSON.parse(read("packages/cli/package.json")) as {
      engines?: { bun?: string };
    };

    expect(rootPackage.packageManager).toBe(`bun@${hostPin}`);
    expect(cliPackage.engines?.bun).toBe(`>=${hostPin}`);
  });

  test("Bun: every declared @types/bun range tracks the pinned runtime's minor", () => {
    // `@types/bun` is published in lockstep with the runtime, so a manifest left
    // on the previous minor types a Bun the bridges no longer run on. `~x.y.0`
    // rather than the exact pin: a types patch is a safe float, a minor is not.
    //
    // The manifests are discovered rather than listed. Four declare the
    // dependency today and the rest inherit the root pin, so listing them would
    // reproduce the drift this guards against the moment a package adds its own.
    const hostPin = getShellVar("scripts/download-bun.sh", "BUN_VERSION");
    const [major, minor] = hostPin.split(".");
    const expected = `~${major}.${minor}.0`;
    const nextMinor = `${major}.${Number(minor) + 1}.0`;

    const declared = packageManifestPaths().flatMap((rel) => {
      const pkg = JSON.parse(read(rel)) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const spec = pkg.devDependencies?.["@types/bun"] ?? pkg.dependencies?.["@types/bun"];
      return spec === undefined ? [] : [{ rel, spec }];
    });

    // A repo-wide rename that dropped every declaration would otherwise pass.
    expect(declared.length).toBeGreaterThan(0);
    for (const { rel, spec } of declared) {
      expect(
        spec,
        `${rel} declares @types/bun ${spec}, which is not the pinned Bun ${hostPin} minor`,
      ).toBe(expected);
      expect(semver.satisfies(hostPin, spec), `${spec} must accept the pinned runtime`).toBe(true);
      expect(
        semver.satisfies(`${major}.${minor}.999999`, spec),
        `${spec} must allow patch-only type updates`,
      ).toBe(true);
      expect(
        semver.satisfies(nextMinor, spec),
        `${spec} must reject the next Bun minor ${nextMinor}`,
      ).toBe(false);
    }
  });

  test("Bun: CI validates every supported host download and container architecture", () => {
    const workflow = read(".github/workflows/validate-bun-runtime.yml");
    const configuredRunners = workflow
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("runner: "))
      .map((line) => line.slice("runner: ".length));

    expect(configuredRunners.sort()).toEqual(
      ["ubuntu-24.04", "ubuntu-24.04-arm", "macos-15-intel", "macos-15"].sort(),
    );
    expect(workflow).toContain("run: ./scripts/download-bun.sh");
    expect(workflow).toContain("platforms: linux/amd64,linux/arm64");
  });

  test("Claude bridge: musl variant is stripped from the vendored runtime tree, not top-level node_modules", () => {
    // The claude-bridge build vendors the SDK into dist/node_modules, which is the
    // tree the SDK actually resolves its native binary from at runtime. Stripping
    // musl from top-level node_modules (the historical location) is a no-op against
    // that runtime path. This guards against regressing to the ineffective form.
    // Verified in oven/bun:1.4.0-debian: the bridge resolves the gnu binary from this tree.
    const dockerfile = read("docker/Dockerfile");
    expect(dockerfile).toContain(
      "rm -rf dist/node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl",
    );
    expect(dockerfile).not.toContain(
      "rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl",
    );
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

  test("Pi: the container downloads the same release the manifest pins", () => {
    const dockerfile = readFileSync("docker/Dockerfile", "utf8");
    // Digest agreement with the manifest is checked for every pinned-archive
    // agent by `every shipped agent, uniformly`. What is Pi-specific, and
    // checked here, is the URL shape those digests belong to.
    expect(dockerfile).toContain(
      'curl -fsSL "https://github.com/earendil-works/pi/releases/download/v${PI_CLI_VERSION}/pi-linux-${PI_ARCH}.tar.gz"',
    );
    expect(dockerfile).toContain("ENV PI_CLI_PATH=/usr/local/bin/pi");
    expect(dockerfile).toContain('&& "$PI_CLI_PATH" --version');
  });

  test("Codex: managed manifest and download script share one release base", () => {
    expect(CODEX_RELEASE_BASE).toBe(
      `https://github.com/openai/codex/releases/download/rust-v${PINNED_TOOLCHAIN_VERSIONS.codex}`,
    );
    for (const artifact of PINNED_TOOLCHAIN_ARTIFACTS.filter((entry) => entry.name === "codex")) {
      expect(artifact.archive.url.startsWith(`${CODEX_RELEASE_BASE}/`)).toBe(true);
    }
  });

  // The three tests below assert URL *shape*, which nothing else does.
  // `every managed artifact URL carries its own pinned version` only checks
  // that the version string appears somewhere in the URL, so a manifest
  // pointing at the wrong org, the wrong asset name or the wrong archive
  // format still passes it: the size and digest beside it would agree with
  // each other, and the installer would verify and install the wrong release.
  // They previously lived inside tests that also asserted properties of
  // `scripts/download-opencode.sh` and `scripts/download-claude.sh`; when the
  // shell downloaders were replaced by `scripts/download-agent.ts` those tests
  // were deleted whole, taking the manifest halves with them.

  test("OpenCode: every managed artifact URL derives from the pinned release base", () => {
    // OpenCode moved from the `sst` org to `anomalyco`. Without this, the
    // release base could be edited back and every other test would stay green
    // while the manifest shipped binaries from a different repository.
    expect(OPENCODE_RELEASE_BASE).toBe(
      `https://github.com/anomalyco/opencode/releases/download/v${PINNED_TOOLCHAIN_VERSIONS.opencode}`,
    );
    for (const artifact of PINNED_TOOLCHAIN_ARTIFACTS.filter(
      (entry) => entry.name === "opencode",
    )) {
      expect(artifact.archive.url.startsWith(`${OPENCODE_RELEASE_BASE}/`)).toBe(true);
    }
  });

  test("OpenCode: darwin ships zips and linux ships tarballs, named like the release assets", () => {
    // The two platforms publish different container formats under different
    // extensions. A record that names one and declares the other extracts with
    // the wrong tool and fails at install time rather than in review.
    const artifacts = PINNED_TOOLCHAIN_ARTIFACTS.filter((entry) => entry.name === "opencode");
    expect(artifacts.length).toBe(4);
    for (const artifact of artifacts) {
      const extension = artifact.platform === "linux" ? ".tar.gz" : ".zip";
      expect(
        artifact.archive.url.endsWith(
          `opencode-${artifact.platform}-${artifact.architecture}${extension}`,
        ),
        `${artifact.platform}/${artifact.architecture} is not named like its release asset`,
      ).toBe(true);
      expect(artifact.archive.format).toBe(artifact.platform === "linux" ? "tar.gz" : "zip");
      expect(artifact.archive.entryPath).toBe("opencode");
    }
  });

  test("Claude: every managed artifact URL is the pinned npm tarball for its platform", () => {
    // Claude is fetched from the registry rather than a release page, so the
    // URL encodes the platform package name twice and the version once. All
    // three have to agree or the download is another platform's build.
    const artifacts = PINNED_TOOLCHAIN_ARTIFACTS.filter((entry) => entry.name === "claude");
    expect(artifacts.length).toBe(4);
    for (const artifact of artifacts) {
      const pkg = `claude-code-${artifact.platform}-${artifact.architecture}`;
      expect(artifact.archive.url).toBe(
        `https://registry.npmjs.org/@anthropic-ai/${pkg}/-/${pkg}-${PINNED_TOOLCHAIN_VERSIONS.claude}.tgz`,
      );
      // npm tarballs root everything under `package/`.
      expect(artifact.archive.entryPath).toBe("package/claude");
      expect(artifact.archive.format).toBe("tar.gz");
    }
  });

  test("Codex: every managed platform ships the code-mode host next to codex", () => {
    // Codex spawns `codex-code-mode-host` from its own directory for every
    // code-mode turn. 0.147.0 shipped without it, which made every model that
    // defaults to code mode fail with "failed to spawn code-mode host".
    // The downloader installs companions generically from the manifest, so what
    // is left to assert is that the manifest still declares this one and that
    // the image still ships it.
    expect(read("docker/Dockerfile")).toContain("-name codex-code-mode-host");

    const codexArtifacts = PINNED_TOOLCHAIN_ARTIFACTS.filter((entry) => entry.name === "codex");
    expect(codexArtifacts.length).toBe(4);
    for (const artifact of codexArtifacts) {
      const host = artifact.companions?.find(
        (companion) => companion.fileName === "codex-code-mode-host",
      );
      expect(
        host,
        `${artifact.platform}-${artifact.architecture} has no code-mode host`,
      ).toBeDefined();
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
        expect(
          existing,
          `${label} reuses the SHA-256 already pinned by ${existing}`,
        ).toBeUndefined();
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

    // OpenCode ships unsigned macOS binaries, and Pi 0.84.3 ships binaries with
    // invalid linker signatures. Both architectures must opt into repair or
    // installation fails before the executable can be probed.
    for (const name of ["opencode", "pi"] as const) {
      const darwinArtifacts = PINNED_TOOLCHAIN_ARTIFACTS.filter(
        (artifact) => artifact.name === name && artifact.platform === "darwin",
      );
      expect(darwinArtifacts).toHaveLength(2);
      for (const artifact of darwinArtifacts) {
        expect(artifact.executable.repairInvalidMacSignature).toBe(true);
      }
    }
  });

  test("Docker: the pinned CLI versions are what the image actually installs", () => {
    const dockerfile = read("docker/Dockerfile");
    const nodeVersion = dockerfile.match(/^ARG NODE_VERSION=(\d+\.\d+\.\d+)$/m)?.[1];

    expect(nodeVersion).toBeDefined();
    expect(Number(nodeVersion!.split(".")[0])).toBeGreaterThanOrEqual(22);
    expect(dockerfile).toContain(
      'npm install -g "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}"',
    );
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

  test("Playwright: the container pin tracks the version the repo actually resolves", () => {
    // Browser revisions are tied to the Playwright package. Keep the complete
    // resolved version aligned so a lockfile update cannot leave the image on a
    // different package/browser manifest while this guard still passes.
    //
    // Compared against the lockfile, not the `^`/`~` range in package.json: the
    // range's floor stays put across a resolution bump, so asserting on it would
    // pass through exactly the drift this test exists to catch.
    const dockerfilePin = getDockerfileArg("PLAYWRIGHT_VERSION");
    const resolved = lockfileResolvedVersion("bun.lock", "playwright");

    expect(dockerfilePin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerfilePin).toBe(resolved);

    // `@playwright/test` drags in its own pinned `playwright`, so a split
    // between the two would silently resolve a second browser revision.
    expect(lockfileResolvedVersion("bun.lock", "@playwright/test")).toBe(resolved);
  });

  test("Docker: Playwright ships a usable browser, and never branded Chrome", () => {
    // Every assertion below is about what the image *does*, so all of them read
    // the instruction stream. Matching the raw file would let a comment that
    // merely quotes one of these lines stand in for the instruction itself.
    const instructions = dockerfileInstructions();

    // Baked in because the restricted-network firewall is not a reliable path to
    // Playwright's CDN: a container that had to install its own browser on first
    // use would fail there.
    expect(instructions).toContain("ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright");
    expect(instructions).toContain("playwright install --with-deps chromium");
    // Both container users must be able to read the shared browser root, and
    // `node` must be able to add a browser to it.
    expect(instructions).toContain("chown -R node:node /ms-playwright");

    // `playwright install chrome` pulls Google's own package, which has no
    // linux/arm64 build — it would break the image build on Apple Silicon.
    expect(instructions).not.toMatch(/playwright install[^\n]*\bchrome\b/);
  });

  test("Docker: the Chromium launch check runs as `node` and as uid 0", () => {
    // Chromium will not start as uid 0 without --no-sandbox, which Playwright
    // supplies only because `chromiumSandbox` defaults to false. That makes the
    // root-terminal path a separate claim from the `node` path, and the image
    // build is the only place either is proven — so both must be exercised.
    const instructions = dockerfileInstructions();
    const verifyRuns = [
      ...instructions.matchAll(/node\s+\/usr\/local\/share\/verify-playwright\.cjs/g),
    ].map((match) => match.index);
    expect(verifyRuns).toHaveLength(2);

    // The two runs must straddle the USER switch; two checks as the same user
    // would satisfy the count above while proving only one identity.
    const [rootRun, nodeRun] = verifyRuns as [number, number];
    const rootUser = instructions.lastIndexOf("USER root", rootRun);
    const userNode = instructions.indexOf("USER node", rootRun);
    expect(rootUser).toBeGreaterThan(-1);
    expect(rootRun).toBeGreaterThan(rootUser);
    expect(userNode).toBeGreaterThan(rootRun);
    expect(nodeRun).toBeGreaterThan(userNode);

    // Default options only: an explicit `chromiumSandbox: true` or a hand-added
    // --no-sandbox would make the check stop resembling how an agent launches it.
    // Comments stripped for the same reason as the Dockerfile above: the script's
    // header explains why `chromiumSandbox` is left alone, and that prose must
    // not be what satisfies an assertion about the code.
    const script = read("docker/verify-playwright.cjs")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(script).toContain("chromium.launch()");
    expect(script).not.toContain("chromiumSandbox");
    expect(script).not.toContain("no-sandbox");
  });

  test("Docker: containers get a /dev/shm large enough for Chromium", () => {
    // Docker's 64MB default is well under what a Chromium renderer needs, and it
    // fails as a mid-run renderer crash rather than a launch error — invisible
    // until an agent loads a real page. `--ipc=host` is the other documented fix
    // but shares the host IPC namespace, so the mount size is what is asserted.
    const containers = read("apps/backend/src/core/commands-containers.ts");
    const shmIndex = containers.indexOf('"--shm-size"');
    expect(shmIndex).toBeGreaterThan(-1);
    const size = containers.slice(shmIndex).match(/"--shm-size",\s*"(\d+)([mg])"/i);
    expect(size).not.toBeNull();
    const megabytes = size![2].toLowerCase() === "g" ? Number(size![1]) * 1024 : Number(size![1]);
    expect(megabytes).toBeGreaterThanOrEqual(512);
  });

  test("allowlists: every host required by the image is in all three default lists", () => {
    // Three independent default lists reach containers by different routes: the
    // backend's is persisted on a new install, the renderer's seeds an unwritten
    // config, and the firewall script's is the fallback when ALLOWED_DOMAINS is
    // absent. A host added to one and forgotten in the others is reachable or
    // not depending on which path a given install took.
    const literal = (rel: string, open: string, close: string) => {
      const source = read(rel);
      const from = source.indexOf(open);
      if (from < 0) throw new Error(`Expected ${open} in ${rel}`);
      const to = source.indexOf(close, from + open.length);
      if (to < 0) throw new Error(`Unterminated ${open} in ${rel}`);
      return source.slice(from, to);
    };

    const lists = {
      backend: literal(
        "apps/backend/src/core/storage-shared-core.ts",
        "export const DEFAULT_ALLOWED_DOMAINS = [",
        "];",
      ),
      renderer: literal("apps/web/src/stores/configStore.ts", "allowedDomains: [", "],"),
      firewall: literal("docker/init-firewall.sh", "DOMAIN_ARRAY=(", "\n    )"),
    };

    // Not the full union — the three lists are deliberately different sizes.
    // These are the hosts the image itself depends on being reachable.
    for (const host of ["github.com", "registry.npmjs.org", "cdn.playwright.dev"]) {
      expect({
        host,
        backend: lists.backend.includes(`"${host}"`),
        renderer: lists.renderer.includes(`"${host}"`),
        firewall: lists.firewall.includes(`"${host}"`),
      }).toEqual({ host, backend: true, renderer: true, firewall: true });
    }
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

    const actual = new Set(
      PINNED_TOOLCHAIN_ARTIFACTS.map((artifact) => {
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
      }),
    );

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
    expect(
      findCrossArtifactIntegrityCollisions([
        { target: "first", values: [["archive.sha256", "same-digest"]] },
        { target: "second", values: [["executable.sha256", "same-digest"]] },
      ]),
    ).toEqual([
      {
        field: "executable.sha256",
        target: "second",
        collidesWith: "first",
        collidingField: "archive.sha256",
      },
    ]);

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
        expect(
          selected.every(
            (artifact) => artifact.platform === platform && artifact.architecture === architecture,
          ),
        ).toBe(true);
      }
    }
  });

  test("rejects unsupported toolchain platforms and architectures", () => {
    expect(() => pinnedToolchainArtifacts("win32", "x64")).toThrow(
      "Unsupported toolchain platform",
    );
    expect(() => pinnedToolchainArtifacts("darwin", "ia32")).toThrow(
      "Unsupported toolchain architecture",
    );
  });

  test("rejects incomplete or duplicate target manifests", () => {
    const darwinArm64 = pinnedToolchainArtifacts("darwin", "arm64");
    expect(darwinArm64).toHaveLength(Object.keys(PINNED_TOOLCHAIN_VERSIONS).length);

    expect(() =>
      selectPinnedToolchainArtifacts(
        darwinArm64.filter((artifact) => artifact.name !== "claude"),
        "darwin",
        "arm64",
      ),
    ).toThrow("Pinned toolchain manifest is incomplete for darwin-arm64");

    expect(() =>
      selectPinnedToolchainArtifacts(
        [darwinArm64[0], darwinArm64[0], darwinArm64[1]],
        "darwin",
        "arm64",
      ),
    ).toThrow("Pinned toolchain manifest is incomplete for darwin-arm64");
  });
});
