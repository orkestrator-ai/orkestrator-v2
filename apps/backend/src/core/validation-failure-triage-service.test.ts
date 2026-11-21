import { describe, expect, spyOn, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import {
  summarizeValidationFailureTriage,
  validationFailureId,
  validationFailureKey,
  type ValidationFailureTriage,
} from "@orkestrator/protocol/validation-failure-triage";
import {
  applySharedBaseEvidence,
  classifierPayload,
  MAX_TRIAGE_PAYLOAD_BASE64_BYTES,
  mergeBaseRerunExec,
  sharedFailureSummaries,
  triageValidationFailures,
} from "./validation-failure-triage-service.js";
import type { ValidationFailureClassifierInput } from "./validation-failure-classifier.js";

import * as shell from "./shell.js";
import { CommandFailedError } from "./shell.js";

const BASE = "c".repeat(40);
const e2eKey = validationFailureKey("playwright", "e2e/a.spec.ts", "opens the pane");

function triage(
  verdict: "related" | "unrelated" | "undetermined" = "undetermined",
): ValidationFailureTriage {
  return {
    version: 1,
    mergeBase: BASE,
    commands: [
      {
        command: "mise run test:browser",
        failures: [
          {
            key: e2eKey,
            runner: "playwright",
            file: "e2e/a.spec.ts",
            name: "opens the pane",
            outcome: "failed",
            verdict,
            reasons: ["not-import-traceable"],
          },
        ],
        omittedFailures: 0,
        unattributed: false,
      },
    ],
    limitations: [],
  };
}

describe("classifierPayload", () => {
  const input: ValidationFailureClassifierInput = {
    root: "/workspace",
    commands: [],
    changedFiles: ["src/a.ts"],
    mergeBase: null,
    ci: null,
  };

  test("passes a small input through unchanged", () => {
    const decoded = JSON.parse(Buffer.from(classifierPayload(input), "base64").toString());
    expect(decoded).toEqual(input);
  });

  test("cuts a changed-file list that would not fit and says so", () => {
    const changedFiles = Array.from({ length: 5_000 }, (_, i) => `src/module-${i}/file.ts`);
    const payload = classifierPayload({ ...input, changedFiles });
    expect(payload.length).toBeLessThanOrEqual(MAX_TRIAGE_PAYLOAD_BASE64_BYTES);
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString());
    expect(decoded.changedFilesTruncated).toBe(true);
    expect(decoded.changedFiles.length).toBeGreaterThan(0);
    expect(decoded.changedFiles.length).toBeLessThan(changedFiles.length);
  });
});

describe("failures shared on the same merge-base", () => {
  const otherSummary = summarizeValidationFailureTriage(triage("unrelated"));

  test("another pipeline's independently unrelated failure supplies evidence", () => {
    const result = applySharedBaseEvidence(triage(), [otherSummary]);
    expect(result.commands[0]!.failures[0]).toMatchObject({
      verdict: "unrelated",
      reasons: ["not-import-traceable", "failed-on-same-base"],
    });
  });

  test("a failure the other branch caused, or one on another base, is not evidence", () => {
    const caused = summarizeValidationFailureTriage(triage("related"));
    expect(applySharedBaseEvidence(triage(), [caused]).commands[0]!.failures[0]!.verdict).toBe(
      "undetermined",
    );
    const elsewhere = { ...otherSummary, mergeBase: "d".repeat(40) };
    expect(applySharedBaseEvidence(triage(), [elsewhere]).commands[0]!.failures[0]!.verdict).toBe(
      "undetermined",
    );
  });

  test("summaries come from other environments in the project only", async () => {
    const record = (environmentId: string, projectId: string) => ({
      environmentId,
      projectId,
      snapshot: { validationHistory: [{ failures: otherSummary }, { failures: "bad" }] },
    });
    const storage = {
      listAllBuildPipelines: async () => [
        record("env-self", "project-1"),
        record("env-other", "project-1"),
        record("env-foreign", "project-2"),
      ],
    };
    const summaries = await sharedFailureSummaries({ storage } as never, {
      id: "env-self",
      projectId: "project-1",
    });
    expect(summaries).toEqual([otherSummary]);
    expect(summaries[0]!.ids).toEqual([validationFailureId(e2eKey)]);
  });
});

