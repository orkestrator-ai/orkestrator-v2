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
import { readdirSync, statSync, type Dirent } from "node:fs";
import path from "node:path";

export const TEST_TIER_ENV = "ORKESTRATOR_TEST_TIER";
export const TEST_TIERS = ["default", "slow", "all"] as const;
export type TestTier = (typeof TEST_TIERS)[number];

/**
 * Patterns that are slow by construction, wherever they live in a package
 * that lists them. The root group's slow-tier scan walks the whole
 * repository for them and keeps only files under its discovery roots.
 */
const LIVE_PATTERNS = ["**/*-live.test.ts", "**/*.live.test.ts", "**/*.integration.test.ts"];

/**
 * Slow-tier globs per package, relative to the package directory (`.` is the
 * repository root's own test group).
 */
export const SLOW_TESTS: Readonly<Record<string, readonly string[]>> = {
  ".": [
    // Unit tests of the `scripts/*-live.ts` benchmarks are named
    // `*-live-script.test.ts`, so these patterns leave them in the default tier.
    ...LIVE_PATTERNS,
    "tests/unit/design-qualification-processes.test.ts",
    "tests/unit/electron-spec-process-ownership.test.ts",
    "tests/unit/firewall-default-boot.test.ts",
    // Boots and live edits of the real init-firewall.sh and update-firewall.sh
    // against stub tools; the name-list checks are in firewall-egress-filter-names.
    "tests/unit/firewall-egress-filter.test.ts",
    "tests/unit/firewall-policy.test.ts",
    "tests/unit/firewall-refresh.test.ts",
    // Real Git repositories built per run.
    "tests/unit/flaky-tests-tooling-git.test.ts",
    "tests/unit/git-branch-helpers.test.ts",
    // Runs the real install.sh in bash about 18 times with stub tools.
    "tests/unit/install-script.test.ts",
    // Real `bun pm pack` and `bun install` against a loopback registry, then install.sh.
    "tests/unit/install-script-locked-run.test.ts",
    "tests/unit/migrate-copy.test.ts",
    "tests/unit/pi-bridge-vendor.test.ts",
    "tests/unit/playwright-spec-loading.test.ts",
    "tests/unit/release/release-desktop.test.ts",
    // Runs the real Linux-builder script in bash against a local Git origin.
    "tests/unit/release/release-linux-remote-script.test.ts",
    "tests/unit/run-logged.test.ts",
    "tests/unit/runtime-env-wiring.test.ts",
    "tests/unit/test-all.test.ts",
    "tests/unit/test-diagnostic-bounds.test.ts",
    // Races the slow-tier scan against a real process rebuilding dist/ (flake 9909).
    "tests/unit/test-tiers-scan-race.test.ts",
    // Real busy-loop processes pinned to a core, and a signalled runner.
    "tests/unit/test-under-contention-processes.test.ts",
    // Real Git repositories, and clones over file://, in every test.
    "tests/unit/workspace-setup-git-mirror.test.ts",
    // The setup script's real functions in bash against real Git repositories;
    // its text-only checks are in workspace-setup-script-contract.
    "tests/unit/workspace-setup-preserve.test.ts",
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
    // Isolated Bun command sweep with per-call and process deadlines.
    "src/core/commands-secret-sweep.test.ts",
    "src/core/commands-state-sync.test.ts",
    "src/core/commands-terminal-terminate.test.ts",
    "src/core/container-git-fetch-git.test.ts",
    "src/core/container-worktree-signal-install.test.ts",
    "src/core/coordinator-fork-worker.test.ts",
    "src/core/coordinator-service.test.ts",
    "src/core/coordinator-status-wakes.test.ts",
    "src/core/coordinator-surface-actions.test.ts",
    "src/core/design/renderer.test.ts",
    "src/core/diff-stats-tracking.test.ts",
    "src/core/environment-cleanup-reconciler.test.ts",
    "src/core/environment-cleanup.test.ts",
    "src/core/environment-move.test.ts",
    "src/core/index.test.ts",
    "src/core/multi-review-service.test.ts",
    "src/core/native-agent-service-progressive.test.ts",
    "src/core/nodes/node-project-copy.test.ts",
    "src/core/opencode-host-start.test.ts",
    // Real stand-in `opencode2` servers, polled for readiness.
    "src/core/opencode2-host-server.test.ts",
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
    "tests/gateway-proxy-idle-timers.test.ts",
    // Twenty concurrent `sh` hook writers, and one held off by a real flock holder.
    "tests/claude-state-signal-hook-writers.test.ts",
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
    // Real `sh` boot-probe polling loops, timed on the wall clock.
    "tests/container-readiness-boot-wait.test.ts",
    "tests/container-network.test.ts",
    "tests/container-replacement.test.ts",
    "tests/egress-gateway.test.ts",
    "tests/multi-review-claude-bridge-restart.test.ts",
    // Runs the real entrypoint.sh setup section in bash about 60 times.
    "tests/portable-inputs-stamps.test.ts",
    "tests/recurring-baseline.test.ts",
    "tests/standalone.test.ts",
    "tests/worktree-watcher-real.test.ts",
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
    // One real process tree per test, reaped on wall-clock grace periods.
    "src/acp-process-tree.test.ts",
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
    // Boots the packaged backend and waits for it to be ready and to stop.
    "tests/cli-packaged-backend.test.ts",
    "tests/client-waits.test.ts",
    "tests/launcher.test.ts",
  ],
  "packages/protocol": [
    ...LIVE_PATTERNS,
    "src/node/workspace-change-probe.test.ts",
    "src/node/preview-forward.test.ts",
  ],
};

