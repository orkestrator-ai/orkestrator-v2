export const PINNED_TOOLCHAIN_VERSIONS = {
  claude: "2.1.207",
  codex: "0.144.1",
  opencode: "1.17.18",
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
    size: number;
    sha256: string;
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

export const PINNED_TOOLCHAIN_ARTIFACTS: readonly ToolchainArtifact[] = [
  {
    name: "codex",
    version: PINNED_TOOLCHAIN_VERSIONS.codex,
    platform: "darwin",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-aarch64-apple-darwin.tar.gz",
      entryPath: "codex-aarch64-apple-darwin",
      size: 98_299_911,
      sha256: "88e72ac8bd30815f7d18e62dac333dc20ce3ad1cba94be1649a1977dd9bfdbb8",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "codex",
      size: 260_405_808,
      sha256: "29915529b97697def1a957b0505e770aa6a45744435d62fc263e98d7619e167a",
    },
  },
  {
    name: "codex",
    version: PINNED_TOOLCHAIN_VERSIONS.codex,
    platform: "darwin",
    architecture: "x64",
    archive: {
      format: "tar.gz",
      url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-x86_64-apple-darwin.tar.gz",
      entryPath: "codex-x86_64-apple-darwin",
      size: 107_297_255,
      sha256: "0ea72d21c794504342d5fe0d5d057b0221c0a42f4bdf4a48b95af243af2b0c0e",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "codex",
      size: 282_836_688,
      sha256: "c6eb747e4145ecb3bed2647dbd0f8464b190a5ccba964666ef7c98d4681a4a4c",
    },
  },
  {
    name: "codex",
    version: PINNED_TOOLCHAIN_VERSIONS.codex,
    platform: "linux",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-aarch64-unknown-linux-musl.tar.gz",
      entryPath: "codex-aarch64-unknown-linux-musl",
      size: 101_162_076,
      sha256: "b9f8ef5f98e46ced4dbbd3756a4223e3ee299a457ff488a3305bea455da8b5b8",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "codex",
      size: 259_006_256,
      sha256: "9513fa3f5f4ad444ac1e40d972aef0e2664834ec54da987d54aba0dc2f13ea07",
    },
  },
  {
    name: "codex",
    version: PINNED_TOOLCHAIN_VERSIONS.codex,
    platform: "linux",
    architecture: "x64",
    archive: {
      format: "tar.gz",
      url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-x86_64-unknown-linux-musl.tar.gz",
      entryPath: "codex-x86_64-unknown-linux-musl",
      size: 109_308_813,
      sha256: "84091ae20c65fcc7d4120db97d1bd57d7ff8df9c7609fb781c78c2ebbd4f5a28",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "codex",
      size: 298_520_624,
      sha256: "a96f944d1a596dbfb7fdd84f482be5c50e34b04bb371126840d873e4ebf26902",
    },
  },
  {
    name: "opencode",
    version: PINNED_TOOLCHAIN_VERSIONS.opencode,
    platform: "darwin",
    architecture: "arm64",
    archive: {
      format: "zip",
      url: "https://github.com/sst/opencode/releases/download/v1.17.18/opencode-darwin-arm64.zip",
      entryPath: "opencode",
      size: 55_170_827,
      sha256: "24327f89c103526c0518fc9b797767f318ab85ef3cee8636e722d6138f33aa3d",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 148_548_962,
      sha256: "652a34cab759c0fa348f107aa737df86355a49b1576834864e89ee43c059b25d",
      installedSize: 147_703_472,
      installedSha256: "e59da044bb2fd972041d4f8edab2f9f6120599889bc9d05e938f9aa7fe0e9ed5",
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
      url: "https://github.com/sst/opencode/releases/download/v1.17.18/opencode-darwin-x64.zip",
      entryPath: "opencode",
      size: 57_332_427,
      sha256: "cebf209aad2c0bd998fbac3f8dd1b45eef35da1af18cd698e78b111b73c5fbb0",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 154_009_680,
      sha256: "8233ebc1e356ab37a5b2859cbed720d9c5e5256f83433739f7eb666a8738e50d",
    },
  },
  {
    name: "opencode",
    version: PINNED_TOOLCHAIN_VERSIONS.opencode,
    platform: "linux",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: "https://github.com/sst/opencode/releases/download/v1.17.18/opencode-linux-arm64.tar.gz",
      entryPath: "opencode",
      size: 69_231_902,
      sha256: "db9b53eae485da969a0a855bca465f9901dd84676384f724f320e3ccc5a9b107",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 188_459_152,
      sha256: "04c086b67374714705ad0db04dfd93d28e6b2707ff7c803aaed1ba991effa8cc",
    },
  },
  {
    name: "opencode",
    version: PINNED_TOOLCHAIN_VERSIONS.opencode,
    platform: "linux",
    architecture: "x64",
    archive: {
      format: "tar.gz",
      url: "https://github.com/sst/opencode/releases/download/v1.17.18/opencode-linux-x64.tar.gz",
      entryPath: "opencode",
      size: 69_427_073,
      sha256: "e149d32ee5667c0cd5fb84d0bf8393b312e93782eeb4d74d29bbb0392de7133c",
      allowedHosts: GITHUB_RELEASE_HOSTS,
    },
    executable: {
      fileName: "opencode",
      size: 188_979_328,
      sha256: "0cbfb6de55aa4ce3c74da12d8516376033693a88abca6238c5be32bf98130636",
    },
  },
  {
    name: "claude",
    version: PINNED_TOOLCHAIN_VERSIONS.claude,
    platform: "darwin",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.207.tgz",
      entryPath: "package/claude",
      size: 71_226_970,
      sha256: "49559d5e1debf69b52289ac867faaa64efcfd7c47810fca347fa0697e578153c",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 241_237_136,
      sha256: "1397a062c6889675055e3314dd956376ac51262a7734ad9e819c26975d71547a",
    },
  },
  {
    name: "claude",
    version: PINNED_TOOLCHAIN_VERSIONS.claude,
    platform: "darwin",
    architecture: "x64",
    archive: {
      format: "tar.gz",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-x64/-/claude-code-darwin-x64-2.1.207.tgz",
      entryPath: "package/claude",
      size: 74_267_258,
      sha256: "6302286147ea0abfe9ac632b665a76820ea11e54328101c7f4e13767ca0046dc",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 249_273_680,
      sha256: "8a4355d251a60c90d8cf08f32fdb22a8157dd3d085542f95d0da0475f9a2c57c",
    },
  },
  {
    name: "claude",
    version: PINNED_TOOLCHAIN_VERSIONS.claude,
    platform: "linux",
    architecture: "arm64",
    archive: {
      format: "tar.gz",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64/-/claude-code-linux-arm64-2.1.207.tgz",
      entryPath: "package/claude",
      size: 80_062_840,
      sha256: "02c381be3269489119287dc0b5f4b99b870d886f058918994b51e06b701dd1be",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 256_228_080,
      sha256: "8bc14a284065383460f37981d724b8f7aa7ca93c9849d2fe367e08f03383f454",
    },
  },
  {
    name: "claude",
    version: PINNED_TOOLCHAIN_VERSIONS.claude,
    platform: "linux",
    architecture: "x64",
    archive: {
      format: "tar.gz",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.207.tgz",
      entryPath: "package/claude",
      size: 80_568_612,
      sha256: "862d403aa07a49548215fb8b1255cb5a66fd31601e33e13bc8e6925526d242c0",
      allowedHosts: NPM_REGISTRY_HOSTS,
    },
    executable: {
      fileName: "claude",
      size: 259_402_552,
      sha256: "85e7e988a392d859f90802ca21fb26e89d3c9ab527f5ed0b08df3955e34d5c83",
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
