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
 *   dependency of this package (`tests/cli.test.ts` enforces that).
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
  { name: "claude-bridge", external: ["@anthropic-ai/claude-agent-sdk"] },
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

/** Where an on-demand bridge's install inputs land inside `resources/<name>/`. */
export const RUNTIME_SUBDIRECTORY = "runtime";

/** Names the build's digest of an on-demand bridge; read by the backend. */
export const RUNTIME_DESCRIPTOR = "install.json";
