/**
 * The agent CLIs. Each is installed only when its agent platform is enabled
 * (see `agentPlatformForToolchain`), and the container image carries the same
 * versions (see `tests/unit/version-drift.test.ts`).
 *
 * `opencode2` is OpenCode 2.x, pinned beside the 1.x `opencode` while the
 * OpenCode platform moves to it (docs/todo/agent-engines/0008-opencode-v2.md).
 * It is a second binary of the `opencode` platform, not a platform of its own.
 */
export const PINNED_TOOLCHAIN_VERSIONS = {
  claude: "2.1.319",
  codex: "0.167.0",
  grok: "1.0.77",
  opencode: "1.19.5",
  opencode2: "2.2.6",
  pi: "1.5.0",
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
 * filters compared them directly. OpenCode needs two binaries (1.x and 2.x)
 * under one platform, so every such filter goes through this instead:
 * enabling `opencode` installs both `opencode` and `opencode2`. Support tools
 * and unknown names map to themselves; no platform has their id.
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

/**
 * OpenCode 2.x publishes each platform's native binary as its own npm package
 * (`@opencode/cli-<target>`, the optional dependencies of `@opencode/cli`),
 * with the executable at `package/bin/opencode`. It is installed as
 * `opencode2` so it can share an activation directory with the 1.x
 * `opencode`. These are the glibc builds; upstream also publishes `-musl` and
 * `-baseline` variants, which nothing here uses.
 *
 * The darwin binaries are published with a valid signature, so unlike the 1.x
 * release zips they need no local re-signing.
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
      size: 108_379_331,
      sha256: "4b22a2a971be2791c3e31f912f3e77a88ebd64a65812a7289ccba65dd6425fe9",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "aarch64-apple-darwin",
        {
          size: 25_262_553,
          sha256: "876a3e263348ef0edaeae5cf5bc52a5c121141cefd15157ab0eeca305f3eb563",
        },
        {
          size: 70_259_040,
          sha256: "5cc29d144fc05e3563f5f90c36adc95bdc287e2297b48ecf0bf4abdf1892d3ab",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 270_815_376,
      sha256: "030316ecfbb41f4e7946e584b0063ef333b7a36cd312ba349f2f6869e39b62cc",
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
      size: 117_941_240,
      sha256: "d8eb4a865a0b17319cde10347523e5bab0978d01725b39f4a639f40905e01221",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "x86_64-apple-darwin",
        {
          size: 27_285_629,
          sha256: "612d0dc2c7316fbf05ee922796f4d740a285b76a55d4c78e1b946ba621bdcc91",
        },
        {
          size: 74_373_824,
          sha256: "5b007ad8735633f955c0b7b801d02858b3c75f0f5f2cf5864f12da96ca422e69",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 290_491_520,
      sha256: "a3b4df639ed5808100fe9d3dacdb324c9fb50b2804d72d5ab59def67bb2d6ab6",
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
      size: 114_300_898,
      sha256: "843489acb4d4b1079745c36b03c5963b887b83155af208fd53584e33ee8eb281",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "aarch64-unknown-linux-musl",
        {
          size: 27_500_578,
          sha256: "6e99948fa20ca816a01f222a56afa261b321e00cbed611d76bb92c765fd11ec6",
        },
        {
          size: 71_821_664,
          sha256: "e7b772ff332c16ca2df587e99fe87f217e3ab3432a63846fb1ca1bccbaa24409",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 278_794_648,
      sha256: "2fe94d848540ff2a6868c7ebcc494126a974aa409711676d14fa0379e49e6143",
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
      size: 122_587_028,
      sha256: "9d64836106d5b374e90ee4454c7ebcde7ca7106558bd7e41a34b9f26ebda251a",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    companions: [
      codexCodeModeHost(
        "x86_64-unknown-linux-musl",
        {
          size: 29_079_293,
          sha256: "b5074d5dd64643b2c073927e494a588eff31c1f5a27f12c1e2c45f9a6cf07dd4",
        },
        {
          size: 79_209_744,
          sha256: "83f3e174c2da2f1ca8655cce686e302509640d34c0f4407c1155056f64536e0f",
        },
      ),
    ],
    executable: {
      fileName: "codex",
      size: 320_575_976,
      sha256: "cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda",
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
  openCode2Artifact(
    "darwin",
    "arm64",
    {
      size: 108_258_354,
      sha256: "613ebb74dd8eff767bb9d442a37b40c4d9946ba27f1538985068a1b9678137a3",
    },
    {
      size: 231_791_968,
      sha256: "90e4d03597b03d2051b65b4d793467764e55bacd8e22bf4824479c7233ea0e15",
    },
  ),
  openCode2Artifact(
    "darwin",
    "x64",
    {
      size: 113_659_134,
      sha256: "4f1475c0b642ece32681dbd4a2fd5f7c1ef6183dced0ecac3861cb3d18a49a15",
    },
    {
      size: 246_528_608,
      sha256: "6273561d1f9b3ff20d350aba47874fd12b2c4aed7ee62c1979f579c9570ef1fc",
    },
  ),
  openCode2Artifact(
    "linux",
    "arm64",
    {
      size: 119_688_147,
      sha256: "22352e200630ec61a48a65b9f5c2b627328ae5002658d81c067f67c5fb689898",
    },
    {
      size: 253_873_144,
      sha256: "ce4f5e7502b6e32ccd8b05654410e8e8607b9660737222b0b1279621bcea2b03",
    },
  ),
  openCode2Artifact(
    "linux",
    "x64",
    {
      size: 121_218_733,
      sha256: "dfcd69f1d511ae10ed626768b41d84b8100cc4aa64cecb69da38ba7a29d33551",
    },
    {
      size: 258_824_368,
      sha256: "50503d24577fa4117a7c95ee85b2cd679606a87eacf20ca54ed5db5c9e1cf895",
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
      size: 146_936_950,
      sha256: "15d4176d3186db97836842e2c903c4a8d614246d8cb19b7bef2e5a2a4ed86e16",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 321_995_200,
      sha256: "1f53587e92dee8e089fa349188a4cda64fa34ace6e7b0ca2ee278ddaa3cc2ebd",
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
      size: 153_322_707,
      sha256: "2fc9458395d7136871e81274d668b543c188b911bcaa05002c6915a378676f0c",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 336_699_808,
      sha256: "af6f1f5510ae98d56a155bf8f007aa9d5b44efccc9c10c8e10ef35039e95a940",
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
      size: 159_464_104,
      sha256: "f1ce44ea6a383ff39463e82906ad2d9d6fe1bc92976d2ac38da965b15a6f8036",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 339_797_432,
      sha256: "a7e687fd1cb054d651c7588223de3786c99d4c682365e3c3ae1e59ce7f3a591f",
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
      size: 158_448_451,
      sha256: "9b7b53954b8ffb886fafeefe9ef1e0e9e5c15e8aaf2f54d65ba64d0cca795dc7",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 340_226_576,
      sha256: "dabafec82ca1319fa43d8be36a10fc61b1d11821cb98ad5df04ad95e199b8eed",
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
      size: 184_995_488,
      sha256: "197c66a63e5ac46e07450b0ca21d141ce665050a412180f185dadfae1c7a5b2a",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 184_995_488,
      sha256: "197c66a63e5ac46e07450b0ca21d141ce665050a412180f185dadfae1c7a5b2a",
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
      size: 199_654_320,
      sha256: "7728f79ea713ae67a4fa4736dcf808f6b386d9642202aea1df695073fa56675a",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 199_654_320,
      sha256: "7728f79ea713ae67a4fa4736dcf808f6b386d9642202aea1df695073fa56675a",
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
      size: 171_935_112,
      sha256: "b30eee14a656124ef3c9da8577b5e783ef2cffabeb2b679c5c49633e77eed574",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 171_935_112,
      sha256: "b30eee14a656124ef3c9da8577b5e783ef2cffabeb2b679c5c49633e77eed574",
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
      size: 201_655_392,
      sha256: "b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a",
      allowedHosts: GROK_DOWNLOAD_HOSTS,
    },
    executable: {
      fileName: "grok",
      size: 201_655_392,
      sha256: "b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a",
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
        totalSize: 7_528_005,
        sha256: "648ac010614fceea78e761989fa0265204349c014b5b206c47abe1cbb72ddb6f",
      },
      size: 48_027_930,
      sha256: "a9bf0d82d58d2a7d337f4ae4171b5fc9ebffe42509527a831364c4b65adf2cdf",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 102_864_866,
      sha256: "9fa16dd5c093aaa74a17ccd8c10e337addcbe08e6f21797ef6de8006017addd8",
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
        totalSize: 7_498_765,
        sha256: "977f7ea9a655d53e6ad7f7b6f1fd9d7f5cc102e1698dbae06de4248fae76095d",
      },
      size: 50_541_720,
      sha256: "f41b26cd9a1754abe259e05a421fb33b00936779cb0783c893a6389d1bd2ee0d",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 111_767_008,
      sha256: "b36706f3ed105a7d027b749bbcf59a6b70ad6aa87ccb08a9091578c854201e15",
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
        totalSize: 7_543_221,
        sha256: "22674434c0a2084ab84913ad8ee9ae07d494ed13d6f6fcba7aa74fdbf3107a16",
      },
      size: 58_742_522,
      sha256: "5d5711b48600756473682e86360b026b11abf7591e5d112eb411d4da2c100d9a",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 122_801_144,
      sha256: "c02415a4187997ad2bd5d3dfc841d54aa17c229bb12f598fe012de9ad6d1b2de",
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
        totalSize: 7_493_989,
        sha256: "bdd56986b4ec1e371a0e75bd9f369ae6080675ee0ff9f2e4400bf02de681a99a",
      },
      size: 58_876_253,
      sha256: "df870ba0e344cb7b3358d8d8f19397b8b8d225a8669784736ad68a5c2169d53b",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "pi",
      size: 122_726_576,
      sha256: "61a84400938da652ed69aac9c1ad2ca23af3c9bd8cc2f46ce571ed84ae6a35e5",
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
 * Each artifact reaches its platform through `agentPlatformForToolchain`, so
 * `opencode` selects both OpenCode binaries. Keeping the filter here means the
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
