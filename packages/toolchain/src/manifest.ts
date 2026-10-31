/**
 * The agent CLIs. Each is installed only when its agent platform is enabled,
 * and the container image carries the same versions (see
 * `tests/unit/version-drift.test.ts`).
 */
export const PINNED_TOOLCHAIN_VERSIONS = {
  claude: "2.1.314",
  codex: "0.166.0",
  grok: "1.0.70",
  opencode: "1.19.5",
  pi: "1.4.0",
} as const;

/**
 * Host tools installed for every profile, whichever agent platforms are
 * enabled. They are not agents: nothing selects them in the platform picker,
 * and the container image installs its own copies from the distribution.
 *
 * - `gh` backs PR detection, reviews and GitHub cloning. The managed copy is
 *   preferred for those calls and sign-in; a host `gh` on PATH is used when
 *   the managed copy is unavailable.
 */
export const PINNED_SUPPORT_TOOL_VERSIONS = {
  gh: "2.102.0",
} as const;

export type AgentToolchainName = keyof typeof PINNED_TOOLCHAIN_VERSIONS;
export type SupportToolName = keyof typeof PINNED_SUPPORT_TOOL_VERSIONS;
export type ToolchainName = AgentToolchainName | SupportToolName;

/** Every pinned tool, agents and support tools alike. */
export const PINNED_TOOL_VERSIONS: Readonly<Record<ToolchainName, string>> = {
  ...PINNED_TOOLCHAIN_VERSIONS,
  ...PINNED_SUPPORT_TOOL_VERSIONS,
};

export function isToolchainName(value: string): value is ToolchainName {
  return Object.hasOwn(PINNED_TOOL_VERSIONS, value);
}

export function isSupportToolName(value: string): value is SupportToolName {
  return Object.hasOwn(PINNED_SUPPORT_TOOL_VERSIONS, value);
}
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
     * See `manager.ts`.
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
const GROK_DOWNLOAD_HOSTS = ["x.ai", "storage.googleapis.com", "storage.cloud.google.com"] as const;

// Release bases are derived from PINNED_TOOLCHAIN_VERSIONS so a version bump
// cannot leave a stale version behind in a URL. This file is the only place
// these URLs are built: `scripts/download-agent.ts` reads them from here rather
// than reconstructing them, which is what the three shell downloaders used to
// do and what needed drift tests to police.
export const CODEX_RELEASE_BASE =
  `https://github.com/openai/codex/releases/download/rust-v${PINNED_TOOLCHAIN_VERSIONS.codex}` as const;
export const PI_RELEASE_BASE =
  `https://github.com/earendil-works/pi/releases/download/v${PINNED_TOOLCHAIN_VERSIONS.pi}` as const;
export const GH_RELEASE_BASE =
  `https://github.com/cli/cli/releases/download/v${PINNED_SUPPORT_TOOL_VERSIONS.gh}` as const;
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

/**
 * GitHub publishes `gh` as a signed and notarized binary inside a versioned
 * folder, so it installs byte-for-byte with no signature repair. The digests
 * were checked against the release's `gh_<version>_checksums.txt`.
 */
