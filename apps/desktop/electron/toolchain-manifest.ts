export const PINNED_TOOLCHAIN_VERSIONS = {
  claude: "2.1.284",
  codex: "0.158.0",
  grok: "1.0.41",
  opencode: "1.18.33",
  pi: "0.87.1",
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
      size: 95_135_097,
      sha256: "341c4a08f9ce1935b3007376dc2a3d50a0a89112930e9a474ae61367218f6e8a",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "aarch64-apple-darwin",
        {
          size: 23_819_928,
          sha256: "19363918da75f5d2b805b6fffafd84ea3c8976e03e751192c04aea5bd70d4ab4",
        },
        {
          size: 65_358_256,
          sha256: "d47e28a83f8b5c38f3dbf59f9590c580b3d95ae66102e3e180f0e0d6f050fc4c",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 239_662_592,
      sha256: "788a818fbb9596869c7a487554507cb8bdca17584b8671112b23f9e225ba35c8",
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
      size: 103_692_245,
      sha256: "bb3983d45f53cae150c7798993748be75cdd9774c60d1f284c09dd28a919e069",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "x86_64-apple-darwin",
        {
          size: 25_703_695,
          sha256: "b4a7ecd9808f0bcb673f3fb70261528c646fdb0aee1f89798550ca8f7ea31b48",
        },
        {
          size: 69_424_608,
          sha256: "eaf7cf1e3be58d89af0cdadc9196eb8db78c2a7830733df403a352b4c4cd8e88",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 258_337_408,
      sha256: "faaea8cdedd67a2b3fb6b3c9507db8bfe741c14729f0850be6c3c3d9a114fb34",
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
      size: 100_697_998,
      sha256: "91e3fafe5ff845a8f685a05d04919146fb30fdc9245af1a42a2f7f239959e90c",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "aarch64-unknown-linux-musl",
        {
          size: 26_013_869,
          sha256: "541bebec84765ad0d21a3591bed18e251dc1cf164cef203e05002fb045ab1cec",
        },
        {
          size: 66_921_472,
          sha256: "68237b34d0bc182e99c43ca2197a25120339c154dd3fc29f908c2a1b022efa5b",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 247_446_792,
      sha256: "0059c73b149a1433b634e26ad8a715e02717a9920665a9cc5676941db03c45cd",
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
      size: 108_113_441,
      sha256: "af9f5aa6e6662accf9d707cef0d9ca083880a173a9c2b6c22947edb7830e5778",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "x86_64-unknown-linux-musl",
        {
          size: 27_497_614,
          sha256: "5455c64be4ba371444710895aff6d74d653985a3bfc454a8b7fe42d6e6d11e3d",
        },
        {
          size: 74_023_824,
          sha256: "a58bd9853daa3b4d51d54e66083d0b3e3e531bd70287fe2463b995d7356d1d44",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 286_594_376,
      sha256: "167c0148a849d2444f1b5a7fb5f8bb2de1de5ae13a2a504b833fc765980f5cd9",
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
      size: 46_317_276,
      sha256: "24b12873e605b3db3387cb355f43ba7451cd6065c180d8c188663337d2eeb553",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 144_800_738,
      sha256: "139ddeb6a46ba276827bb8f79c7b28208621746e4fd6914d9ae71cc1a0a57524",
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
      size: 48_506_384,
      sha256: "90c7e7d9ffa0d8691ca0f15b42a7b89b72e17a4d26074b9ef06559ff87b221ec",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 150_274_128,
      sha256: "f53aae8eb68d832ab1bcd27bed88c02de910be61f4b5f90068ae8e93d5e794c9",
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
      size: 60_445_510,
      sha256: "c63486624621924bf43be5c01abd252885661a734814224f6d70188a33aea858",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 184_854_672,
      sha256: "986fef2069a03b5181a9ec920786836f98fe3e4950c630941908687854e42757",
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
      size: 60_628_669,
      sha256: "e546123213ae47909a4268692aa4b94950d011afe9cac9938753a2194f1c16d5",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 185_354_368,
      sha256: "0abbb7c32ab0294c0a7bfa2705f9ff0df5dce5ab721d1f00cccfe393f2a11427",
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
      size: 98_952_459,
      sha256: "a08ca0629e314e744d0779fb2968a5c3adcf8c889b0a9ad9fe2b5d6dd76f46a4",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 226_563_088,
      sha256: "50a14c2f50f56668380fdda490167f1d3630d5cc18fb8aed3073c2c7ea7314fe",
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
      size: 103_015_064,
      sha256: "a4caf5e442a59251f51203639f54c2f1e2121b185731110609d07dde16f3bfa2",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 235_010_944,
      sha256: "79441b868935a11ed0630b2ee59327eda9f6a93bb8d470bd6633c03df76d2135",
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
      size: 109_000_921,
      sha256: "0418b9211454ff6831e0ca10b105be0cdb5e251c6fee99bdb98b5af609f3f7ab",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 242_409_464,
      sha256: "3dd0f96d7ada463152d20300186f6cfc6ab94b57e218f49e3ac86db42ac695a6",
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
      size: 108_750_001,
      sha256: "642690c3afaa22029c17341e520d8c35ca85857fce6dcc9ecd90ef5e3c7f1027",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 243_059_896,
      sha256: "5cd90aabd83f8a15136c35aa37bb1d92b348993573316643dc3fe4e04afbf88f",
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
      size: 145_657_952,
      sha256: "9c844eb13365180787d9ad22b2b3748a024be8e1ed845253cc114781b31c591d",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 145_657_952,
      sha256: "9c844eb13365180787d9ad22b2b3748a024be8e1ed845253cc114781b31c591d",
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
      size: 163_046_304,
      sha256: "8fce04ab8f33a0f604e405a64b3ec28cf92aa600ca6b80106e4b14e8bf80d95b",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 163_046_304,
      sha256: "8fce04ab8f33a0f604e405a64b3ec28cf92aa600ca6b80106e4b14e8bf80d95b",
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
      size: 138_577_144,
      sha256: "7c0b8c973af6a78e2037f19ed93033471b8c5e722f9ff04b86b092e066e60d74",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 138_577_144,
      sha256: "7c0b8c973af6a78e2037f19ed93033471b8c5e722f9ff04b86b092e066e60d74",
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
      size: 165_967_424,
      sha256: "9ce03ed23e16ea01072b4496263d6213a27899e1e3e107f008d36edf82e70407",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 165_967_424,
      sha256: "9ce03ed23e16ea01072b4496263d6213a27899e1e3e107f008d36edf82e70407",
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
        fileCount: 207,
        totalSize: 7_178_641,
        sha256: "511451172f1b593d795e92582a2dc2b45daba26f9e51e50f09265408dd62ae73",
      },
      size: 30_563_988,
      sha256: "4f8d288b78c9768d3a4ac6f61f06cd34394b82ac17d5b42d1e44a437add401b7",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 75_648_482,
      sha256: "0fcda879f854b95368a4c217782a78808f7fea61cf60cc1e6fbec4f5b5d700f9",
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
        fileCount: 207,
        totalSize: 7_145_305,
        sha256: "a336d48162ffb2b747428fb5ac788cf6b3c26b0eee2d674df65ba0b8a81ad3a4",
      },
      size: 33_033_993,
      sha256: "01d8ee28d7114fec4f4eeedbb7561f790853040e9bfbdeebe79437ab66ea51f5",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 81_281_104,
      sha256: "86b6420de2b263202779f46673306fbbe49590b97b397ed7428651d08319ac5e",
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
        fileCount: 207,
        totalSize: 7_194_401,
        sha256: "d42c5d998f095af6470ed18d1aa1201101ba008d4ba627363d6acccf200c2bb8",
      },
      size: 42_217_308,
      sha256: "364b4a9f8491450b27a4857d4e3c780dbaf696790821c176a873e860cbbc3b89",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 105_752_720,
      sha256: "e33726d73daf27361ee03f856ae53b16b7ac7a05487f66ca1667f885e68d9a50",
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
        fileCount: 207,
        totalSize: 7_145_169,
        sha256: "cdb78dd022a8c23e1981d5c8474f48a17c19dbee24845254cef0e16accdb3e6f",
      },
      size: 42_120_827,
      sha256: "80d78dd62d50049a006b981d994c61255bcc10e730b0c278d4ea0a755909764c",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 105_744_512,
      sha256: "3e8177cb94d6b4577f3626f9400d80c92d991867400c21a779784f5bee9b9925",
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