test("shared-base evidence neither launders uncertainty nor overrides related evidence", () => {
  const uncertain = summarizeValidationFailureTriage(triage());
  expect(applySharedBaseEvidence(triage(), [uncertain])).toEqual(triage());
  const base = summarizeValidationFailureTriage(triage("unrelated"));
  expect(applySharedBaseEvidence(triage("related"), [base])).toEqual(triage("related"));
  const flipped = summarizeValidationFailureTriage(applySharedBaseEvidence(triage(), [base]));
  expect(flipped.baseIds).toEqual([]);
  expect(applySharedBaseEvidence(triage(), [flipped])).toEqual(triage());
  const { baseIds: _legacy, ...legacy } = base;
  expect(applySharedBaseEvidence(triage(), [legacy])).toEqual(triage());
});

for (const environmentType of ["local", "container"] as const) {
  test(`triage resolves merge-base and execution root for ${environmentType}`, async () => {
    let input: ValidationFailureClassifierInput | undefined;
    const outcome = await triageValidationFailures({
      environment: {
        id: "env",
        projectId: "project",
        environmentType,
        worktreePath: "/test-worktree",
        containerId: "test-container",
      } as never,
      runner: async (command, args) => {
        expect(command).toBe("git");
        expect(args).toEqual(["merge-base", "HEAD", "origin/develop"]);
        return BASE;
      },
      context: {
        storage: { getProject: async () => null, listAllBuildPipelines: async () => [] },
      } as never,
      targetRef: "origin/develop",
      changedFiles: [],
      commands: [
        { command: "test", cwd: ".", status: "incomplete", stdoutPath: null, stderrPath: null },
      ],
      execute: async (_script, payload) => {
        input = JSON.parse(Buffer.from(payload, "base64").toString());
        return JSON.stringify(triage());
      },
    });
    expect(input).toMatchObject({
      root: environmentType === "local" ? "/test-worktree" : "/workspace",
      mergeBase: BASE,
    });
    expect(outcome.triage).toEqual(triage());
  });
}
for (const failure of ["merge-base", "invalid", "exec"] as const) {
  test(`triage records ${failure} failure conservatively`, async () => {
    const outcome = await triageValidationFailures({
      environment: {
        id: "env",
        projectId: "project",
        environmentType: "container",
        containerId: "test-container",
      } as never,
      runner: async () => {
        if (failure === "merge-base") throw new Error("git unavailable");
        return BASE;
      },
      context: {
        storage: { getProject: async () => null, listAllBuildPipelines: async () => [] },
      } as never,
      targetRef: "origin/main",
      changedFiles: [],
      commands: [
        { command: "test", cwd: ".", status: "incomplete", stdoutPath: null, stderrPath: null },
      ],
      execute: async (_script, payload) => {
        if (failure === "exec") throw new Error("exec failed");
        if (failure === "invalid") return "{}";
        expect(JSON.parse(Buffer.from(payload, "base64").toString()).mergeBase).toBeNull();
        return JSON.stringify({ ...triage(), mergeBase: null });
      },
    });
    if (failure === "merge-base") expect(outcome.triage!.mergeBase).toBeNull();
    else
      expect(outcome.limitation).toContain(
        failure === "invalid" ? "invalid result" : "could not run",
      );
  });
}

for (const environmentType of ["local", "container"] as const) {
  test(`executes classifier through the ${environmentType} transport`, async () => {
    const spy = spyOn(shell, "runCommand").mockResolvedValue({
      stdout: JSON.stringify(triage()),
      stderr: "",
    });
    try {
      const outcome = await triageValidationFailures({
        environment: {
          id: "env",
          projectId: "project",
          environmentType,
          worktreePath: "/workspace-fixture",
          containerId: "owned-container",
        } as never,
        runner: async () => BASE,
        context: {
          appRoot: "/missing-app",
          resourceRoot: "/missing-resources",
          storage: { getProject: async () => null, listAllBuildPipelines: async () => [] },
        } as never,
        targetRef: "origin/main",
        changedFiles: [],
        commands: [
          { command: "test", cwd: ".", status: "incomplete", stdoutPath: null, stderrPath: null },
        ],
      });
      expect(outcome.triage).toEqual(triage());
      expect(spy).toHaveBeenCalledTimes(1);
      const [binary, args, options] = spy.mock.calls[0]!;
      if (environmentType === "container") {
        expect(binary).toBe("docker");
        expect(args!.slice(0, 6)).toEqual([
          "exec",
          "--workdir",
          "/",
          "owned-container",
          "bash",
          "-lc",
        ]);
      } else {
        expect(args![0]).toBe("-e");
        expect(options!.cwd).toBe("/");
      }
      expect(options!.timeoutMs).toBe(90000);
    } finally {
      spy.mockRestore();
    }
  });
}

