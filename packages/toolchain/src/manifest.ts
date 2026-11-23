/**
 * The agent CLIs. Each is installed only when its agent platform is enabled
 * (see `agentPlatformForToolchain`), and the container image carries the same
 * versions (see `tests/unit/version-drift.test.ts`).
 *
 * `opencode2` is OpenCode 2.x, the `opencode` platform's only binary. The
 * name is the toolchain's, not a platform's: it kept the name it had while it
 * was installed beside OpenCode 1.x, so installed toolchain directories stay
 * where they are.
 */
export const PINNED_TOOLCHAIN_VERSIONS = {
  claude: "2.1.326",
  codex: "0.169.0",
  grok: "1.0.88",
  opencode2: "2.3.1",
  pi: "1.5.2",
  antigravity: "1.5.12",
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
  gh: "2.104.0",
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

/**
 * Agent toolchains whose name is not an agent platform id, with the platform
 * that installs them. Every other agent toolchain is named after its platform.
 */
const TOOLCHAIN_PLATFORM_OVERRIDES: Readonly<Partial<Record<AgentToolchainName, string>>> = {
  opencode2: "opencode",
};

/**
 * The agent platform whose selection installs this tool.
 *
 * Toolchain names and agent platform ids used to coincide, and the selection
 * filters compared them directly. OpenCode's binary is named `opencode2`, so
 * every such filter goes through this instead: enabling `opencode` installs
 * `opencode2`. Support tools and unknown names map to themselves; no platform
 * has their id.
 */
export function agentPlatformForToolchain(name: string): string {
  return Object.hasOwn(TOOLCHAIN_PLATFORM_OVERRIDES, name)
    ? TOOLCHAIN_PLATFORM_OVERRIDES[name as AgentToolchainName]!
    : name;
}

/** The agent toolchains a platform installs, in manifest order; empty for SDK-only platforms. */
export function agentToolchainsForPlatform(platform: string): AgentToolchainName[] {
  return (Object.keys(PINNED_TOOLCHAIN_VERSIONS) as AgentToolchainName[]).filter(
    (name) => agentPlatformForToolchain(name) === platform,
  );
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
export const ANTIGRAVITY_RELEASE_BASE =
  `https://github.com/google-antigravity/antigravity-cli/releases/download/${PINNED_TOOLCHAIN_VERSIONS.antigravity}` as const;
export const GH_RELEASE_BASE =
  `https://github.com/cli/cli/releases/download/v${PINNED_SUPPORT_TOOL_VERSIONS.gh}` as const;

/**
 * Google's official Antigravity CLI release (`google-antigravity/antigravity-cli`
 * on GitHub). Each archive holds one `antigravity` executable; `agy` is the
 * documented command name, so it is exposed as an activation alias. Digests
 * were computed from the 1.5.12 release assets, whose published `sha256`
 * digests the archive values match.
 */
function antigravityArtifact(
  platform: ToolchainPlatform,
  architecture: ToolchainArchitecture,
  asset: string,
  archive: { size: number; sha256: string },
  executable: { size: number; sha256: string },
): ToolchainArtifact {
  return {
    name: "antigravity",
    version: PINNED_TOOLCHAIN_VERSIONS.antigravity,
    platform,
    architecture,
    archive: {
      format: "tar.gz",
      url: `${ANTIGRAVITY_RELEASE_BASE}/agy_cli_${asset}.tar.gz`,
      entryPath: "antigravity",
      size: archive.size,
      sha256: archive.sha256,
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    activationAliases: ["agy"],
    executable: { fileName: "antigravity", size: executable.size, sha256: executable.sha256 },
  };
}

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

/**
 * OpenCode 2.x publishes each platform's native binary as its own npm package
 * (`@opencode/cli-<target>`, the optional dependencies of `@opencode/cli`),
 * with the executable at `package/bin/opencode`. It is installed as
 * `opencode2`, the name it had beside OpenCode 1.x. These are the glibc
 * builds; upstream also publishes `-musl` and `-baseline` variants, which
 * nothing here uses.
 *
 * The darwin binaries are published with a valid signature, so they need no
 * local re-signing.
 */
function openCode2Artifact(
  platform: ToolchainPlatform,
  architecture: ToolchainArchitecture,
  archive: { size: number; sha256: string },
  executable: { size: number; sha256: string },
): ToolchainArtifact {
  const version = PINNED_TOOLCHAIN_VERSIONS.opencode2;
  const pkg = `cli-${platform}-${architecture}`;
  return {
    name: "opencode2",
    version,
    platform,
    architecture,
    archive: {
      format: "tar.gz",
      url: `https://registry.npmjs.org/@opencode/${pkg}/-/${pkg}-${version}.tgz`,
      entryPath: "package/bin/opencode",
      size: archive.size,
      sha256: archive.sha256,
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: { fileName: "opencode2", ...executable },
  };
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
      size: 113_553_246,
      sha256: "7f4c49c80bae1d0b4e347acfcdf11faa3475d87ae5e65a5eb1261d3c358145ee",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "aarch64-apple-darwin",
        {
          size: 25_315_336,
          sha256: "d40b320f6f256835d409472b7d3bee618a27549b3f3e1cb8b71dc6c56d3827bf",
        },
        {
          size: 70_426_256,
          sha256: "10feae2abe764bcf2273e241ace67aecc360eb8c28a82a2988bf1d8498a9bacf",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 280_704_736,
      sha256: "739cda86e15d30a6e2b40cf8dcbbfb988aaf48b305b27065573bb8e9fd41d002",
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
      size: 123_311_233,
      sha256: "6a2be05a75ecb88f92baf3e6988ce6efbe1d68341b68dac3ae505c4b8bbce475",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "x86_64-apple-darwin",
        {
          size: 27_340_411,
          sha256: "2dd3285f242ea9cb130281089eee3604a95a4a751b1ddf25aa3929c2a488a79e",
        },
        {
          size: 74_491_440,
          sha256: "f03490828eb48754f722b14b0d39e7f6d3796293c72680390b2ca03af18dcdb1",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 301_125_104,
      sha256: "e57da7be8695c079d2d1d156dab79708e43ebb6cf7e34527b8b01d6aa942788e",
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
      size: 119_987_185,
      sha256: "97b97d87eea075c5cb7709c7f6156a451622a7667953ecda40e0276637196f3f",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "aarch64-unknown-linux-musl",
        {
          size: 27_557_217,
          sha256: "059397e4d5beda7a7acc7441a6a56457d0f79e1001d129976ac0d26b0e6ee04c",
        },
        {
          size: 72_018_272,
          sha256: "66874c7881c4004f1c155584e1325cad17795bdd91b886995ad8a043809c1019",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 290_069_784,
      sha256: "3bb41c9a80187773e2a59278d4fc355b1a163c31bb5a79581e37d4fe428af047",
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
      size: 117_805_733,
      sha256: "9af4d751fce183faedea629437d5252dbf458eeb04130cf4f97be844621ea985",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "x86_64-unknown-linux-musl",
        {
          size: 27_390_073,
          sha256: "cbed6a8d25e8268792b757767fbc76d4c62e84bcf8ee4a63f97547f0de3aaceb",
        },
        {
          size: 70_023_704,
          sha256: "e9f2ef68671b2b6ac68902d19e8dafda3f5928e678ecf3f30c74b203a2c403ed",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 294_277_432,
      sha256: "b452ca20f838a8855a88a41050ee4a694033fff4ea3ecdad5633e6e0e8d13f2b",
    },
  },
  openCode2Artifact(
    "darwin",
    "arm64",
    {
      size: 109_080_555,
      sha256: "b01885024413cc021aa0ecc359a2f397217f74121f43569b318e192058f34f47",
    },
    {
      size: 225_750_880,
      sha256: "25b6895db61be9a429ecc5513ca21ec4f5cbf62d6039950dd72e5aab6b9b319d",
    },
  ),
  openCode2Artifact(
    "darwin",
    "x64",
    {
      size: 114_447_514,
      sha256: "6952e3e3a786967f05f5d4887e177e967ef4e940353bdfed5440410f02702a4b",
    },
    {
      size: 240_468_704,
      sha256: "235a6377bf3dbef847eb9828efb8bca1666d04b9b699cc67d50b029d6c6f2d99",
    },
  ),
  openCode2Artifact(
    "linux",
    "arm64",
    {
      size: 120_539_224,
      sha256: "97c127e0f17afd4a0110490aee5728e9047bba201bb132b2ebbcc724831a0aeb",
    },
    {
      size: 247_843_832,
      sha256: "7f6127effa38a997d22a518e75fea5cf664f35ddc6a7a29850653aea5ec5b234",
    },
  ),
  openCode2Artifact(
    "linux",
    "x64",
    {
      size: 122_080_965,
      sha256: "020e4bdadf62962f806f75393657ed26d462debec8e34ee7d3b6e0cb3b45c783",
    },
    {
      size: 252_848_304,
      sha256: "1a8ef837bb8bdd06f2e16e0ed1a49b05aefb96b95102834dbb178cdd6223205d",
    },
  ),
  {
    name: "claude",
    version: PINNED_TOOLCHAIN_VERSIONS.claude,
    platform: "darwin",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: claudeArchiveUrl("darwin-arm64"),
      entryPath: "package/claude",
      size: 160_222_918,
      sha256: "bda994b80919b5df9588b81c98b8f8a08aa4ca6ba605efda74679ed8571e8136",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 353_037_664,
      sha256: "e214ad76dcc0e846b03be28ed1c2734aacd4e27acb527cb7f8a9e2bed644e837",
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
      size: 166_954_861,
      sha256: "acf630622c93c5c2fffba532d540fa88f8f8ec04dbb0e60fc8639f28aa6ab1d3",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 367_809_664,
      sha256: "bd8e26290f93353590b831600a7ced02d625018fbaa2a82d8817368d3e2d2f82",
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
      size: 172_607_583,
      sha256: "04c707c086ee47fd5732c9c140df8d1dbf3167c4d5846b8a22f5acb7cfb9a584",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 370_271_672,
      sha256: "98d56f6ffe53469767a74864a38eaf359d62ef557a8de1b1ad524d61a66ec119",
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
      size: 171_802_778,
      sha256: "113a6b58f9ee5a94b8bb841252070f60ff5f295b3d28c7f40b480a5b54f5579b",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 371_429_904,
      sha256: "b6b3647d981130dc44fc670846ae97b6cde531ffb667cf9c4d17cfcafb38cb37",
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
      size: 190_316_800,
      sha256: "b0185133b3362c406069653e40c9864876342fd6d667555e0438f7f26a1f785e",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 190_316_800,
      sha256: "b0185133b3362c406069653e40c9864876342fd6d667555e0438f7f26a1f785e",
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
      size: 205_060_992,
      sha256: "4ec4d61a50d1aff49139bc0c84878d0b37e9b62949eb45c561fd57ed52305739",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 205_060_992,
      sha256: "4ec4d61a50d1aff49139bc0c84878d0b37e9b62949eb45c561fd57ed52305739",
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
      size: 177_315_832,
      sha256: "55f285af4b68fe53cc2f45b00a4392c8c4871509671e0185e0237804194ccf29",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 177_315_832,
      sha256: "55f285af4b68fe53cc2f45b00a4392c8c4871509671e0185e0237804194ccf29",
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
      size: 207_586_272,
      sha256: "a33013fe73ea63d2f18df636f90f84060a88712f9932b77cda0447dd83b4bfe5",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 207_586_272,
      sha256: "a33013fe73ea63d2f18df636f90f84060a88712f9932b77cda0447dd83b4bfe5",
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
        totalSize: 7_577_777,
        sha256: "a4edb38df71da0d8d4e5e96c0c5b90f5e28b9bcea29b9798485b66a91b5cdb24",
      },
      size: 48_068_183,
      sha256: "56b5e194d485ced555667b8ba3276157a8272e9ecde9e001e428af80985bdd9b",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 103_046_498,
      sha256: "a9e9d1f07b9a36f40948e67cd242952d0dea40a625167996b72b13db810b4cdc",
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
        totalSize: 7_548_537,
        sha256: "81915c51fb9d59ab20cbc23e59eb67e8112b2048442da71682309e0f6b0c1fbe",
      },
      size: 50_580_945,
      sha256: "f997a088613514ac97d913aeea7642094d84fe6d46854ff7e64e2c12e536dc50",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 111_947_232,
      sha256: "8b77c6dc77e0700be1c4fd7588e59ffdad1b5a032ed521c1a07a3db6ef370b3b",
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
        totalSize: 7_592_993,
        sha256: "19b98d120e917b848f7c14eb706315a09233fe13c639824cf6fe3cf9a790aa68",
      },
      size: 58_790_707,
      sha256: "42805cd5615952fcbbfc9c56b04f8feb84395134952e169a6cdc8d7676975666",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 122_997_752,
      sha256: "4bb73af6ef989023e0f3c39d6fd6e8c6c6b886cc7098462aff193d56d0a4a54f",
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
        totalSize: 7_543_761,
        sha256: "dba4ab5047850e8f33303b1efe1114e9f804d7837d10b9d13d98ae8f57727fb9",
      },
      size: 58_922_566,
      sha256: "811c6f2c9e7aaee252b5404252e556fb713aa209c1f7f924226aa77d4ef70cb5",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 122_902_704,
      sha256: "6a2ac1c5b0d08b91ce6095591c1960b469d0665c7fc5f32812960a4a17ca0c57",
    },
  },
  antigravityArtifact(
    "darwin",
    "arm64",
    "mac_arm64",
    {
      size: 85_295_784,
      sha256: "fa2bb0e6646db70e6610ed41382f9ff23e260b8f649427c4ef1361aaa8a8dbcb",
    },
    {
      size: 226_575_952,
      sha256: "ef265356c3e5d3c6c241509cf71187bae086ac935ef5c5c037dadf62d5876835",
    },
  ),
  antigravityArtifact(
    "darwin",
    "x64",
    "mac_x64",
    {
      size: 90_841_040,
      sha256: "934b7023768637cd2f827bcb76b0c38875a8beb3502845ef1daa2f125cf458f0",
    },
    {
      size: 235_589_664,
      sha256: "e68e771e3e8ca4f7811e95f9494a10b9a87c09931b644833c688d5184ad40233",
    },
  ),
  antigravityArtifact(
    "linux",
    "arm64",
    "linux_arm64",
    {
      size: 91_394_923,
      sha256: "594046de1b91561f7fe16476365e3843038ecca56f5f59af45cf9d3091e43bd4",
    },
    {
      size: 253_055_664,
      sha256: "f8bb8d22dfb676ac0a69effe534283274f860095bfdca62a7caa69de459784ed",
    },
  ),
  antigravityArtifact(
    "linux",
    "x64",
    "linux_x64",
    {
      size: 100_322_406,
      sha256: "0f0cb851cdc9fbedd50432570aa6ae9c4c398b9ea3f1e23e7776f707643c5b3e",
    },
    {
      size: 269_443_784,
      sha256: "94104f028e6962fa2f71d393a7ae27d835ceba1c4898422a103e22c6a5fd6828",
    },
  ),
  ghArtifact(
    "darwin",
    "arm64",
    {
      size: 14_087_367,
      sha256: "23b12706219b9892e44236f988444a24adcf29284e16b35e03ba5b863fb6eb8e",
    },
    {
      size: 38_918_208,
      sha256: "f91ac17c5d4ea4c5e943e3af2723e04cf35d6a5626d38a6f4567e36cfc69abd5",
    },
  ),
  ghArtifact(
    "darwin",
    "x64",
    {
      size: 15_683_594,
      sha256: "a8c2a708dbae89dc7c05ba7b0beafc95bd8d09ab4a3505467b77d32ebf364dc6",
    },
    {
      size: 42_147_680,
      sha256: "5c8fd50bd8371289df00142e3638860b540d26c0ca228fb43da6c01146d5fd08",
    },
  ),
  ghArtifact(
    "linux",
    "arm64",
    {
      size: 13_642_444,
      sha256: "cb34cefc6f4e77b90731374a2b737516bb8f3033c6ca46aa949e5344f68069e3",
    },
    {
      size: 38_142_112,
      sha256: "f5ea822b80129fd841cce54df49f699e3a019dade3d70b48255807ca33a6eefa",
    },
  ),
  ghArtifact(
    "linux",
    "x64",
    {
      size: 15_007_172,
      sha256: "98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e",
    },
    {
      size: 41_083_040,
      sha256: "fca7ac8a8386e3ad65c9a96a96cbf272d1dcc4f76de174dae91d54e50729e240",
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
 * Each artifact reaches its platform through `agentPlatformForToolchain`, so
 * `opencode` selects `opencode2`. Keeping the filter here means the
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
    (artifact) =>
      selected.has(agentPlatformForToolchain(artifact.name)) || isSupportToolName(artifact.name),
  );
}
