import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const read = (relativePath: string) =>
  readFileSync(join(import.meta.dir, "..", "..", relativePath), "utf8");

type Workflow = {
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: Record<string, { name: string }>;
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
    for (const suite of ["claude-state-signal-docker", "container-worktree-signal-docker"])
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
    expect(source).not.toContain("orkestrator-v2:latest");
  });

  test("the preview worker image is published per build context and pinned through a pull request", () => {
    const source = read(".github/workflows/publish-preview-worker.yml");
    const parsed = Bun.YAML.parse(source) as {
      on: { push: { branches: string[]; paths: string[] }; workflow_dispatch: unknown };
      env: Record<string, string>;
      jobs: Record<string, { if?: string; permissions?: Record<string, string> }>;
    };
    expect(parsed.on.push.branches).toEqual(["main"]);
    expect("workflow_dispatch" in parsed.on).toBe(true);
    // Every input of the staged context triggers a run (a missed one only
    // leaves the pin stale, which installs survive by building locally).
    expect(parsed.on.push.paths).toEqual(
      expect.arrayContaining([
        "docker/artifact-preview-worker/**",
        "apps/backend/src/core/transcript-artifacts/**",
        "packages/protocol/src/**",
        "bun.lock",
      ]),
    );
    // The label the backend checks after a pull is the one the image carries
    // (the backend's preview-worker-context-digest test pins the same value).
    expect(parsed.env.CONTEXT_LABEL).toBe("orkestrator.artifact-preview-worker.context");
    expect(source).toContain(
      "${{ env.CONTEXT_LABEL }}=${{ needs.context.outputs.context-digest }}",
    );
    expect(source).toContain("bun docker/artifact-preview-worker/stage-context.ts");
    expect(source).toContain("bun docker/artifact-preview-worker/context-digest.ts");
    expect(source).toContain("bun docker/artifact-preview-worker/write-pin.ts");
    // Native runners for each architecture, pushed by digest, no emulation.
    expect(source).toContain("runner: ubuntu-24.04-arm");
    expect(source).toContain("push-by-digest=true,name-canonical=true,push=true");
    expect(source).not.toContain("docker/setup-qemu-action@");
    // An existing image for the context is not rebuilt, and only main is pinned.
    expect(parsed.jobs.build?.if).toBe("needs.context.outputs.exists != 'true'");
    expect(source).toContain("github.ref == 'refs/heads/main'");
    // Only the pin job can write to the repository.
    for (const [name, job] of Object.entries(parsed.jobs))
      expect(job.permissions?.contents, name).toBe(name === "publish" ? "write" : "read");
  });
});
