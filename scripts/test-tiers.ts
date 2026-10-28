/**
 * Test tiers: which test files the default suite runs.
 *
 * The default tier (`mise run test`) is meant to be deterministic and fast. A
 * test file belongs to the slow tier instead when it waits on something
 * outside the test process — real Git, tmux, Chromium, agent CLIs, servers,
 * sockets, or wall-clock sleeps and long timeouts — and so its duration and
 * outcome depend on how busy the host is. Slow-tier tests run only on demand
 * (`mise run test:slow`) and in CI (`mise run test:full`).
 *
 * The list started from measured per-file durations: every non-UI test file
 * with a median of 3 s or more across recent aggregate runs, plus UI files whose
 * whole purpose is a long or real-time fixture. Prefer making a slow test
 * deterministic (fake clocks, in-process fakes) over adding it here.
 */
import path from "node:path";

export const TEST_TIER_ENV = "ORKESTRATOR_TEST_TIER";
export const TEST_TIERS = ["default", "slow", "all"] as const;
export type TestTier = (typeof TEST_TIERS)[number];

/** Patterns that are slow by construction, wherever they live. */
const LIVE_PATTERNS = ["**/*-live.test.ts", "**/*.live.test.ts", "**/*.integration.test.ts"];

/**
 * Slow-tier globs per package, relative to the package directory (`.` is the
 * repository root's own test group).
 */
export const SLOW_TESTS: Readonly<Record<string, readonly string[]>> = {
  ".": [
    "tests/unit/design-qualification-processes.test.ts",
    "tests/unit/electron-spec-process-ownership.test.ts",
    "tests/unit/firewall-default-boot.test.ts",
    "tests/unit/firewall-policy.test.ts",
    "tests/unit/firewall-refresh.test.ts",
    "tests/unit/git-branch-helpers.test.ts",
    "tests/unit/migrate-copy.test.ts",
    "tests/unit/pi-bridge-vendor.test.ts",
    "tests/unit/playwright-spec-loading.test.ts",
    "tests/unit/release/release-desktop.test.ts",
    "tests/unit/run-logged.test.ts",
    "tests/unit/runtime-env-wiring.test.ts",
    "tests/unit/test-all.test.ts",
    "tests/unit/test-diagnostic-bounds.test.ts",
  ],
  "apps/backend": [
    ...LIVE_PATTERNS,
    // Real Chromium sandboxes and preview workers.
    "src/core/transcript-artifacts/**/*.test.ts",
    // Real tmux sessions polled on wall-clock ticks.
    "tests/tmux*.test.ts",
    "src/core/tmux*.test.ts",
    "src/core/agent-accounts-containers.test.ts",
    "src/core/agent-accounts.test.ts",
    "src/core/agent-mail-service.test.ts",
    "src/core/agents-md-pr.test.ts",
    "src/core/change-tracking/acceptance-sharing.test.ts",
    "src/core/change-tracking/review-regressions.test.ts",
    "src/core/commands-environment-worktree-location.test.ts",
    "src/core/commands-files-remote-fetch.test.ts",
    "src/core/commands-project-creation.test.ts",
    "src/core/commands-registry-project-home.test.ts",
    "src/core/commands-servers-coordinator-opencode.test.ts",
    "src/core/commands-servers-coordinator.test.ts",
    "src/core/commands-state-sync.test.ts",
    "src/core/commands-terminal-terminate.test.ts",
    "src/core/container-git-fetch-git.test.ts",
    "src/core/container-worktree-signal-install.test.ts",
    "src/core/coordinator-service.test.ts",
    "src/core/coordinator-status-wakes.test.ts",
    "src/core/coordinator-surface-actions.test.ts",
    "src/core/design/renderer.test.ts",
    "src/core/diff-stats-tracking.test.ts",
    "src/core/environment-cleanup-reconciler.test.ts",
    "src/core/environment-cleanup.test.ts",
    "src/core/environment-move.test.ts",
    "src/core/index.test.ts",
    "src/core/looped-review-service.test.ts",
    "src/core/multi-review-service.test.ts",
    "src/core/native-agent-service-progressive.test.ts",
    "src/core/nodes/node-project-copy.test.ts",
    "src/core/opencode-host-start.test.ts",
    "src/core/preview-local-discovery.test.ts",
    "src/core/public-api/public-api-exec.test.ts",
    "src/core/public-api/public-api-project-init-cascade.test.ts",
    "src/core/public-api/public-api-projects.test.ts",
    "src/core/public-api/public-api-schedules.test.ts",
    "src/core/review-validation-worker.test.ts",
    "src/core/root-changes.test.ts",
    "src/core/shell.test.ts",
    "src/core/terminal-history.test.ts",
    "src/core/worktree-snapshots-git.test.ts",
    "src/preview-publication.test.ts",
    "src/remote-bandwidth-baseline.test.ts",
    "tests/commands-environment-fork.test.ts",
    "tests/commands-integration.test.ts",
    "tests/commands-io-coverage.test.ts",
    "tests/commands-local-bridge-reuse.test.ts",
    "tests/commands-registry-docker.test.ts",
    "tests/commands-registry-environments-create.test.ts",
    "tests/commands-registry-environments-status.test.ts",
    "tests/commands-registry-environments.test.ts",
    "tests/commands-registry-pr.test.ts",
    "tests/commands-registry-servers.test.ts",
    "tests/commands-registry-terminal.test.ts",
    "tests/container-log-service.test.ts",
    "tests/container-network.test.ts",
    "tests/container-replacement.test.ts",
    "tests/egress-gateway.test.ts",
    "tests/multi-review-claude-bridge-restart.test.ts",
    "tests/recurring-baseline.test.ts",
    "tests/standalone.test.ts",
    "tests/worktree-watcher.test.ts",
  ],
  "apps/desktop": [
    ...LIVE_PATTERNS,
    "scripts/dev/isolated-browser.test.ts",
    "tests/backend-process.test.ts",
  ],
  "apps/web": [
    "src/components/chat/rich-transcript.long-fixture.test.tsx",
    "src/hooks/useArtifactPublications.test.ts",
    "src/lib/store-resource-sync.test.ts",
  ],
  "bridges/acp-bridge": [
    "src/acp-context.test.ts",
    "src/acp-http.test.ts",
    "src/acp-persistence.test.ts",
    "src/acp-prompt.test.ts",
    "src/acp-reconciliation.test.ts",
    "src/acp-session-close.test.ts",
    "src/acp-session.test.ts",
    "src/acp-transcript.test.ts",
  ],
  "bridges/claude-bridge": [
    ...LIVE_PATTERNS,
    "src/sdk-compatibility.test.ts",
    "src/services/session-manager-core.test.ts",
  ],
  "bridges/codex-bridge": [
    ...LIVE_PATTERNS,
    "src/app-server-http.test.ts",
    "src/app-server-runtime-lifecycle.test.ts",
    "src/app-server-runtime-prompt.test.ts",
  ],
  "bridges/cursor-bridge": ["src/initial-run.test.ts", "src/login-no-open-browser.test.ts"],
  "bridges/pi-bridge": [...LIVE_PATTERNS, "src/http.test.ts"],
  "packages/cli": [
    "tests/cli-client.test.ts",
    "tests/client-waits.test.ts",
    "tests/launcher.test.ts",
  ],
  "packages/protocol": ["src/node/workspace-change-probe.test.ts"],
};