export function testTier(env: NodeJS.ProcessEnv): TestTier {
  const value = env[TEST_TIER_ENV];
  if (value === undefined || value === "") return "default";
  if ((TEST_TIERS as readonly string[]).includes(value)) return value as TestTier;
  throw new Error(`${TEST_TIER_ENV} must be one of ${TEST_TIERS.join(", ")}; got ${value}`);
}

/**
 * Directories the slow-tier scan never enters: dependencies and build output.
 * Neither holds test sources, and a concurrent build deletes `dist/` entries
 * while the scan is listing them (flake 9909: `Bun.Glob.scanSync` over the
 * whole package threw ENOENT on a `dist/artifact-runtime` file).
 */
const SCAN_SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);
const GLOB_SEGMENT = /[*?[\]{}!]/;

function isVanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Files under `directory/base`, relative to `directory`, skipping hidden
 * entries (as `Bun.Glob` does without `dot`) and the skipped directories. An
 * entry that disappears between being listed and being read is dropped rather
 * than failing the scan.
 */
function walkFiles(directory: string, base: string): string[] {
  const files: string[] = [];
  const pending = [base];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(directory, relative), { withFileTypes: true });
    } catch (error) {
      if (isVanished(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SCAN_SKIPPED_DIRECTORIES.has(entry.name)) pending.push(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  }
  return files;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch (error) {
    if (isVanished(error)) return false;
    throw error;
  }
}

/** Slow-tier files that exist under `directory`, relative to it, sorted. */
export function slowTestFiles(root: string, packageDirectory: string): string[] {
  const directory = path.join(root, packageDirectory);
  const files = new Set<string>();
  for (const pattern of SLOW_TESTS[packageDirectory] ?? []) {
    const segments = pattern.split("/");
    const firstGlob = segments.findIndex((segment) => GLOB_SEGMENT.test(segment));
    const candidates =
      firstGlob === -1
        ? isFile(path.join(directory, pattern))
          ? [pattern]
          : []
        : walkFiles(directory, segments.slice(0, firstGlob).join("/"));
    const glob = new Bun.Glob(pattern);
    for (const file of candidates) {
      if (file.split("/").some((segment) => SCAN_SKIPPED_DIRECTORIES.has(segment))) continue;
      if (firstGlob === -1 || glob.match(file)) files.add(file);
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
