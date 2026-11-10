import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_GROUP_KEYS } from "../../scripts/test-all";

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
      strategy?: {
        matrix: {
          runner?: string[];
          include?: { shard: string; groups: string; "qualify-claude"?: boolean }[];
        };
      };
      steps?: { id?: string; name?: string; run?: string; env?: Record<string, string> }[];
    }
  >;
};

const workflow = (name: string) =>
  Bun.YAML.parse(read(`.github/workflows/${name}.yml`)) as Workflow;

describe("CI workflow contracts", () => {
  for (const name of ["ci", "validate-bun-runtime", "container-live-qualification"]) {
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

  test("the fast lint job runs the DOM absence scan and the documentation number checks", () => {
    const runs = workflow("ci").jobs.oxc!.steps!.flatMap((step) => step.run ?? []);
    const guard = (file: string) => runs.find((run) => run.includes(file));
    expect(guard("tests/unit/dom-absence-scan.test.ts")).toContain(
      "never passes a DOM-producing query result",
    );
    expect(guard("tests/unit/flaky-tests-index.test.ts")).toBeDefined();
    expect(guard("tests/unit/todo-index.test.ts")).toBeDefined();
    expect(guard("tests/unit/number-claims.test.ts")).toBeDefined();
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
    expect(gate.if).toBe("${{ !cancelled() }}");
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
    expect(unseeded?.run).toContain("./tests/container-live-firewall.test.ts --parallel=1");
    expect(unseeded?.run).toContain(
      "--test-name-pattern 'restricted boot fetches GitHub ranges without a workflow seed'",
    );
    expect(source).not.toContain("orkestrator-v2:latest");
  });
});
