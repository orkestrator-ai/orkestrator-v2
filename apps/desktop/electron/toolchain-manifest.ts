export const PINNED_TOOLCHAIN_VERSIONS = {
  claude: "2.1.228",
  codex: "0.147.0",
  opencode: "1.18.16",
} as const;

export type ToolchainName = keyof typeof PINNED_TOOLCHAIN_VERSIONS;
export type ToolchainPlatform = "darwin" | "linux";
export type ToolchainArchitecture = "arm64" | "x64";
export type ToolchainArchiveFormat = "tar.gz" | "zip";

type InstalledExecutableIntegrity =
  | {
      installedSize: number;
      installedSha256: string;
    }
  | {
      installedSize?: undefined;
      installedSha256?: undefined;
    };

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
     * artifacts retain a read-only, manifest-pinned copy of the upstream bytes
     * and regenerate the locally signed executable from it on every startup.
     * See `toolchain-manager.ts`.
     */
    repairInvalidMacSignature?: boolean;
  } & InstalledExecutableIntegrity;
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
      size: 87_984_231,
      sha256: "75984b81f92a71b0c0f4b3b5cad80e5c57177e4d8c8b4b1e13db703b20dc4358",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
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
    matches.length !== expectedNames.length
    || expectedNames.some((name) => !matchedNames.has(name))
  ) {
    throw new Error(`Pinned toolchain manifest is incomplete for ${platform}-${architecture}`);
  }
  return matches;
}

export function pinnedToolchainArtifacts(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): readonly ToolchainArtifact[] {
  return selectPinnedToolchainArtifacts(
    PINNED_TOOLCHAIN_ARTIFACTS,
    platform,
    architecture,
  );
}
