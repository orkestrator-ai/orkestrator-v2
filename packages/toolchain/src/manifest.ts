/**
 * The agent CLIs. Each is installed only when its agent platform is enabled,
 * and the container image carries the same versions (see
 * `tests/unit/version-drift.test.ts`).
 */
export const PINNED_TOOLCHAIN_VERSIONS = {
  claude: "2.1.314",
  codex: "0.164.0",
  grok: "1.0.67",
  opencode: "1.19.4",
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
      size: 101_767_166,
      sha256: "aa8299c169d80111aac05543ad2621c9bdbedb9bc252c905fe3f5a5baf9a4142",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "aarch64-apple-darwin",
        {
          size: 24_347_400,
          sha256: "7bc3ca697567bc884a76233999c46cb22b023b09f2d4d4ab3518f1354c64e415",
        },
        {
          size: 68_543_072,
          sha256: "416721e33af8822041dc650793512b3e58d43e0be4f3a5c6187eb4dfaad3148a",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 260_293_200,
      sha256: "d8990e3ee7acfbc26f91265b12a1a83f0fee40d0e0f8f1f40a37d4ec21f499cf",
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
      size: 110_491_441,
      sha256: "de6bbc013c56337f6ddd3f26dfbfd62aad5924cb68cd5ef6430538922bfa0e75",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "x86_64-apple-darwin",
        {
          size: 26_213_130,
          sha256: "50f93d5413647488940aa23db9b1c822ee86f2c45fa37af34993e992c9848211",
        },
        {
          size: 72_251_296,
          sha256: "067f9c14f67b02bdb984d4fc4740da14cd397da7ee60b4506eb378921afe3e7d",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 279_923_568,
      sha256: "d7e19691e0c1945612475ee8ab32e59ead55472e976b5cea1682d827d34dbba1",
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
      size: 106_977_873,
      sha256: "29a507a2a3fd8f6cd94b96b762d281d299d15d7902dee6132d314b78cf9108eb",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "aarch64-unknown-linux-musl",
        {
          size: 26_642_339,
          sha256: "0e0bdde24d5b31b05519693635baa9c4f2dc4fe7eee31c67b92155f190dd32d2",
        },
        {
          size: 70_117_728,
          sha256: "7d28b996b825b13ea058af67655b619a26a125d61d4fb2985694a9c4e77d2e21",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 268_045_528,
      sha256: "8813c8d8a4cea2eeba271b72ab22f49628b184b24ab18dbef06b4ce41e9a8d39",
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
      size: 114_979_035,
      sha256: "90dd0b03b28afcb7fa733a4f73b413db2916a47347efd43fb669cc1c774ee8e4",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "x86_64-unknown-linux-musl",
        {
          size: 28_137_475,
          sha256: "feade7026436baa4e82e898050c7ef82a8adbd98163dc504771275b5ef224f2f",
        },
        {
          size: 76_997_904,
          sha256: "8ee4f472e92ac226a189e98998633b2d07f989f208515750764db660369f2926",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 308_139_304,
      sha256: "b93f6811d3f653f0fb83be4050d857fb9abbb111dfa2ce160563327daff7f306",
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
      size: 64_291_659,
      sha256: "c400a2f8c8ab7e99478a7f4dd1a466b57bf33888e520d85c55780a5464c4b689",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 180_803_872,
      sha256: "417af53923f3d529759ab85ce3e8dd09116f742efcd332de591d2da6ebae696b",
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
      size: 69_113_309,
      sha256: "123ebd72609c4f8dbae0485cdac39b9aedfeb6576b2eef64f2e73152b1de82f4",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 194_103_008,
      sha256: "6d6a980039553a6b4efe2221fdbd5e8945abf3c2365d97fcab097713a327228f",
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
      size: 78_526_339,
      sha256: "8568230ccd847dc93e95b9f6894379077d3e014a16b48040743573e77c23e85f",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 211_340_280,
      sha256: "eba0da50d9cc22f2dd062c32e0e7e58d7ece301aa50aabdad1e9dba4ffbf25b4",
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
      size: 79_667_571,
      sha256: "849bd6b3d959a1d2ef200ed1634a51c79a45ca236aa26665d75debd694805cce",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 214_522_032,
      sha256: "538fcb1b6408c8d4608822acee19f7ff5b3a3eb3383c0633c4f06170857312a7",
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
      size: 177_770_992,
      sha256: "036a47ce2987adae04de827f7803bf0cc460bf169b640db168f18ec7acb734db",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 177_770_992,
      sha256: "036a47ce2987adae04de827f7803bf0cc460bf169b640db168f18ec7acb734db",
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
      size: 192_143_296,
      sha256: "24a951871bfb7b3f6036fc1e1cd2442c664e2b2eeba58de9e8f47de4c633a03e",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 192_143_296,
      sha256: "24a951871bfb7b3f6036fc1e1cd2442c664e2b2eeba58de9e8f47de4c633a03e",
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
      size: 165_548_280,
      sha256: "089a0acc2c1b570efcd791c5cd0f8aa074f6e8ab82c00ab78af0b934acdb6386",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 165_548_280,
      sha256: "089a0acc2c1b570efcd791c5cd0f8aa074f6e8ab82c00ab78af0b934acdb6386",
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
      size: 194_169_184,
      sha256: "ce33b1a29e37901f56fe59916cda7a1149e6fd377118f918e90d89f9abb52a51",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 194_169_184,
      sha256: "ce33b1a29e37901f56fe59916cda7a1149e6fd377118f918e90d89f9abb52a51",
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
