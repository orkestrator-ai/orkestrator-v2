import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { npmWorkflowRunName, NPM_WORKFLOW } from "../../scripts/release-desktop";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on: Record<string, unknown>;
  "run-name": string;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
};

const source = readFileSync(
  path.resolve(import.meta.dir, `../../.github/workflows/${NPM_WORKFLOW}`),
  "utf8",
);
const workflow = Bun.YAML.parse(source) as Workflow;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);

describe("npm publish workflow", () => {
  test("only runs when release:publish dispatches it", () => {
    // A tag push precedes the desktop builds, and a pull request must never
    // reach a job holding an OIDC identity npm trusts.
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  });

  test("names its runs the way release:publish looks for them", () => {
    const expected = npmWorkflowRunName("${{TAG}}").replace("${{TAG}}", "${{ inputs.tag }}");
    expect(workflow["run-name"]).toBe(expected);
  });

  test("grants nothing by default, and the OIDC token to the publishing job alone", () => {
    expect(workflow.permissions).toEqual({});
    const writers = Object.entries(workflow.jobs).filter(
      ([, job]) => job.permissions?.["id-token"] === "write",
    );
    expect(writers.map(([name]) => name)).toEqual(["publish"]);
    expect(workflow.jobs.publish?.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  test("runs only from main, behind the reviewed npm-publish environment", () => {
    const job = workflow.jobs.publish!;
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(job.environment).toBe("npm-publish");
  });

  test("never runs two publishes of one tag at once, and never cancels one half way", () => {
    expect(workflow.concurrency.group).toBe("publish-npm-${{ inputs.tag }}");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  test("does not put the dispatch input into a shell script", () => {
    for (const step of steps) {
      expect(step.run ?? "").not.toContain("inputs.");
    }
    expect(steps.some((step) => step.env?.RELEASE_TAG === "${{ inputs.tag }}")).toBe(true);
  });

  test("checks out the tag without leaving a credential behind", () => {
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toMatchObject({
      ref: "refs/tags/${{ inputs.tag }}",
      "persist-credentials": false,
    });
    for (const step of steps) {
      expect(step.run ?? "").not.toMatch(/\bgit\s+(push|fetch|pull|clone|submodule)\b/);
    }
  });

  test("pins every action to a commit", () => {
    for (const step of steps.filter((candidate) => candidate.uses)) {
      expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });

  test("publishes through the CI mode of publish-cli, with no npm credential anywhere", () => {
    expect(steps.some((step) => step.run?.trim() === "bun scripts/publish-cli.ts --ci")).toBe(true);
    // Trusted publishing is used only when no token is configured.
    expect(source).not.toMatch(/secrets\./);
    expect(source).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|NPM_CONFIG_TOKEN/);
    // `registry-url` would write an .npmrc with a token placeholder.
    expect(steps.some((step) => step.with && "registry-url" in step.with)).toBe(false);
  });

  test("lets Chromium's sandbox start before the smoke test, never by dropping it", () => {
    const names = steps.map((step) => step.name);
    const allow = names.indexOf("Allow unprivileged user namespaces on the disposable runner");
    const publish = steps.findIndex(
      (step) => step.run?.trim() === "bun scripts/publish-cli.ts --ci",
    );
    expect(allow).toBeGreaterThan(-1);
    expect(allow).toBeLessThan(publish);
    expect(steps[allow]?.run).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
    expect(source).not.toMatch(/no-sandbox|chromiumSandbox:\s*false/);
  });

  test("installs the pinned Playwright Chromium before the smoke test", () => {
    const install = steps.findIndex(
      (step) => step.name === "Install the pinned Playwright Chromium",
    );
    const publish = steps.findIndex(
      (step) => step.run?.trim() === "bun scripts/publish-cli.ts --ci",
    );
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(publish);
    expect(steps[install]?.run).toContain("bunx playwright install --with-deps chromium");
  });

  test("refuses a tag that is not a merged release of this package's version", () => {
    const check = steps.find((step) => step.name === "Check the tag is a merged release");
    expect(check?.run).toContain("packages/cli/package.json");
    expect(check?.run).toContain("git merge-base --is-ancestor HEAD origin/main");
  });
});

describe("pull-request smoke test of the npm package", () => {
  const smokeSource = readFileSync(
    path.resolve(import.meta.dir, "../../.github/workflows/smoke-npm-package.yml"),
    "utf8",
  );
  const smoke = Bun.YAML.parse(smokeSource) as Workflow & {
    on: { pull_request?: { types?: string[]; paths?: string[] } };
  };
  const smokeSteps = Object.values(smoke.jobs).flatMap((job) => job.steps ?? []);
  const PREPARATION = [
    "Allow unprivileged user namespaces on the disposable runner",
    "Install the pinned Playwright Chromium",
  ];

  test("prepares the runner exactly as the publish workflow does", () => {
    for (const name of PREPARATION) {
      const here = smokeSteps.find((step) => step.name === name);
      const there = steps.find((step) => step.name === name);
      expect({ name, run: here?.run }).toEqual({ name, run: there?.run });
    }
  });

  test("runs the packed smoke test and can publish nothing", () => {
    expect(smokeSteps.some((step) => step.run?.trim() === "mise run smoke:cli")).toBe(true);
    expect(smoke.permissions).toEqual({});
    for (const job of Object.values(smoke.jobs)) {
      expect(job.permissions).toEqual({ contents: "read" });
      expect(job.environment).toBeUndefined();
    }
    expect(smokeSource).not.toMatch(/secrets\./);
    for (const step of smokeSteps) {
      expect(step.run ?? "").not.toMatch(/npm publish|publish-cli\.ts/);
    }
  });

  test("runs on pull requests that touch what the publish smoke test exercises", () => {
    const paths = smoke.on.pull_request?.paths ?? [];
    for (const required of [
      ".github/workflows/publish-npm.yml",
      "packages/cli/**",
      "scripts/publish-cli.ts",
    ]) {
      expect(paths).toContain(required);
    }
    expect(smoke.on.pull_request?.types).toContain("ready_for_review");
  });

  test("pins every action to a commit", () => {
    for (const step of smokeSteps.filter((candidate) => candidate.uses)) {
      expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
  });
});