export function testTier(env: NodeJS.ProcessEnv): TestTier {
  const value = env[TEST_TIER_ENV];
  if (value === undefined || value === "") return "default";
  if ((TEST_TIERS as readonly string[]).includes(value)) return value as TestTier;
  throw new Error(`${TEST_TIER_ENV} must be one of ${TEST_TIERS.join(", ")}; got ${value}`);
}

/** Slow-tier files that exist under `directory`, relative to it, sorted. */
export function slowTestFiles(root: string, packageDirectory: string): string[] {
  const directory = path.join(root, packageDirectory);
  const files = new Set<string>();
  for (const pattern of SLOW_TESTS[packageDirectory] ?? []) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: directory })) {
      const relative = file.split(path.sep).join("/");
      if (!relative.split("/").includes("node_modules")) files.add(relative);
    }
  }
  return Array.from(files).sort();
}

/**
 * Bun arguments that select one package's tier. `paths` are the package's
 * normal discovery roots. Returns `undefined` when the tier has nothing to run
 * in this package.
 */
export function tierArguments(
  tier: TestTier,
  root: string,
  packageDirectory: string,
  paths: readonly string[],
): string[] | undefined {
  if (tier === "all") return [...paths];
  if (tier === "default") {
    return [
      ...paths,
      ...(SLOW_TESTS[packageDirectory] ?? []).map((pattern) => `--path-ignore-patterns=${pattern}`),
    ];
  }
  // Discovery roots may be directories or single files; keep slow files under them.
  const roots = paths.map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""));
  const files = slowTestFiles(root, packageDirectory).filter((file) =>
    roots.some((entry) => entry === "." || file === entry || file.startsWith(`${entry}/`)),
  );
  return files.length > 0 ? files.map((file) => `./${file}`) : undefined;
}
