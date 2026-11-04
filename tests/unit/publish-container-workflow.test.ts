import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { permissions?: Record<string, string>; steps?: Step[] };

const workflow = Bun.YAML.parse(
  readFileSync(
    path.resolve(import.meta.dir, "../../.github/workflows/publish-container.yml"),
    "utf8",
  ),
) as { jobs: Record<string, Job> };

describe("image publish workflow", () => {
  const writers = Object.entries(workflow.jobs).filter(
    ([, job]) => job.permissions?.packages === "write",
  );

  test("still has a job that can write packages and checks out the repository", () => {
    expect(writers.some(([, job]) => job.steps?.some(isCheckout))).toBe(true);
  });

  test("no checkout leaves the package-writing token in .git/config", () => {
    for (const [name, job] of writers) {
      for (const step of (job.steps ?? []).filter(isCheckout)) {
        expect({ job: name, persist: step.with?.["persist-credentials"] }).toEqual({
          job: name,
          persist: false,
        });
      }
    }
  });

  test("no later step in those jobs needs the stored credential", () => {
    for (const [, job] of writers) {
      for (const step of job.steps ?? []) {
        expect(step.run ?? "").not.toMatch(/\bgit\s+(push|fetch|pull|clone|ls-remote|submodule)\b/);
      }
    }
  });
});

function isCheckout(step: Step): boolean {
  return step.uses?.startsWith("actions/checkout@") === true;
}
