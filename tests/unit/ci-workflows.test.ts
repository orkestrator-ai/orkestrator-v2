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

  test("the scheduled live job runs every opt-in live container suite", () => {
    const source = read(".github/workflows/container-live-qualification.yml");
    const suites = readdirSync(join(import.meta.dir, "..", "..", "apps/backend/tests")).filter(
      (name) => /^container-live-.*\.test\.ts$/.test(name),
    );
    expect(suites.length).toBeGreaterThan(0);
    for (const suite of suites) expect(source).toContain(`./tests/${suite} --parallel=1`);
    // Without the gate every live test skips and the job passes vacuously.
    expect(source).toContain('RUN_LIVE_DOCKER_TESTS: "1"');
    expect(source).not.toContain("orkestrator-v2:latest");
  });
});