describe("merge-base rerun", () => {
  const bunKey = validationFailureKey("bun", "tests/a.test.ts", "suite > breaks");
  const bunTriage: ValidationFailureTriage = {
    version: 1,
    mergeBase: BASE,
    commands: [
      {
        command: "mise run test",
        failures: [
          {
            key: bunKey,
            runner: "bun",
            file: "tests/a.test.ts",
            name: "suite > breaks",
            outcome: "failed",
            verdict: "undetermined",
            reasons: ["reaches-changed-file-indirectly"],
          },
        ],
        omittedFailures: 0,
        unattributed: false,
      },
    ],
    limitations: [],
  };

  test("maps a non-zero exit to a result and keeps other errors", async () => {
    const exec = mergeBaseRerunExec(async () => {
      throw new CommandFailedError("failed", { stdout: "(fail) x", exitCode: 1 });
    });
    expect(await exec("true", [], 10)).toEqual({
      exitCode: 1,
      output: "(fail) x",
      timedOut: false,
    });
    const broken = mergeBaseRerunExec(async () => {
      throw new Error("no runner");
    });
    await expect(broken("true", [], 10)).rejects.toThrow("no runner");
  });

  for (const environmentType of ["local", "container"] as const) {
    test(`runs through the ${environmentType} environment runner and labels the failure`, async () => {
      const bashCalls: string[][] = [];
      const outcome = await triageValidationFailures({
        environment: {
          id: "env",
          projectId: "project",
          environmentType,
          worktreePath: "/test-worktree",
          containerId: "test-container",
        } as never,
        runner: async (command, args) => {
          if (command === "git") return BASE;
          expect(command).toBe("bash");
          expect(args.slice(0, 1)).toEqual(["-lc"]);
          expect(args[2]).toBe("merge-base-rerun");
          bashCalls.push(args.slice(3));
          const script = args[1]!;
          if (script.includes("ls-files")) {
            return ["package.json", "bun.lock", "bunfig.toml", "tests/a.test.ts"].join("\n");
          }
          if (script.includes(" test ")) {
            throw new CommandFailedError("failed", {
              stdout: "(fail) suite > breaks [2ms]\n 0 pass\n 1 fail\n",
              exitCode: 1,
            });
          }
          return "";
        },
        context: {
          storage: { getProject: async () => null, listAllBuildPipelines: async () => [] },
        } as never,
        targetRef: "origin/main",
        changedFiles: ["src/x.ts"],
        commands: [
          {
            command: "mise run test",
            cwd: ".",
            status: "failed",
            stdoutPath: null,
            stderrPath: null,
          },
        ],
        execute: async () => JSON.stringify(bunTriage),
      });
      expect(outcome.triage!.commands[0]!.failures[0]).toMatchObject({
        verdict: "unrelated",
        reasons: ["reaches-changed-file-indirectly", "failed-on-merge-base"],
      });
      const checkout = bashCalls[0]![0]!;
      expect(checkout).toContain("orkestrator-merge-base-");
      // Never inside the reviewed worktree.
      expect(checkout.startsWith("/test-worktree")).toBe(false);
      expect(path.dirname(checkout)).toBe(environmentType === "local" ? os.tmpdir() : "/tmp");
      // Checkout, listing, install, test, cleanup: all in the same directory.
      expect(bashCalls).toHaveLength(5);
      expect(bashCalls.every((args) => args[0]!.startsWith(checkout))).toBe(true);
    });
  }

  test("mergeBaseExec false skips the rerun", async () => {
    const outcome = await triageValidationFailures({
      environment: {
        id: "env",
        projectId: "project",
        environmentType: "container",
        containerId: "c",
      } as never,
      runner: async (command) => {
        expect(command).toBe("git");
        return BASE;
      },
      context: {
        storage: { getProject: async () => null, listAllBuildPipelines: async () => [] },
      } as never,
      targetRef: "origin/main",
      changedFiles: [],
      commands: [
        {
          command: "mise run test",
          cwd: ".",
          status: "failed",
          stdoutPath: null,
          stderrPath: null,
        },
      ],
      execute: async () => JSON.stringify(bunTriage),
      mergeBaseExec: false,
    });
    expect(outcome.triage).toEqual(bunTriage);
  });
});
