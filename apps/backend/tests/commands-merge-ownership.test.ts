import { expect, spyOn, test } from "bun:test";
import * as shell from "../src/core/shell";
import * as containerExec from "../src/core/commands-container-exec";
import {
  mergePullRequestInContainer,
  mergePullRequestViaGitHubApi,
} from "../src/core/commands-review";
import { createCommandFixtures } from "./command-fixtures";

const {
  createCommandRegistry,
  createContext,
  createEnvironment,
  withFakeDocker,
  ownedContainerInspect,
} = await createCommandFixtures();
const environmentId = "01234567-89ab-4000-8000-000000000000";
const own = "feature-0123456789ab";
const prUrl = "https://github.com/acme/repo/pull/42";
const cases = [
  { name: "own head", branch: own, deletes: true },
  { name: "adopted head", branch: "dev", deletes: false },
  { name: "foreign environment", branch: "feature-deadbeefcafe", deletes: false },
  { name: "fork", branch: own, repo: "fork/repo", deletes: false },
  { name: "missing metadata", branch: own, missing: true, deletes: false },
  { name: "unreadable head", branch: own, unreadable: true, deletes: false },
  { name: "deletion off", branch: own, keep: true, deletes: false },
];

for (const scenario of cases) {
  for (const mode of ["api", "container"] as const) {
    test(`${mode} merge ${scenario.name} respects ownership`, async () => {
      const calls: string[] = [];
      const { context } = createContext(
        createEnvironment({
          id: environmentId,
          branch: own,
          prUrl,
          worktreePath: "/unused",
          environmentType: mode === "api" ? "local" : "containerized",
          containerId: mode === "container" ? "container-test" : null,
        }),
      );
      const respond = (command: string) => {
        calls.push(command);
        if (command.includes("isDraft")) return "false";
        if (command.includes("pulls/42") && !command.includes("/merge")) {
          if (scenario.unreadable) throw new Error("head lookup unavailable");
          return JSON.stringify({
            head: { ref: scenario.branch, repo: { full_name: scenario.repo ?? "acme/repo" } },
            ...(scenario.missing ? {} : { base: { repo: { full_name: "acme/repo" } } }),
          });
        }
        if (command.includes("state")) return "MERGED";
        if (command.includes("/merge")) return '{"merged":true}';
        return "";
      };
      const local = spyOn(shell, "runCommand").mockImplementation(async (_command, args = []) => ({
        stdout: respond(args.join(" ")),
        stderr: "",
      }));
      const container = spyOn(containerExec, "dockerExec").mockImplementation(
        async (_id, command) => respond(command),
      );
      const follow = spyOn(
        context.runtime.prMonitor,
        "followMergeIntoProjectCheckout",
      ).mockImplementation(() => undefined);
      try {
        const owner = scenario.keep ? null : environmentId;
        const result =
          mode === "api"
            ? await mergePullRequestViaGitHubApi(
                context.storage,
                undefined,
                prUrl,
                "squash",
                owner,
                "/unused",
              )
            : await mergePullRequestInContainer(
                "container-test",
                "squash",
                owner,
                undefined,
                prUrl,
              );
        expect(result).toEqual({ outcome: "merged" });
        expect(
          calls.some((call) => call.includes("DELETE") || call.includes("--delete-branch")),
        ).toBe(scenario.deletes);
        expect(calls.some((call) => call.includes("pulls/42") && !call.includes("/merge"))).toBe(
          !scenario.keep,
        );
        calls.length = 0;
        const commandResult = await createCommandRegistry().get(
          mode === "api" ? "merge_pr_local" : "merge_pr",
        )!(
          {
            ...(mode === "api" ? { environmentId } : { containerId: "container-test" }),
            method: "squash",
            deleteBranch: !scenario.keep,
          },
          context,
        );
        expect(commandResult).toEqual({ outcome: "merged" });
        expect(
          calls.some((call) => call.includes("DELETE") || call.includes("--delete-branch")),
        ).toBe(scenario.deletes);
        expect(calls.some((call) => call.includes("pulls/42") && !call.includes("/merge"))).toBe(
          !scenario.keep,
        );
      } finally {
        follow.mockRestore();
        local.mockRestore();
        container.mockRestore();
      }
    });
  }
}

test("orphan-container command merges while retaining the head without looking up ownership", async () => {
  const { context } = createContext([]);
  const calls: string[] = [];
  const container = spyOn(containerExec, "dockerExec").mockImplementation(async (_id, command) => {
    calls.push(command);
    if (command.includes("isDraft")) return "false";
    if (command.includes("'.url'")) return prUrl;
    if (command.includes("'.state'")) return "MERGED";
    return "";
  });
  try {
    await withFakeDocker(`#!/bin/sh\n${ownedContainerInspect()}\nexit 1\n`, async () => {
      const result = await createCommandRegistry().get("merge_pr")!(
        { containerId: "orphan-container", method: "merge", deleteBranch: true },
        context,
      );
      expect(result).toEqual({ outcome: "merged" });
      expect(calls.some((call) => call.includes("'pr' 'merge'"))).toBe(true);
      expect(calls.some((call) => call.includes("--delete-branch") || call.includes("'api'"))).toBe(
        false,
      );
    });
  } finally {
    container.mockRestore();
  }
}, 30_000);
