import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_STAGE_TEST_FILES, TEST_GROUP_KEYS } from "../../scripts/test-all";

const read = (relativePath: string) =>
  readFileSync(join(import.meta.dir, "..", "..", relativePath), "utf8");

type Workflow = {
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: Record<
    string,
    {
      name: string;
      needs?: string;
      if?: string;
      "runs-on"?: string;
      permissions?: Record<string, string>;
      outputs?: Record<string, string>;
      env?: Record<string, string>;
      strategy?: {
        matrix: {
          runner?: string[];
          include?: { shard: string; groups: string; "qualify-claude"?: boolean }[];
        };
      };
      steps?: {
        id?: string;
        name?: string;
        run?: string;
        env?: Record<string, string>;
        if?: string;
        with?: Record<string, string>;
      }[];
    }
  >;
};

const workflow = (name: string) =>
  Bun.YAML.parse(read(`.github/workflows/${name}.yml`)) as Workflow;

describe("CI workflow contracts", () => {
  test("mobile browser cache keys separate Ubuntu releases and rotate only APT daily", () => {
    const step = workflow("ci").jobs["mobile-shell-browser"]!.steps!.find(
      (step) => step.id === "install-cache-keys",
    )!;
    expect(step.run).toContain("source /etc/os-release");
    // GITHUB_OUTPUT is a real file: Bun may hand the child a socket for
    // stdout, and opening /dev/stdout on a socket fails with ENXIO.
    const outputDir = mkdtempSync(join(tmpdir(), "ci-cache-keys-"));
    let runs = 0;
    const run = (release: string, image: string, day: string) => {
      const outputFile = join(outputDir, `output-${runs++}`);
      const result = Bun.spawnSync(
        [
          "bash",
          "-c",
          'bunx() { printf "Version 1.65.0\\n"; }\ndate() { printf "%s\\n" "$CACHE_DAY"; }\n' +
            step.run!.replace("source /etc/os-release", ""),
        ],
        {
          env: {
            ...process.env,
            ID: "ubuntu",
            VERSION_ID: release,
            RUNNER_ARCH: "X64",
            BROWSER: "webkit",
            ImageVersion: image,
            CACHE_DAY: day,
            GITHUB_OUTPUT: outputFile,
          },
        },
      );
      expect({ code: result.exitCode, stderr: result.stderr.toString() }).toEqual({
        code: 0,
        stderr: "",
      });
      return Object.fromEntries(
        readFileSync(outputFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      );
    };
    try {
      const first = run("24.04", "20261118.1", "2026-11-19");
      const nextImage = run("24.04", "20261119.1", "2026-11-19");
      const nextRelease = run("26.04", "20261119.1", "2026-11-19");
      const nextDay = run("26.04", "20261119.1", "2026-11-20");

      expect(run("24.04", "20261118.1", "2026-11-19")).toEqual(first);
      expect(nextImage["browser-key"]).not.toBe(first["browser-key"]);
      expect(nextImage["browser-key"]).toStartWith(first["browser-prefix"]!);
      expect(nextRelease["browser-key"]).not.toStartWith(first["browser-prefix"]!);
      expect(nextRelease["apt-key"]).not.toStartWith(first["apt-prefix"]!);
      expect(nextDay["browser-key"]).toBe(nextRelease["browser-key"]);
      expect(nextDay["apt-key"]).not.toBe(nextRelease["apt-key"]);
      expect(nextDay["apt-key"]).toStartWith(nextRelease["apt-prefix"]!);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test("mobile shell restores separate caches and exercises the browser before saving it", () => {
    const steps = workflow("ci").jobs["mobile-shell-browser"]!.steps!;
    const browserRestore = steps.find((step) => step.id === "browser-cache");
    const aptRestore = steps.find((step) => step.id === "apt-cache");
    const browserSave = steps.find((step) => step.name === "Save Playwright browser cache")!;
    const aptSave = steps.find((step) => step.name === "Save APT archive cache")!;
    expect(browserRestore?.with).toEqual({
      path: "~/.cache/ms-playwright",
      key: "${{ steps.install-cache-keys.outputs.browser-key }}",
      "restore-keys": "${{ steps.install-cache-keys.outputs.browser-prefix }}",
    });
    expect(aptRestore?.with).toEqual({
      path: "~/.cache/orkestrator-apt-archives",
      key: "${{ steps.install-cache-keys.outputs.apt-key }}",
      "restore-keys": "${{ steps.install-cache-keys.outputs.apt-prefix }}",
    });
    expect(browserSave.with?.path).toBe(browserRestore?.with?.path);
    expect(browserSave.with?.key).toBe(browserRestore?.with?.key);
    expect(aptSave.with?.path).toBe(aptRestore?.with?.path);
    expect(aptSave.with?.key).toBe(aptRestore?.with?.key);
    expect(browserSave.if).toBe("${{ steps.browser-cache.outputs.cache-hit != 'true' }}");
    expect(aptSave.if).toBe("${{ steps.apt-cache.outputs.cache-hit != 'true' }}");
    const smoke = steps.find((step) => step.name === "Test mobile shell input")!;
    expect(steps.indexOf(browserSave)).toBeGreaterThan(steps.indexOf(smoke));
  });

  test("ci supersedes older runs of the same pull request or of main", () => {
    const { concurrency } = workflow("ci");
    // A newer main commit cancels an older main commit's run; the Free plan's
    // 20 concurrent jobs could not keep up with one full run per merge.
    expect(concurrency.group).toBe(
      "ci-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.ref }}",
    );
    expect(concurrency["cancel-in-progress"]).toBe(true as unknown as string);
  });

  test("draft pull requests run no jobs until they are marked ready", () => {
    for (const name of [
      "ci",
      "validate-bun-runtime",
      "container-live-qualification",
      "native-application-menu",
      "claude-apparmor-qualification",
      "electron-qualification",
    ]) {
      const parsed = Bun.YAML.parse(read(`.github/workflows/${name}.yml`)) as {
        on: { pull_request?: { types?: string[] } };
      } & Workflow;
      expect(parsed.on.pull_request?.types).toContain("ready_for_review");
      for (const [id, job] of Object.entries(parsed.jobs)) {
        // A job that needs another is skipped with it, unless its own
        // condition (such as `!cancelled()`) would run it anyway.
        if (job.needs && !job.if) continue;
        expect({ workflow: name, job: id, if: job.if }).toEqual({
          workflow: name,
          job: id,
          if: expect.stringContaining("!github.event.pull_request.draft"),
        });
      }
    }
  });

  test("validate-bun-runtime runs on packaging inputs and nightly, not on every source change", () => {
    const parsed = Bun.YAML.parse(read(".github/workflows/validate-bun-runtime.yml")) as {
      on: {
        schedule?: { cron: string }[];
        push: { paths: string[] };
        pull_request: { paths: string[] };
      };
    };
    expect(parsed.on.schedule?.length).toBe(1);
    for (const paths of [parsed.on.push.paths, parsed.on.pull_request.paths]) {
      expect(paths).toContain("mise.toml");
      expect(paths).toContain("bun.lock");
      expect(paths).toContain("scripts/download-bun.sh");
      for (const broad of ["apps/backend/**", "apps/desktop/**", "packages/**", "bridges/**"]) {
        expect(paths).not.toContain(broad);
      }
    }
  });

  for (const name of [
    "validate-bun-runtime",
    "container-live-qualification",
    "claude-apparmor-qualification",
    "electron-qualification",
  ]) {
    test(`${name} only coalesces pull request runs`, () => {
      const { concurrency } = workflow(name);
      // A branch-wide group loses pending main runs even with cancellation off.
      // Non-PR events must use a run identity; PRs keep one group per PR.
      expect(concurrency.group).toBe(
        `${name}-` +
          "${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.run_id }}",
      );
      expect(concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
    });
  }

  test("the fast lint job runs the guard stage, which replaced the separate guard steps", () => {
    const runs = workflow("ci").jobs.oxc!.steps!.flatMap((step) => step.run ?? []);
    // The DOM absence scan, the source guards and the documentation register
    // checks all run in `mise run guards` (scripts/guards.ts).
    expect(runs).toContain("mise run guards");
    for (const file of ["tests/unit/dom-absence-scan.test.ts", ...GUARD_STAGE_TEST_FILES])
      expect(runs.filter((run) => run.includes(file))).toEqual([]);
  });

  test("CI provides every documented required status-check context", () => {
    const document = read("docs/todo/cross-cutting/0030-test-suite-and-ci-health.md");
    const ruleset = JSON.parse(document.match(/```json\s+([\s\S]*?)```/)![1]!) as {
      rules: { parameters?: { required_status_checks?: { context: string }[] } }[];
    };
    const contexts = ruleset.rules.flatMap(
      (rule) => rule.parameters?.required_status_checks?.map((check) => check.context) ?? [],
    );
    expect(contexts.length).toBeGreaterThan(0);
    const jobNames = Object.values(workflow("ci").jobs).map((job) => job.name);
    for (const context of contexts) expect(jobNames).toContain(context);
  });

  test("the test shards together run every aggregate group exactly once", () => {
    const jobs = workflow("ci").jobs;
    const shard = jobs["test-shard"]!;
    const step = shard.steps!.find((step) => step.run === "mise run test:full");
    expect(step?.env?.ORKESTRATOR_TEST_GROUPS).toBe("${{ matrix.groups }}");
    // Each shard fits the default group deadline; raising it is not the fix.
    expect(step?.env?.ORKESTRATOR_TEST_GROUP_TIMEOUT_MS).toBeUndefined();
    const shards = shard.strategy!.matrix.include!;
    expect(shards.flatMap((entry) => entry.groups.split(",")).sort()).toEqual(
      [...TEST_GROUP_KEYS].sort(),
    );
    // The paired AppArmor evidence comes from one host.
    expect(shards.filter((entry) => entry["qualify-claude"])).toHaveLength(1);

    // One status for the suite, under the planned required-check name, which
    // reports failure rather than going missing when a shard fails.
    const gate = jobs.test!;
    expect(gate.name).toBe("Unit and integration tests");
    expect(gate.needs).toBe("test-shard");
    // A draft skips it (GitHub cannot merge a draft; marking it ready starts a run).
    expect(gate.if).toBe(
      "${{ !cancelled() && (github.event_name != 'pull_request' || !github.event.pull_request.draft) }}",
    );
  });

  test("CI compares independently installed worker contexts across hosts", () => {
    const jobs = workflow("ci").jobs;
    const baseline = jobs["worker-context"]!;
    const parity = jobs["worker-context-parity"]!;
    expect(baseline["runs-on"]).toBe("ubuntu-24.04");
    expect(baseline.outputs?.digest).toBe("${{ steps.context.outputs.digest }}");
    expect(parity.needs).toBe("worker-context");
    expect(parity["runs-on"]).toBe("${{ matrix.runner }}");
    expect(parity.strategy?.matrix.runner).toEqual(["ubuntu-24.04-arm", "macos-15"]);
    for (const job of [baseline, parity]) {
      expect(job.permissions).toEqual({ contents: "read" });
      expect(job.steps?.some((step) => step.run === "bun install --frozen-lockfile")).toBe(true);
      const stage = job.steps?.find((step) =>
        step.run?.includes("bun docker/artifact-preview-worker/stage-context.ts"),
      );
      expect(stage?.run).toContain('test "$(bun --version)" = "$(mise current bun)"');
      expect(stage?.run).toContain("bun docker/artifact-preview-worker/context-digest.ts");
    }
    const digest = baseline.steps?.find((step) => step.id === "context");
    expect(digest?.run).toContain('echo "digest=$digest" >> "$GITHUB_OUTPUT"');
    const comparison = parity.steps?.find((step) => step.env?.CONTEXT_DIGEST);
    expect(comparison?.env?.CONTEXT_DIGEST).toBe("${{ needs.worker-context.outputs.digest }}");
    expect(comparison?.run).toContain(
      'test "$(bun docker/artifact-preview-worker/context-digest.ts "${RUNNER_TEMP}/worker-context")" = "$CONTEXT_DIGEST"',
    );
  });

  test("the test job installs every tool a host-gated test needs", () => {
    // These tests skip on a host without the tool, so CI must provide it or
    // they pass vacuously: the CLI completion tests (zsh, fish) and the Claude
    // Linux sandbox qualification (bubblewrap, socat).
    const source = read(".github/workflows/ci.yml");
    const install = source.match(/apt-get install --yes --no-install-recommends ([^\n]+)/);
    expect(install?.[1]?.split(/\s+/)).toEqual(
      expect.arrayContaining(["bubblewrap", "socat", "zsh", "fish"]),
    );
  });

  test("Ubuntu 24.04 qualifies Claude's sandbox on its stock AppArmor policy, then remediated", () => {
    const parsed = Bun.YAML.parse(read(".github/workflows/claude-apparmor-qualification.yml")) as {
      on: { schedule?: { cron: string }[]; pull_request: { paths: string[] } };
    } & Workflow;
    // Runner images change under the job, so it also runs on a schedule.
    expect(parsed.on.schedule?.length).toBe(1);
    for (const path of [
      "apps/backend/src/core/coordinator/providers.ts",
      "bridges/claude-bridge/src/conformance-apparmor-live.test.ts",
      "packages/protocol/src/node/claude-linux-sandbox.ts",
      "packages/toolchain/src/manifest.ts",
    ])
      expect(parsed.on.pull_request.paths).toContain(path);
    const job = parsed.jobs["ubuntu-2404"]!;
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.permissions).toEqual({ contents: "read" });
    const steps = job.steps!;
    const index = (match: (step: (typeof steps)[number]) => boolean) => {
      const found = steps.findIndex(match);
      expect(found).toBeGreaterThanOrEqual(0);
      return found;
    };
    const install = index((step) => /apt-get install .*bubblewrap socat/.test(step.run ?? ""));
    const stock = index((step) => step.env?.ORKESTRATOR_CLAUDE_APPARMOR_PHASE === "stock");
    const remediation = index((step) => (step.run ?? "").includes("apparmor_parser --remove"));
    const remediated = index(
      (step) => step.env?.ORKESTRATOR_CLAUDE_APPARMOR_PHASE === "remediated",
    );
    // The stock phase must see the runner's policy before anything changes it.
    expect(install).toBeLessThan(stock);
    expect(stock).toBeLessThan(remediation);
    expect(remediation).toBeLessThan(remediated);
    for (const phase of [steps[stock]!, steps[remediated]!]) {
      expect(phase.run).toContain("./src/conformance-apparmor-live.test.ts --parallel=1");
      // The pinned CLI downloaded by this job, never a host toolchain.
      expect(phase.env?.ORKESTRATOR_POLICY_CLAUDE_PATH).toBe(
        "${{ github.workspace }}/binaries/claude",
      );
      expect(phase.env?.ORKESTRATOR_CLAUDE_APPARMOR_EVIDENCE).toBe(
        "${{ runner.temp }}/claude-apparmor",
      );
    }
    expect(steps.some((step) => step.run === "mise run download:claude")).toBe(true);
  });

  test("the whole Electron suite runs weekly on Linux under Xvfb, with no secrets", () => {
    const source = read(".github/workflows/electron-qualification.yml");
    const parsed = Bun.YAML.parse(source) as {
      on: { schedule?: { cron: string }[]; workflow_dispatch?: unknown };
    } & Workflow;
    // The user's choice (to-do 0031 task 8): weekly on the container live
    // qualification's schedule, and on demand.
    const container = Bun.YAML.parse(
      read(".github/workflows/container-live-qualification.yml"),
    ) as { on: { schedule: { cron: string }[] } };
    expect(parsed.on.schedule).toEqual(container.on.schedule);
    expect("workflow_dispatch" in parsed.on).toBe(true);
    const jobs = Object.values(parsed.jobs);
    expect(jobs.length).toBe(1);
    const job = jobs[0]!;
    expect(job["runs-on"]).toMatch(/^ubuntu-/);
    expect(job.permissions).toEqual({ contents: "read" });
    const steps = job.steps!;
    const suite = steps.findIndex((step) => (step.run ?? "").includes("test:agent:electron"));
    expect(suite).toBeGreaterThanOrEqual(0);
    // The whole suite, not a chosen subset of its specs.
    expect(steps[suite]!.run).toMatch(/mise run test:agent:electron$/);
    // A disposable display, never a Wayland compositor the runner might name.
    expect(steps[suite]!.run).toContain(
      "env -u WAYLAND_DISPLAY -u ELECTRON_OZONE_PLATFORM_HINT xvfb-run -a ",
    );
    const install = steps.findIndex((step) => /apt-get install .*xvfb/.test(step.run ?? ""));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(suite);
    // Credential-free: no secret reaches the job.
    expect(source).not.toContain("secrets.");
  });

  test("the scheduled live job runs every opt-in live container suite", () => {
    const source = read(".github/workflows/container-live-qualification.yml");
    const suites = readdirSync(join(import.meta.dir, "..", "..", "apps/backend/tests")).filter(
      (name) => /^container-live-.*\.test\.ts$/.test(name),
    );
    expect(suites.length).toBeGreaterThan(0);
    for (const suite of suites) expect(source).toContain(`./tests/${suite} --parallel=1`);
    // The container change signals' live tests and exec-cost numbers need a
    // real Linux Engine too, with the run's own image.
    for (const suite of [
      "claude-state-signal-docker",
      "claude-terminal-failed-turn-docker",
      "container-worktree-signal-docker",
      "tmux-hook-signal-docker",
      // M8: the staged ~/.claude.json allowlist and a real Claude start on it.
      "claude-config-filter-docker",
    ])
      expect(source).toContain(`./tests/${suite}.test.ts --parallel=1`);
    expect(source).toContain(
      "ORKESTRATOR_TEST_STATE_SIGNAL_IMAGE: ${{ env.ORKESTRATOR_QUALIFICATION_IMAGE }}",
    );
    // Design export skips without its image variable, so the step must set it.
    expect(source).toContain("./src/core/design/export-container.test.ts --parallel=1");
    expect(source).toContain(
      "ORKESTRATOR_TEST_DOCKER_DESIGN_IMAGE: ${{ env.ORKESTRATOR_QUALIFICATION_IMAGE }}",
    );
    expect(source).toContain("apps/backend/scripts/container-exec-cost.ts --image");
    // The preview worker under its seccomp profile on a real runc: the live
    // case skips without the image, so the step refuses to run without it.
    expect(source).toContain("bash docker/artifact-preview-worker/build.sh");
    expect(source).toContain(
      'docker image inspect "$ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE" > /dev/null && mise run test:logged',
    );
    expect(source).toContain(
      "./src/core/transcript-artifacts/preview-container.test.ts --parallel=1",
    );
    // Without the gate every live test skips and the job passes vacuously.
    expect(source).toContain('RUN_LIVE_DOCKER_TESTS: "1"');
    // GitHub's ranges come from one authenticated fetch, not every suite's own
    // unauthenticated one (a spent quota fails restricted firewalls closed).
    expect(source).toContain("apps/backend/scripts/github-ranges-seed.ts");
    expect(source).toContain('ORKESTRATOR_LIVE_GITHUB_RANGES_SEED=${seed}" >> "$GITHUB_ENV"');
    const parsed = Bun.YAML.parse(source) as Workflow;
    const unseeded = parsed.jobs.engine?.steps?.find(
      (step) => step.name === "Live firewall without workflow seed",
    );
    expect(unseeded?.env?.ORKESTRATOR_LIVE_GITHUB_RANGES_SEED).toBe("");
    // The backend's own fetch authenticates on this step only (to-do 8322).
    expect(unseeded?.env?.ORKESTRATOR_QUALIFICATION_GITHUB_META_TOKEN).toBe("${{ github.token }}");
    expect(
      (parsed.jobs.engine?.steps ?? []).filter(
        (step) => step.env?.ORKESTRATOR_QUALIFICATION_GITHUB_META_TOKEN !== undefined,
      ),
    ).toHaveLength(1);
    expect(parsed.jobs.engine?.env?.ORKESTRATOR_QUALIFICATION_GITHUB_META_TOKEN).toBeUndefined();
    expect(unseeded?.run).toContain("./tests/container-live-firewall.test.ts --parallel=1");
    expect(unseeded?.run).toContain(
      "--test-name-pattern 'restricted boot fetches GitHub ranges without a workflow seed'",
    );
    expect(source).not.toContain("orkestrator-v2:latest");
  });
});
