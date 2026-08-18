export const PINNED_TOOLCHAIN_VERSIONS = {
  claude: "2.1.228",
  codex: "0.147.0",
  cursor: "2026.08.11-e8db854",
  grok: "1.0.3",
  opencode: "1.18.16",
} as const;

export type ToolchainName = keyof typeof PINNED_TOOLCHAIN_VERSIONS;
export type ToolchainPlatform = "darwin" | "linux";
export type ToolchainArchitecture = "arm64" | "x64";
export type ToolchainArchiveFormat = "tar.gz" | "zip" | "raw";

type InstalledExecutableIntegrity =
  | {
      installedSize: number;
      installedSha256: string;
    }
  | {
      installedSize?: undefined;
      installedSha256?: undefined;
    };

export type ToolchainArchive = {
  format: ToolchainArchiveFormat;
  url: string;
  entryPath: string;
  /** Extract every regular file below this prefix, stripping the prefix. */
  bundleRoot?: string;
  /** Runtime files the launcher needs, pinned for cache revalidation. */
  bundleFiles?: readonly { path: string; size: number; sha256: string }[];
  /**
   * Integrity root for a complete launcher bundle. Every regular file below
   * `bundleRoot`, except the separately pinned launcher, is extracted and
   * included in this deterministic tree digest. Use this when the runtime can
   * load chunks or native modules dynamically and cannot be reduced to a small
   * fixed `bundleFiles` allowlist.
   */
  bundleIntegrity?: { fileCount: number; totalSize: number; sha256: string };
  size: number;
  sha256: string;
  allowedHosts: readonly string[];
};

/**
 * A second executable that the primary executable spawns from its own
 * directory. It is installed next to the primary one and activated under the
 * same generated `bin` directory, so the primary tool finds it whether it
 * resolves siblings from the activation symlink or from the version directory.
 *
 * Companions are never probed with `--version`: they are helper processes with
 * their own protocols, not CLIs.
 */
export type ToolchainCompanion = {
  fileName: string;
  archive: ToolchainArchive;
  executable: {
    size: number;
    sha256: string;
  };
};

export type ToolchainArtifact = {
  name: ToolchainName;
  version: string;
  platform: ToolchainPlatform;
  architecture: ToolchainArchitecture;
  archive: ToolchainArchive;
  /** Additional unambiguous command names exposed in the activation directory. */
  activationAliases?: readonly string[];
  companions?: readonly ToolchainCompanion[];
  executable: {
    fileName: ToolchainName;
    /** Size and digest of the executable exactly as published upstream. */
    size: number;
    sha256: string;
    /**
     * Size and digest of the executable as it sits on disk after installation,
     * for artifacts whose on-disk bytes are still byte-identical to the upstream
     * download. Omit for artifacts that set `repairInvalidMacSignature`: the
     * ad-hoc re-signature is produced by the local `codesign`, so its output is
     * not reproducible across machines and must not be pinned here. Those
     * artifacts retain a read-only, manifest-pinned copy of the upstream bytes
     * and regenerate the locally signed executable from it on every startup.
     * See `toolchain-manager.ts`.
     */
    repairInvalidMacSignature?: boolean;
    /** Script launchers whose signed runtime lives beside them in a bundle. */
    skipMacSignatureVerification?: boolean;
  } & InstalledExecutableIntegrity;
};

const GITHUB_RELEASE_HOSTS = [
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
] as const;
const NPM_REGISTRY_HOSTS = ["registry.npmjs.org"] as const;
const CURSOR_DOWNLOAD_HOSTS = ["downloads.cursor.com"] as const;
const GROK_DOWNLOAD_HOSTS = ["x.ai", "storage.googleapis.com", "storage.cloud.google.com"] as const;

// Release bases are derived from PINNED_TOOLCHAIN_VERSIONS so a version bump
// cannot leave a stale version behind in a URL. `scripts/download-codex.sh` and
// `scripts/download-opencode.sh` build the same URLs; tests/unit/version-drift.test.ts
// asserts the two stay in step.
export const CODEX_RELEASE_BASE =
  `https://github.com/openai/codex/releases/download/rust-v${PINNED_TOOLCHAIN_VERSIONS.codex}` as const;
export const OPENCODE_RELEASE_BASE =
  `https://github.com/anomalyco/opencode/releases/download/v${PINNED_TOOLCHAIN_VERSIONS.opencode}` as const;

export const CODEX_CODE_MODE_HOST_FILE_NAME = "codex-code-mode-host";

