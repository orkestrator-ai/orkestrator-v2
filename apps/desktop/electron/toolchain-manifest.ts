export const PINNED_TOOLCHAIN_VERSIONS = {
  claude: "2.1.219",
  codex: "0.145.0",
  opencode: "1.18.4",
} as const;

export type ToolchainName = keyof typeof PINNED_TOOLCHAIN_VERSIONS;
export type ToolchainPlatform = "darwin" | "linux";
export type ToolchainArchitecture = "arm64" | "x64";
export type ToolchainArchiveFormat = "tar.gz" | "zip";

export type ToolchainArtifact = {
  name: ToolchainName;
  version: string;
  platform: ToolchainPlatform;
  architecture: ToolchainArchitecture;
  archive: {
    format: ToolchainArchiveFormat;
    url: string;
    entryPath: string;
    size: number;
    sha256: string;
    allowedHosts: readonly string[];
  };
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
     * artifacts are verified against `sha256` before the repair and recorded in
     * an on-disk install record afterwards. See `toolchain-manager.ts`.
     */
    installedSize?: number;
    installedSha256?: string;
    repairInvalidMacSignature?: boolean;
  };
};

const GITHUB_RELEASE_HOSTS = [
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
] as const;
const NPM_REGISTRY_HOSTS = ["registry.npmjs.org"] as const;

// Release bases are derived from PINNED_TOOLCHAIN_VERSIONS so a version bump
// cannot leave a stale version behind in a URL. `scripts/download-codex.sh` and
// `scripts/download-opencode.sh` build the same URLs; tests/unit/version-drift.test.ts
// asserts the two stay in step.
export const CODEX_RELEASE_BASE =
  `https://github.com/openai/codex/releases/download/rust-v${PINNED_TOOLCHAIN_VERSIONS.codex}` as const;
export const OPENCODE_RELEASE_BASE =
  `https://github.com/anomalyco/opencode/releases/download/v${PINNED_TOOLCHAIN_VERSIONS.opencode}` as const;

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
      size: 102_106_051,
      sha256: "072a30a65f05666735889ef0f60b56db186adbdde9d5c5cc1a64be0b598530fe",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "codex",
      size: 271_134_288,
      sha256: "1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590",
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
      size: 111_434_065,
      sha256: "4216d7a40aa49d74b65fab93d2a86d2e25a902482b827dbdb3f357777b09fadf",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "codex",
      size: 294_456_976,
      sha256: "6db9193ce2c9a8cef2b5482612cde24202a4329dfc34f4687a036d5d7da619af",
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
      size: 105_110_610,
      sha256: "d384f90bc842450b42bd675feef06a12a46a3b1ca97efcb22566b270e4a11227",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "codex",
      size: 269_360_944,
      sha256: "57d79900fe95df2ab854adf581a28ec46d7442f07445032d86453a44b577dced",
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
      size: 113_724_150,
      sha256: "bfaf13c9ba34f2ad764e4a916c49cf7177aeba329cf0f719e2227566fc8d662a",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "codex",
      size: 310_730_800,
      sha256: "a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14",
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
      size: 44_901_748,
      sha256: "04fb881b632b323c712dfda6dcbbc6fce736394f07ba76176e52d6665925d4e6",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 138_295_010,
      sha256: "9449af91f517eacc2b0742fa93ae0da64fa6e5db7b714e30c62edea2a8de3f98",
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
      size: 47_141_113,
      sha256: "e177c532654572079981db1dce464a78adbaed9654a142848b2e81beb8c9f5c6",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 143_835_216,
      sha256: "65fda83fe8f2c40884f237e5e2116f6fdb3633927d76ad91206e4a8c07d389e5",
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
      size: 59_079_134,
      sha256: "eba87efba3976d533a24cca0316f8ef375b5f8e797c0a95c25ee919700b7ba35",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 178_432_144,
      sha256: "3557e87db8c7db70e8ebd42157df1246554120896b115c462b760ff248cf751e",
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
      size: 59_265_621,
      sha256: "bab463c3fb3224d388bb7cfad63f38703df9cf0be2cfd2ce8cb49d886b53a174",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 178_907_264,
      sha256: "6ce6570e7db9a40e7bd3304ebdfff607920bde8cafd2eb5587bd7a26f89ba0b5",
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
      size: 74_831_594,
      sha256: "36a0a1e56ac982f3122c88fc836f69a9d139975ceb9b5ddf44e2b01f75998bda",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 256_908_272,
      sha256: "a8e806faaefac53c7a0f26523d8a45c60dbef3407b14ef990c75765d08febc82",
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
      size: 79_277_633,
      sha256: "970f8f3c79063f0dae7e42fe7876c14e2c704764409cf814bb21b48a068c4dc8",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 266_381_200,
      sha256: "03be9f988ed88391b4a5f08e4c5dc317ce2fffa4a9dc66c01106326e7698ee76",
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
      size: 84_599_316,
      sha256: "cf4ae671f08b91ac75ea63c8497e7ff4e3bdbe522b0f83bff2de162d44e0eb15",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 271_825_824,
      sha256: "1f834b322ba9d1291cc7ffeff16a6795a59145bda279dbd59cd7ecebc7b7f15a",
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
      size: 85_102_823,
      sha256: "4faa88f49c8d4de1a6089c6208f8f9c5b0392597cabed0a553d608aae0097aa7",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 275_004_400,
      sha256: "22cfd6f5b3061c0391ba84e9cf8c9deaa37783aac18b004d42ec061e98f00691",
    },
  },
] as const;

export function pinnedToolchainArtifacts(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): readonly ToolchainArtifact[] {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Unsupported toolchain platform: ${platform}`);
  }
  if (architecture !== "arm64" && architecture !== "x64") {
    throw new Error(`Unsupported toolchain architecture: ${architecture}`);
  }

  const matches = PINNED_TOOLCHAIN_ARTIFACTS.filter(
    (artifact) => artifact.platform === platform && artifact.architecture === architecture,
  );
  if (matches.length !== Object.keys(PINNED_TOOLCHAIN_VERSIONS).length) {
    throw new Error(`Pinned toolchain manifest is incomplete for ${platform}-${architecture}`);
  }
  return matches;
}
