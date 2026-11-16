import path from "node:path";

/**
 * Every bridge the standalone package carries, and how.
 *
 * A bridge resolves at runtime from `resourceRoot/<name>`, so one this package
 * leaves out builds and publishes fine and then reports "bridge directory not
 * found" the first time a user picks that platform. `tests/cli.test.ts` checks
 * this table against every buildable bridge under `bridges/`.
 *
 * Two shapes:
 *
 * - **Bundled** bridges ship complete. Anything left `external` must be a
 *   dependency of this package (`tests/cli.test.ts` enforces that). The Claude
 *   bridge's own build keeps the Agent SDK external; this one inlines it, so
 *   installing the package never pulls the SDK's optional platform packages
 *   (each a whole Claude Code binary of about 320 MB that the bridge never
 *   runs: it always passes `CLAUDE_CLI_PATH` as `pathToClaudeCodeExecutable`).
 * - **On-demand** bridges ship their own bundled code, but not the SDK they
 *   keep external. Those SDKs cannot be inlined (Cursor's loads code-split
 *   chunks at runtime and carries a per-platform native package; Pi's closure
 *   is ~175 MB), so each ships a pinned manifest and lockfile under
 *   `resources/<name>/runtime/` instead, and the backend installs it into its
 *   data directory the first time the bridge starts
 *   (`apps/backend/src/core/bridge-runtime-install.ts`).
 */
export interface BundledBridge {
  name: string;
  external: string[];
}

export interface OnDemandBridge {
  name: string;
  /** The packages the bridge's own build keeps external; installed on demand. */
  external: string[];
}

export const BUNDLED_BRIDGES: readonly BundledBridge[] = [
  { name: "claude-bridge", external: [] },
  { name: "codex-bridge", external: [] },
  { name: "acp-bridge", external: [] },
];

export const ON_DEMAND_BRIDGES: readonly OnDemandBridge[] = [
  { name: "cursor-bridge", external: ["@cursor/sdk"] },
  {
    name: "pi-bridge",
    external: [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
    ],
  },
];

/** Committed runtime manifests, relative to the package root. */
export const BRIDGE_RUNTIMES_DIRECTORY = "bridge-runtimes";

/**
 * The committed manifest and lockfile of this package's own dependencies,
 * relative to the package root. The build copies them to
 * `RELEASE_RUNTIME_PATH` in `@orkestrator/protocol/node/standalone-service`, and
 * the standalone updater installs from them with `--frozen-lockfile`.
 */
export const RELEASE_RUNTIME_DIRECTORY = "release-runtime";

/** Where an on-demand bridge's install inputs land inside `resources/<name>/`. */
export const RUNTIME_SUBDIRECTORY = "runtime";

/** Names the build's digest of an on-demand bridge; read by the backend. */
export const RUNTIME_DESCRIPTOR = "install.json";

/** The Agent SDK the Claude bridge builds against; its build inlines it. */
export const CLAUDE_AGENT_SDK = "@anthropic-ai/claude-agent-sdk";

/** The SDK manifest fields the Claude bridge reports as its SDK and bundled CLI versions. */
export interface ClaudeAgentSdkManifest {
  version: string;
  claudeCodeVersion: string;
}

/**
 * The installed Agent SDK's manifest, resolved the way the bridge's own build
 * resolves the SDK. A bundle that inlines the SDK has no `package.json` to read
 * at runtime, so the build defines these as `__CLAUDE_AGENT_SDK_MANIFEST__`
 * (`readClaudeSdkManifest` in the bridge's `session-manager-interactions.ts`).
 */
export async function claudeAgentSdkManifest(
  repositoryRoot: string,
): Promise<ClaudeAgentSdkManifest> {
  const entry = Bun.resolveSync(
    CLAUDE_AGENT_SDK,
    path.join(repositoryRoot, "bridges/claude-bridge"),
  );
  const manifest = (await Bun.file(path.join(path.dirname(entry), "package.json")).json()) as {
    name?: string;
    version?: string;
    claudeCodeVersion?: string;
  };
  if (
    manifest.name !== CLAUDE_AGENT_SDK ||
    typeof manifest.version !== "string" ||
    typeof manifest.claudeCodeVersion !== "string"
  ) {
    throw new Error(`Cannot read ${CLAUDE_AGENT_SDK}'s version beside ${entry}`);
  }
  return { version: manifest.version, claudeCodeVersion: manifest.claudeCodeVersion };
}