/**
 * Codex 0.147 runs code mode inside a separate `codex-code-mode-host` process
 * that it spawns from the directory it was launched from. Shipping `codex`
 * alone makes every code-mode turn fail with
 * `failed to spawn code-mode host …: No such file or directory`, which is how
 * the whole model family that defaults to code mode became unusable.
 */
function codexCodeModeHost(
  target: string,
  archive: { size: number; sha256: string },
  executable: { size: number; sha256: string },
): ToolchainCompanion {
  return {
    fileName: CODEX_CODE_MODE_HOST_FILE_NAME,
    archive: {
      format: "tar.gz",
      url: `${CODEX_RELEASE_BASE}/${CODEX_CODE_MODE_HOST_FILE_NAME}-${target}.tar.gz`,
      entryPath: `${CODEX_CODE_MODE_HOST_FILE_NAME}-${target}`,
      size: archive.size,
      sha256: archive.sha256,
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable,
  };
}

function claudeArchiveUrl(target: string): string {
  const pkg = `claude-code-${target}`;
  return `https://registry.npmjs.org/@anthropic-ai/${pkg}/-/${pkg}-${PINNED_TOOLCHAIN_VERSIONS.claude}.tgz`;
}

export const PINNED_TOOLCHAIN_ARTIFACTS: readonly ToolchainArtifact[] = [
  {
    name: "codex",
    version: PINNED_TOOLCHAIN_VERSIONS.codex,
    platform: "darwin",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: `${CODEX_RELEASE_BASE}/codex-aarch64-apple-darwin.tar.gz`,
      entryPath: "codex-aarch64-apple-darwin",
      size: 87_984_231,
      sha256: "75984b81f92a71b0c0f4b3b5cad80e5c57177e4d8c8b4b1e13db703b20dc4358",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "aarch64-apple-darwin",
        {
          size: 17_556_525,
          sha256: "56cdbf6187bf914108d3b7feeea5a34ffba15e5c162bedce69e062ee92ddfb5e",
        },
        {
          size: 49_991_616,
          sha256: "a059beb029cdbc989e72e23f8680be9f703cb6cf83d9598d91041f82178d018d",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 219_997_536,
      sha256: "19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37",
    },
  },
  {
    name: "codex",
    version: PINNED_TOOLCHAIN_VERSIONS.codex,
    platform: "darwin",
    architecture: "x64",
    archive: {
      format: "tar.gz",
      url: `${CODEX_RELEASE_BASE}/codex-x86_64-apple-darwin.tar.gz`,
      entryPath: "codex-x86_64-apple-darwin",
      size: 95_851_149,
      sha256: "36e782f71d8164cc37c2b89c64948f2180e9a2f8456b27e660da75bc6b5574e2",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "x86_64-apple-darwin",
        {
          size: 18_876_257,
          sha256: "7131a0508de4dea60f79c816188b0b06b17f6ed417d9b3a1865b0a4927fbc48a",
        },
        {
          size: 52_496_608,
          sha256: "2a52ebc47c255e6b7284f674453030981a38ae7ba09467b998b2c2ebbb595259",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 238_056_656,
      sha256: "8080a42da4cef9c4216dace512f29acfe2e526aeeec2a0ce450e5a2b18b84d8a",
    },
  },
  {
    name: "codex",
    version: PINNED_TOOLCHAIN_VERSIONS.codex,
    platform: "linux",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: `${CODEX_RELEASE_BASE}/codex-aarch64-unknown-linux-musl.tar.gz`,
      entryPath: "codex-aarch64-unknown-linux-musl",
      size: 91_607_658,
      sha256: "eb677c80f666b1ab8b4b1d083b66e8d614b1281d960bb6f9fd8ca98f58b38b90",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "aarch64-unknown-linux-musl",
        {
          size: 17_260_137,
          sha256: "dfd4ff98ea4db30ed078af9c31b6f86e3da4836d0573aa87e225e5a5b54d3c7c",
        },
        {
          size: 46_976_328,
          sha256: "c8fd26e2ddb0243d79d7c3dfa8bcd47b6a30b14695083790fc51884e82e8ebc2",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 222_231_296,
      sha256: "e23d0be344d2496986c985cd3db61e6f649b1ddd900e6afc1b5aaabbffcbb4e2",
    },
  },
  {
    name: "codex",
    version: PINNED_TOOLCHAIN_VERSIONS.codex,
    platform: "linux",
    architecture: "x64",
    archive: {
      format: "tar.gz",
      url: `${CODEX_RELEASE_BASE}/codex-x86_64-unknown-linux-musl.tar.gz`,
      entryPath: "codex-x86_64-unknown-linux-musl",
      size: 98_970_270,
      sha256: "0246e2e773834e07f0fb5249ed6ebad12e4591e608f8c7bb97dd6a9690544c36",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "x86_64-unknown-linux-musl",
        {
          size: 18_267_855,
          sha256: "0146adfaac8363ec9fcdb5895f7624db5b2e8617a283887938b7fb97a1dd4356",
        },
        {
          size: 49_682_360,
          sha256: "00ecf5d040865b97884c488883abd342581c2a432debe7a54e4646bceee3d2d6",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 258_278_208,
      sha256: "cb0a15567e9a60a5820d54b0f6ae86d504dc3805c1eab21a47f70e3eb7b73a40",
    },
  },
  {
    name: "opencode",
    version: PINNED_TOOLCHAIN_VERSIONS.opencode,
    platform: "darwin",
    architecture: "arm64",
    archive: {
      format: "zip",
      url: `${OPENCODE_RELEASE_BASE}/opencode-darwin-arm64.zip`,
      entryPath: "opencode",
      size: 46_053_503,
      sha256: "1e670c94341a374824dc6700b6f38b2cb6634baf3ca20e645084c33ce6639320",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 143_149_538,
      sha256: "a41776bf64c75786d6baf531b840ffb873c090d7c44793ae2dd4b1896de56a1f",
      repairInvalidMacSignature: true,
    },
  },
  {
    name: "opencode",
    version: PINNED_TOOLCHAIN_VERSIONS.opencode,
    platform: "darwin",
    architecture: "x64",
    archive: {
      format: "zip",
      url: `${OPENCODE_RELEASE_BASE}/opencode-darwin-x64.zip`,
      entryPath: "opencode",
      size: 48_254_566,
      sha256: "4cfa1d11e665ffb83b68dbefc4cadee0559d008e7ab40c92d14fc371c8b13595",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 148_652_112,
      sha256: "aa43d42388a47e280b2f346db155fad622418c48591c7bd1484293be203f0ba4",
      repairInvalidMacSignature: true,
    },
  },
  {
    name: "opencode",
    version: PINNED_TOOLCHAIN_VERSIONS.opencode,
    platform: "linux",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: `${OPENCODE_RELEASE_BASE}/opencode-linux-arm64.tar.gz`,
      entryPath: "opencode",
      size: 60_189_672,
      sha256: "4fdce5f9bc877d977304d71c0c90ad6e83efa381fe0edf0a61e6142a625e1c41",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 183_216_272,
      sha256: "8905e02aaf94e6a3824bd7e14d388a6c97d7f0a2141434cb9ce7656b137abb4a",
    },
  },
  {
    name: "opencode",
    version: PINNED_TOOLCHAIN_VERSIONS.opencode,
    platform: "linux",
    architecture: "x64",
    archive: {
      format: "tar.gz",
      url: `${OPENCODE_RELEASE_BASE}/opencode-linux-x64.tar.gz`,
      entryPath: "opencode",
      size: 60_379_356,
      sha256: "286e07355df06738c1905955be15b7fbc10a7b12d931de9394a6f7597246750b",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 183_724_160,
      sha256: "8e4ac80fe535537e6ee03cee1a8e23af3d0da56db1ae0ce3fffad3ea188a1768",
    },
  },
  {
    name: "claude",
    version: PINNED_TOOLCHAIN_VERSIONS.claude,
    platform: "darwin",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: claudeArchiveUrl("darwin-arm64"),
      entryPath: "package/claude",
      size: 82_675_003,
      sha256: "7dce9d03bf3f61ee983fb7e35c38e26314699a44b9054cb8fea8da9c7e1ffafc",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 289_298_144,
      sha256: "43484b1352cef03a08346f36ef0437755b1aad646ab9313ce187857b794b7247",
    },
  },
  {
    name: "claude",
    version: PINNED_TOOLCHAIN_VERSIONS.claude,
    platform: "darwin",
    architecture: "x64",
    archive: {
      format: "tar.gz",
      url: claudeArchiveUrl("darwin-x64"),
      entryPath: "package/claude",
      size: 87_525_235,
      sha256: "6c1dcc4302bd2ef3b993011a46fa62115a2a34b00538a86885fcb45eaf717d73",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 298_977_312,
      sha256: "7852f1ae0efb64d46d77a57d8852daddc4a6ffb58aeda6267bd3f3428adc09b3",
    },
  },
  {
    name: "claude",
    version: PINNED_TOOLCHAIN_VERSIONS.claude,
    platform: "linux",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: claudeArchiveUrl("linux-arm64"),
      entryPath: "package/claude",
      size: 93_060_201,
      sha256: "31295a318aef235b1b818a8b46982757467fb4d13030520ac66d16a58c0d7e27",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 305_118_136,
      sha256: "2664006219497bf7021ac43156519cd42eda64ceb2a66f434ecab83e7831f942",
    },
  },
  {
    name: "claude",
    version: PINNED_TOOLCHAIN_VERSIONS.claude,
    platform: "linux",
    architecture: "x64",
    archive: {
      format: "tar.gz",
      url: claudeArchiveUrl("linux-x64"),
      entryPath: "package/claude",
      size: 93_656_712,
      sha256: "0c304edad9753e2efeb88ddb76c5a13c06160d67c980b9d849ad65bfadde3fd8",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 308_521_992,
      sha256: "d535985e6941a3eb00179ccd7f52ceb0c6623a0305a518ebc4e6514f84a94c99",
    },
  },
  {
    name: "cursor",
    version: PINNED_TOOLCHAIN_VERSIONS.cursor,
    platform: "darwin",
    architecture: "arm64",
    activationAliases: ["cursor-agent"],
    archive: {
      format: "tar.gz",
      url: `https://downloads.cursor.com/lab/${PINNED_TOOLCHAIN_VERSIONS.cursor}/darwin/arm64/agent-cli-package.tar.gz`,
      entryPath: "dist-package/cursor-agent",
      bundleRoot: "dist-package/",
      bundleIntegrity: {
        fileCount: 435,
        totalSize: 233_915_000,
        sha256: "c8cb6eb3dda11f10bb185a3159c34358999c6d120f409e28e7c5dcd0c98443c2",
      },
      size: 74_746_275,
      sha256: "46044d6d7bcbd7b49a0cf1cd01aa4ca79aaa2ea5f2c7a32965fc0ebe29841790",
      allowedHosts: CURSOR_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "cursor",
      size: 1_074,
      sha256: "eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831",
      skipMacSignatureVerification: true,
    },
  },
  {
    name: "cursor",
    version: PINNED_TOOLCHAIN_VERSIONS.cursor,
    platform: "darwin",
    architecture: "x64",
    activationAliases: ["cursor-agent"],
    archive: {
      format: "tar.gz",
      url: `https://downloads.cursor.com/lab/${PINNED_TOOLCHAIN_VERSIONS.cursor}/darwin/x64/agent-cli-package.tar.gz`,
      entryPath: "dist-package/cursor-agent",
      bundleRoot: "dist-package/",
      bundleIntegrity: {
        fileCount: 435,
        totalSize: 239_811_650,
        sha256: "09567340b9337525d9f4073913c36f077ced7f136dd07d2435fe9c9ca678a4c6",
      },
      size: 77_650_670,
      sha256: "d5c1ce96dd36469e0231d818d4ccf390caac52d94e607c56ebeecc247cab2b1b",
      allowedHosts: CURSOR_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "cursor",
      size: 1_074,
      sha256: "eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831",
      skipMacSignatureVerification: true,
    },
  },
  {
    name: "cursor",
    version: PINNED_TOOLCHAIN_VERSIONS.cursor,
    platform: "linux",
    architecture: "arm64",
    activationAliases: ["cursor-agent"],
    archive: {
      format: "tar.gz",
      url: `https://downloads.cursor.com/lab/${PINNED_TOOLCHAIN_VERSIONS.cursor}/linux/arm64/agent-cli-package.tar.gz`,
      entryPath: "dist-package/cursor-agent",
      bundleRoot: "dist-package/",
      bundleIntegrity: {
        fileCount: 441,
        totalSize: 248_799_966,
        sha256: "2559dbe9372301df47c5833a84b35d4025baaab7b76edcf6d86a7b81f4d512e6",
      },
      size: 83_117_637,
      sha256: "ea13f92e295f523a99ce8d8f57d6894d21e5d1e2d030ffad718ccd5955ca2eed",
      allowedHosts: CURSOR_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "cursor",
      size: 1_074,
      sha256: "eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831",
    },
  },
  {
    name: "cursor",
    version: PINNED_TOOLCHAIN_VERSIONS.cursor,
    platform: "linux",
    architecture: "x64",
    activationAliases: ["cursor-agent"],
    archive: {
      format: "tar.gz",
      url: `https://downloads.cursor.com/lab/${PINNED_TOOLCHAIN_VERSIONS.cursor}/linux/x64/agent-cli-package.tar.gz`,
      entryPath: "dist-package/cursor-agent",
      bundleRoot: "dist-package/",
      bundleIntegrity: {
        fileCount: 441,
        totalSize: 254_357_686,
        sha256: "76a35725239f2fa87a2afbc9d43f76d57cfecb5aadc99f5a5581d5f8ab9843f9",
      },
      size: 84_532_310,
      sha256: "bfff4bf6f4e9dd30c1d0ef0a70b6077b074015dd2948e4c50685d53afdcfce5a",
      allowedHosts: CURSOR_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "cursor",
      size: 1_074,
      sha256: "eed61c5224668c9236334c4c68936a16aecc37374b592f59e31eb50433817831",
    },
  },
  {
    name: "grok",
    version: PINNED_TOOLCHAIN_VERSIONS.grok,
    platform: "darwin",
    architecture: "arm64",
    archive: {
      format: "raw",
      url: `https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-${PINNED_TOOLCHAIN_VERSIONS.grok}-macos-aarch64`,
      entryPath: "",
      size: 133_563_584,
      sha256: "09deaf06804955ff2d6ccef2042af4031c659c47fd16eb3c72664a8f533832da",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 133_563_584,
      sha256: "09deaf06804955ff2d6ccef2042af4031c659c47fd16eb3c72664a8f533832da",
    },
  },
  {
    name: "grok",
    version: PINNED_TOOLCHAIN_VERSIONS.grok,
    platform: "darwin",
    architecture: "x64",
    archive: {
      format: "raw",
      url: `https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-${PINNED_TOOLCHAIN_VERSIONS.grok}-macos-x86_64`,
      entryPath: "",
      size: 149_279_776,
      sha256: "b5eef73b94fdc72b8c67218f19abe2b2728db38f1f0e66903de8fb931948bd26",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 149_279_776,
      sha256: "b5eef73b94fdc72b8c67218f19abe2b2728db38f1f0e66903de8fb931948bd26",
    },
  },
  {
    name: "grok",
    version: PINNED_TOOLCHAIN_VERSIONS.grok,
    platform: "linux",
    architecture: "arm64",
    archive: {
      format: "raw",
      url: `https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-${PINNED_TOOLCHAIN_VERSIONS.grok}-linux-aarch64`,
      entryPath: "",
      size: 135_542_760,
      sha256: "ed44950eab90573b6f475191f5791713a56943939b3b9a62e3f4e95edd14acd9",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 135_542_760,
      sha256: "ed44950eab90573b6f475191f5791713a56943939b3b9a62e3f4e95edd14acd9",
    },
  },
  {
    name: "grok",
    version: PINNED_TOOLCHAIN_VERSIONS.grok,
    platform: "linux",
    architecture: "x64",
    archive: {
      format: "raw",
      url: `https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-${PINNED_TOOLCHAIN_VERSIONS.grok}-linux-x86_64`,
      entryPath: "",
      size: 165_768_512,
      sha256: "2a7d46dea3fbed067e4072258b835d401e017d6848dc996279f0fb3d668a0961",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 165_768_512,
      sha256: "2a7d46dea3fbed067e4072258b835d401e017d6848dc996279f0fb3d668a0961",
    },
  },
] as const;