function ghArtifact(
  platform: ToolchainPlatform,
  architecture: ToolchainArchitecture,
  archive: { size: number; sha256: string },
  executable: { size: number; sha256: string },
): ToolchainArtifact {
  const version = PINNED_SUPPORT_TOOL_VERSIONS.gh;
  const target = `${platform === "darwin" ? "macOS" : "linux"}_${architecture === "x64" ? "amd64" : "arm64"}`;
  const folder = `gh_${version}_${target}`;
  return {
    name: "gh",
    version,
    platform,
    architecture,
    archive: {
      format: platform === "darwin" ? "zip" : "tar.gz",
      url: `${GH_RELEASE_BASE}/${folder}.${platform === "darwin" ? "zip" : "tar.gz"}`,
      entryPath: `${folder}/bin/gh`,
      size: archive.size,
      sha256: archive.sha256,
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: { fileName: "gh", ...executable },
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
      size: 107_610_108,
      sha256: "c48824462fc57681eafb0925d97b11b589010475613904f570b42fea53e240d5",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "aarch64-apple-darwin",
        {
          size: 24_769_716,
          sha256: "7abd50fe5f033495a7b693c45fb82dc57093a18f1c4ba3e8043577de46c5c7c5",
        },
        {
          size: 69_182_864,
          sha256: "fd37051bfdce0b65cf22a7077e265720a7bd6709d5e400dcbc26197f3041400a",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 268_972_064,
      sha256: "39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1",
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
      size: 117_027_024,
      sha256: "db0c38713c36199b12e7c8d1629386c35a4ce8f99e1c9ce72f1725a74df67b57",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "x86_64-apple-darwin",
        {
          size: 26_748_407,
          sha256: "b35c775d5e5f8d60d05e0de7154e5bbbf320b6d0e28a3237d42cc8a742ccaf65",
        },
        {
          size: 73_183_424,
          sha256: "9d96de017ecec30ec3f8689f489584151c167c255a787dc6e297b6edc9ebe08c",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 289_445_104,
      sha256: "1361e18268866b7f9f5e8703fabcea0a2a990a439eedcce03940abb4ba9eaaeb",
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
      size: 113_382_496,
      sha256: "94eb707605ec2646b2e05b7edf7c4e7b3ccf02b16237c34ae9beb8cfb7f810a9",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "aarch64-unknown-linux-musl",
        {
          size: 27_023_046,
          sha256: "ac98d1f878e353a16cba711fd47bfef2f6c814109bdd819ee2b6b6d6a19701e7",
        },
        {
          size: 70_838_624,
          sha256: "587436a943a59c18cabdbe83f07800d237b60ddd2e0f54d05b23d8b37a0b36f4",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 277_549_176,
      sha256: "f2e6c980c937e734644bed1b4a9a018d3e63a0ccbe71aafc85c86a8c6e4b462a",
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
      size: 121_764_138,
      sha256: "a0bf572d2f93f056c6712a6da348e96078dc84f3885fd7be67807ef389cb3978",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "x86_64-unknown-linux-musl",
        {
          size: 28_565_521,
          sha256: "7588334fd47bc4003d970b70dfd4d1e4578491b1e9baa72976a4c2d7e97590da",
        },
        {
          size: 77_997_328,
          sha256: "657f4e902726e05867c937b583049d5997e057f8cd0ab40450633c9c9ef8d630",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 319_346_888,
      sha256: "b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8",
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
      size: 64_278_924,
      sha256: "c1c9e62521192192ef4c3ed1355ada2144055bddb61682217e997b03c55203c1",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 180_672_544,
      sha256: "feaafead8cd563af0c2dcb386b0757e4355e327ebb6bd1aaad5440fe2f83596c",
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
      size: 69_100_888,
      sha256: "b0212efa6db347187225a17fa3a31c6b261bf4c9f1589a290b0ca902d720d250",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 193_954_400,
      sha256: "4b15c8aab1844936e9e1d1327213355d94c820de8c7084fad88d3812a067d3d0",
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
      size: 78_513_091,
      sha256: "fae5be262d693b7c5e562856cc473e59e741772936db0c0600ac0d5ed5bd088b",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 211_209_208,
      sha256: "dab85b46f4ea4813da5367997f99a60aab64a2118d58ebf552980e792747436c",
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
      size: 79_651_896,
      sha256: "588310a336fa3b9df36b3f0225b26f679d453efaad0cf3d66c3651ef3ec1647a",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 214_386_864,
      sha256: "7df4e4136301f16589b0f30bf91a61380fca5f8ef22dd36570f5ebe1d4ec802c",
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
      size: 124_539_940,
      sha256: "e4524422963f1c79a4894b5ecb70e123cc45a3dd3a0915f312f6135f70aa570c",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 278_848_096,
      sha256: "21d6e7b9a6f07b4cfcb7df13760b3b72aa25e084e13a5354413382987ba832ed",
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
      size: 129_924_753,
      sha256: "f0041d107ad1a613e82fa4d8149e44390c975c3488ca34812fa27ccc9a92b8d6",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 290_710_016,
      sha256: "404779a308a358ecec8b25c8bccf0ce79a94cf261d12cb74065518d189c174f8",
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
      size: 136_687_968,
      sha256: "5a8087f6b0df5796326bb8e58c6e89637c58f28a16aea45434a7e914e854b0dc",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 297_067_016,
      sha256: "a66c0a8f5d0c87a439953d797985192bbcbaefbce2e0d7b2eaa8df30ef0f3ef2",
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
      size: 137_217_467,
      sha256: "c6b690e52ba2d038c4c8d2566b2ec35acef4995c4321f7d57fa464a7088c2b78",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 298_229_464,
      sha256: "4487042b4c4f5d88d4568f68ae98aae0b1ffae58864cf57fb868641bc5f84594",
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
      size: 179_063_008,
      sha256: "5c8a688251bf61e35370b828b6a353b0a20fcc3f64000de8a91d426039f29cec",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 179_063_008,
      sha256: "5c8a688251bf61e35370b828b6a353b0a20fcc3f64000de8a91d426039f29cec",
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
      size: 193_578_304,
      sha256: "d9ecd462f1f3c3b40a7a131944987ee7ed1c38069b7009cc4107398ab767f484",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 193_578_304,
      sha256: "d9ecd462f1f3c3b40a7a131944987ee7ed1c38069b7009cc4107398ab767f484",
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
      size: 166_639_048,
      sha256: "3aa36883574b263088e5addffe241f55430e8daaee1a0c4934b02180007a9761",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 166_639_048,
      sha256: "3aa36883574b263088e5addffe241f55430e8daaee1a0c4934b02180007a9761",
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
      size: 195_700_192,
      sha256: "22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 195_700_192,
      sha256: "22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9",
    },
  },
  {
    name: "pi",
    version: PINNED_TOOLCHAIN_VERSIONS.pi,
    platform: "darwin",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: `${PI_RELEASE_BASE}/pi-darwin-arm64.tar.gz`,
      entryPath: "pi/pi",
      // Pi ships a launcher beside the themes, docs, examples and a native
      // helper module it loads at runtime, so the whole tree is retained and
      // verified as one digest rather than reduced to a file allowlist.
      bundleRoot: "pi/",
      bundleIntegrity: {
        fileCount: 210,
        totalSize: 7_362_755,
        sha256: "8390783a7e1486f056a1dc473d43683336f1b81626ab00b51fabf98e195916ae",
      },
      size: 31_098_931,
      sha256: "79d9979d76a2a5adb7c28e27e9b44629928ccd0dc9fbb6ae7217860bd5e8be5d",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 77_151_074,
      sha256: "b4d93b78e542ca8d1792242cf6c1a875ef4e6fb644141fb4cf67ec7c81ef9b14",
      repairInvalidMacSignature: true,
    },
  },
  {
    name: "pi",
    version: PINNED_TOOLCHAIN_VERSIONS.pi,
    platform: "darwin",
    architecture: "x64",
    archive: {
      format: "tar.gz",
      url: `${PI_RELEASE_BASE}/pi-darwin-x64.tar.gz`,
      entryPath: "pi/pi",
      // Pi ships a launcher beside the themes, docs, examples and a native
      // helper module it loads at runtime, so the whole tree is retained and
      // verified as one digest rather than reduced to a file allowlist.
      bundleRoot: "pi/",
      bundleIntegrity: {
        fileCount: 210,
        totalSize: 7_333_515,
        sha256: "c4af61868d7cc22df475c17b35433d3a4ecc553a4183b869602a120d80673f7f",
      },
      size: 33_558_360,
      sha256: "1bdefc9e1074c1de458ea9f2e43e6013ce49cd05326009b3de144037036585e2",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 82_772_048,
      sha256: "b8e0bd3c24cd8f91a6cf37aa7cecbc3a931702cbffd0f709b26d5a79daeaa48a",
      repairInvalidMacSignature: true,
    },
  },
  {
    name: "pi",
    version: PINNED_TOOLCHAIN_VERSIONS.pi,
    platform: "linux",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: `${PI_RELEASE_BASE}/pi-linux-arm64.tar.gz`,
      entryPath: "pi/pi",
      // Pi ships a launcher beside the themes, docs, examples and a native
      // helper module it loads at runtime, so the whole tree is retained and
      // verified as one digest rather than reduced to a file allowlist.
      bundleRoot: "pi/",
      bundleIntegrity: {
        fileCount: 210,
        totalSize: 7_377_971,
        sha256: "8180603c37f66e67aacb554e3a0063ff2c99f8f53592386b9aec9a7465eb9347",
      },
      size: 42_745_801,
      sha256: "fa5829c7ef83ffeaebba015715c8306220f89b2aa8a00154efbba98dd5440156",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 107_260_048,
      sha256: "26507c6bbf0beef1c5ef109dea333ddb73c058f9f75fed1de13f4186d73e919e",
    },
  },
  {
    name: "pi",
    version: PINNED_TOOLCHAIN_VERSIONS.pi,
    platform: "linux",
    architecture: "x64",
    archive: {
      format: "tar.gz",
      url: `${PI_RELEASE_BASE}/pi-linux-x64.tar.gz`,
      entryPath: "pi/pi",
      // Pi ships a launcher beside the themes, docs, examples and a native
      // helper module it loads at runtime, so the whole tree is retained and
      // verified as one digest rather than reduced to a file allowlist.
      bundleRoot: "pi/",
      bundleIntegrity: {
        fileCount: 210,
        totalSize: 7_328_739,
        sha256: "1c96ce5e0a7a4d61b3015cb62cfdd09d04e25289c056b33787659c3d41dcc9a8",
      },
      size: 42_645_744,
      sha256: "f2e4e4329603223d03260cdb8bd5033dbdc1f73ba58ab8939db2e56546e115d2",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 107_231_360,
      sha256: "0d7611d0b86d38ec8f65dda8e8bee9c5e907c7bae381e9cfff9161b21e8087d0",
    },
  },
  ghArtifact(
    "darwin",
    "arm64",
    {
      size: 14_359_983,
      sha256: "da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e",
    },
    {
      size: 39_834_784,
      sha256: "8a4258433c81106343144857750316241759d06dcf16265cf3c4864a8f2f2ad6",
    },
  ),
  ghArtifact(
    "darwin",
    "x64",
    {
      size: 15_995_994,
      sha256: "b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3",
    },
    {
      size: 43_172_576,
      sha256: "df615405bcf707c5855f22c8be477c62cd7f7af743de75c4805c2b375b3a479c",
    },
  ),
  ghArtifact(
    "linux",
    "arm64",
    {
      size: 13_917_794,
      sha256: "7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484",
    },
    {
      size: 39_059_616,
      sha256: "93308395c2d296a63a662742c6366e4db413d2a4870d07bd9b84e491c065d65d",
    },
  ),
  ghArtifact(
    "linux",
    "x64",
    {
      size: 15_319_960,
      sha256: "bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386",
    },
    {
      size: 42_086_560,
      sha256: "7469124f706944133d6a169691dd1c6c3511b12e85878d255e044e2948df4c9b",
    },
  ),
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
  const expectedNames = Object.keys(PINNED_TOOL_VERSIONS) as ToolchainName[];
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
 * The pinned artifacts for an enabled-platform selection, plus the support
 * tools. An empty selection downloads nothing at all; any other selection,
 * even an SDK-only one such as Cursor, gets the support tools.
 *
 * Agent artifact names and agent platform ids coincide, and this is the one
 * place that relies on it — keeping the filter here means the
 * selection-to-download mapping is testable without starting Electron.
 */
export function pinnedArtifactsForPlatforms(
  enabled: readonly string[],
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): readonly ToolchainArtifact[] {
  const selected = new Set(enabled);
  if (selected.size === 0) return [];
  return pinnedToolchainArtifacts(platform, architecture).filter(
    (artifact) => selected.has(artifact.name) || isSupportToolName(artifact.name),
  );
}