export function selectPinnedToolchainArtifacts(
  artifacts: readonly ToolchainArtifact[],
  platform: NodeJS.Platform,
  architecture: string,
): readonly ToolchainArtifact[] {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Unsupported toolchain platform: ${platform}`);
  }
  if (architecture !== "arm64" && architecture !== "x64") {
    throw new Error(`Unsupported toolchain architecture: ${architecture}`);
  }

  const matches = artifacts.filter(
    (artifact) => artifact.platform === platform && artifact.architecture === architecture,
  );
  const expectedNames = Object.keys(PINNED_TOOLCHAIN_VERSIONS) as ToolchainName[];
  const matchedNames = new Set(matches.map((artifact) => artifact.name));
  if (
    matches.length !== expectedNames.length ||
    expectedNames.some((name) => !matchedNames.has(name))
  ) {
    throw new Error(`Pinned toolchain manifest is incomplete for ${platform}-${architecture}`);
  }
  return matches;
}

export function pinnedToolchainArtifacts(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): readonly ToolchainArtifact[] {
  return selectPinnedToolchainArtifacts(PINNED_TOOLCHAIN_ARTIFACTS, platform, architecture);
}

/**
 * The pinned artifacts for an enabled-platform selection.
 *
 * Artifact names and agent platform ids coincide, and this is the one place that
 * relies on it — keeping the filter here means the selection-to-download mapping
 * is testable without starting Electron.
 */
export function pinnedArtifactsForPlatforms(
  enabled: readonly string[],
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): readonly ToolchainArtifact[] {
  const selected = new Set(enabled);
  return pinnedToolchainArtifacts(platform, architecture).filter((artifact) =>
    selected.has(artifact.name),
  );
}
