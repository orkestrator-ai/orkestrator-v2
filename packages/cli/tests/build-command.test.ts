import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import {
  BUILD_STEP_INSTRUCTIONS_FRAME_OPEN,
  MAX_BUILD_STEP_INSTRUCTIONS_BYTES,
} from "@orkestrator/protocol/build-pipeline-stage-instructions";
import {
  publicErrorEnvelope,
  publicSuccessEnvelope,
  type PublicActionResponse,
  type PublicCapabilities,
  type PublicReceipt,
} from "@orkestrator/protocol/public-api";
import type { PublicBuildPipelineDetail } from "@orkestrator/protocol/public-api-resources";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/testing/public-api-fixtures";
import {
  createBuildHarness,
  type BuildHarness,
} from "../../../apps/backend/src/core/public-api/build-test-support.js";
import {
  capabilities,
  captureIo,
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
  type GatewayResponder,
  type RecordedRequest,
} from "./support/client-harness.js";

/**
 * `orkestrator build launch|list|get|cancel`: what each flag sends to
 * `public_action`, the refusals that send nothing, and a round trip through a
 * real backend (`public_action`, `BuildPipelineService`, storage, restart).
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  respond: GatewayResponder,
): Promise<{ box: ClientSandbox; gateway: FakeGateway }> {
  const box = await createSandbox();
  const gateway = await startFakeGateway(respond);
  cleanups.push(
    () => box.cleanup(),
    () => gateway.stop(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  const added = await box.run([
    "connection",
    "add",
    "local",
    "--data-dir",
    dataDir,
    "--default",
    "--no-check",
  ]);
  expect(added.code).toBe(0);
  gateway.requests.length = 0;
  return { box, gateway };
}

function requestsFor(gateway: FakeGateway, action: string): RecordedRequest[] {
  return gateway.requests.filter((request) => request.body.args.action === action);
}

function receipt(action: PublicReceipt["action"]): PublicReceipt {
  return {
    ...PUBLIC_API_FIXTURES.runCompleted.receipt!,
    operationId: "op-1790000000000-0a1b2c3d-000000000000000031",
    action,
    state: "succeeded",
    stage: "completed",
    resources: { projectId: "p1", environmentId: "env-1" },
  };
}

const LAUNCHED = {
  pipelineId: "build-1",
  projectId: "p1",
  environmentId: "env-1",
  taskId: "t1",
  phase: "starting-environment",
  reused: false,
};

function fakeBackend(): GatewayResponder {
  return (request) => {
    const action = String(request.body.args.action);
    if (action === "build.launch" || action === "build.cancel") {
      return envelope(
        publicSuccessEnvelope(
          action,
          action === "build.cancel"
            ? { ...LAUNCHED, phase: "failed", reused: undefined }
            : LAUNCHED,
          receipt(action),
        ),
      );
    }
    if (action === "build.get") {
      const detail: PublicBuildPipelineDetail = {
        id: "build-1",
        projectId: "p1",
        environmentId: "env-1",
        taskId: "t1",
        source: "kanban",
        phase: "building",
        iteration: 0,
        maxIterations: 2,
        agent: "claude",
        error: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: null,
        revision: 3,
        steps: {
          build: {
            agent: "claude",
            model: null,
            reasoningEffort: null,
            fastMode: null,
            instructionsBytes: 42,
            lens: null,
          },
        },
        reviewers: [
          {
            agent: "codex",
            model: "gpt-5.5",
            reasoningEffort: "high",
            fastMode: null,
            instructionsBytes: 0,
            lens: { labelBytes: 8, instructionBytes: 35 },
          },
        ],
        reviewPreparation: null,
      };
      return envelope(publicSuccessEnvelope(action, detail));
    }
    if (action === "build.list") {
      return envelope(
        publicSuccessEnvelope(action, {
          items: [
            {
              id: "build-1",
              projectId: "p1",
              environmentId: null,
              taskId: "t1",
              source: "kanban",
              phase: "creating-environment",
              iteration: 0,
              maxIterations: 3,
              agent: "claude",
              error: null,
              createdAt: new Date(0).toISOString(),
              updatedAt: null,
              revision: 1,
            },
          ],
          total: 1,
        }),
      );
    }
    return defaultResponder()(request);
  };
}

describe("build launch", () => {
  test("sends each step's selection and instructions, the reviewer rows and their focus", async () => {
    const { box, gateway } = await fixture(fakeBackend());
    const verifyFile = path.join(box.root, "verify.md");
    await writeFile(verifyFile, "Run the CLI help.\nCheck the new flag is listed.\n");
    const run = await box.run([
      "build",
      "launch",
      "t1",
      "--project",
      "p1",
      "--environment",
      "env-1",
      "--step",
      "verify=codex/gpt-5.5@high",
      "--step",
      "pr=opencode/anthropic/claude-sonnet",
      "--step",
      "preparation=claude",
      "--instructions",
      "build=Write the failing test first.",
      "--instructions-file",
      `verify=${verifyFile}`,
      "--instructions",
      "preparation=Group findings by file.",
      "--reviewer",
      "claude=opus",
      "--reviewer",
      "codex=gpt-5.5@high",
      "--focus",
      "1=Security\nTrace untrusted input.",
      "--instructions",
      "2=Ignore generated files.",
      "--max-iterations",
      "2",
      "--request-id",
      "build-key",
      "--json",
    ]);
    expect(run.code).toBe(0);
    const sent = requestsFor(gateway, "build.launch");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.args.request).toMatchObject({ requestId: "build-key" });
    expect(sent[0]!.body.args.input).toEqual({
      projectId: "p1",
      ticketId: "t1",
      environmentId: "env-1",
      steps: {
        verify: {
          agent: "codex",
          model: "gpt-5.5",
          reasoningEffort: "high",
          instructions: "Run the CLI help.\nCheck the new flag is listed.\n",
        },
        pr: { agent: "opencode", model: "anthropic/claude-sonnet" },
        build: { instructions: "Write the failing test first." },
      },
      reviewers: [
        {
          agent: "claude",
          model: "opus",
          lens: { label: "Security", instruction: "Trace untrusted input." },
        },
        {
          agent: "codex",
          model: "gpt-5.5",
          reasoningEffort: "high",
          instructions: "Ignore generated files.",
        },
      ],
      reviewPreparation: { agent: "claude", instructions: "Group findings by file." },
      maxIterations: 2,
    });
    const output = JSON.parse(run.out);
    expect(output).toMatchObject({ ok: true, action: "build.launch", result: LAUNCHED });

    const ids = await box.run([
      "build",
      "launch",
      "t1",
      "--project",
      "p1",
      "--type",
      "container",
      "--base-branch",
      "main",
      "--base-commit",
      "a".repeat(40),
      "--agent",
      "codex",
      "--output",
      "id",
    ]);
    expect(ids.code).toBe(0);
    expect(ids.out.trim()).toBe("build-1");
    expect(requestsFor(gateway, "build.launch")[1]!.body.args.input).toEqual({
      projectId: "p1",
      ticketId: "t1",
      type: "container",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      agent: "codex",
    });
  });

  test("reads one step's instructions from stdin", async () => {
    const { box, gateway } = await fixture(fakeBackend());
    const io = captureIo(box.env, box.root);
    io.stdinBytes = new TextEncoder().encode("Address every nit.");
    const run = await box.run(
      [
        "build",
        "launch",
        "t1",
        "--project",
        "p1",
        "--type",
        "local",
        "--instructions-file",
        "address=-",
        "--json",
      ],
      io,
    );
    expect(run.code).toBe(0);
    expect(requestsFor(gateway, "build.launch")[0]!.body.args.input).toMatchObject({
      steps: { address: { instructions: "Address every nit." } },
    });
  });

  test("refuses bad flags with exit 2 and sends nothing", async () => {
    const { box, gateway } = await fixture(fakeBackend());
    const big = path.join(box.root, "big.md");
    await writeFile(big, "x".repeat(MAX_BUILD_STEP_INSTRUCTIONS_BYTES + 1));
    const base = ["build", "launch", "t1", "--project", "p1"];
    for (const argv of [
      ["build", "launch", "t1", "--type", "local"],
      [...base],
      [...base, "--type", "local", "--environment", "env-1"],
      [...base, "--type", "vm"],
      [...base, "--type", "local", "--step", "ship=claude"],
      [...base, "--type", "local", "--step", "build=gpt-5.5"],
      [...base, "--type", "local", "--step", "build=claude/"],
      [...base, "--type", "local", "--step", "build=claude", "--step", "build=codex"],
      [...base, "--type", "local", "--instructions", "build"],
      [...base, "--type", "local", "--instructions", "ship=x"],
      [...base, "--type", "local", "--instructions", "build=a", "--instructions", "build=b"],
      [...base, "--type", "local", "--instructions-file", `build=${big}`],
      [...base, "--type", "local", "--instructions", `build=${"é".repeat(8193)}`],
      [...base, "--type", "local", "--reviewer", "claude=opus", "--instructions", "2=x"],
      [...base, "--type", "local", "--reviewer", "claude=opus", "--instructions", "review=x"],
      [...base, "--type", "local", "--reviewer", "claude=opus", "--step", "review=codex"],
      [...base, "--type", "local", "--focus", "1=Security"],
      [...base, "--type", "local", "--max-iterations", "11"],
      [...base, "--type", "local", "--max-iterations", "0"],
    ]) {
      const bad = await box.run([...argv, "--json"]);
      expect({ argv, code: bad.code }).toEqual({ argv, code: 2 });
      expect(JSON.parse(bad.out).ok).toBe(false);
    }
    expect(requestsFor(gateway, "build.launch")).toHaveLength(0);
  });

  test("the backend's refusals keep their exit classes", async () => {
    const { box } = await fixture((request) => {
      const action = String(request.body.args.action);
      const input = request.body.args.input as { ticketId?: string };
      if (action === "build.launch") {
        return envelope(
          publicErrorEnvelope(
            action,
            input.ticketId === "missing"
              ? { code: "not-found", message: "Ticket not found in project: missing" }
              : { code: "input-too-large", message: "steps.build.instructions is too large" },
          ) as PublicActionResponse,
        );
      }
      return defaultResponder()(request);
    });
    const missing = await box.run([
      "build",
      "launch",
      "missing",
      "--project",
      "p1",
      "--type",
      "local",
      "--json",
    ]);
    expect(missing.code).toBe(3);
    expect(JSON.parse(missing.out).error.code).toBe("not-found");
    const large = await box.run([
      "build",
      "launch",
      "t1",
      "--project",
      "p1",
      "--type",
      "local",
      "--json",
    ]);
    expect(large.code).toBe(2);
  });
});

describe("build list, get and cancel", () => {
  test("read summaries with sizes and cancel by ID", async () => {
    const { box, gateway } = await fixture(fakeBackend());
    const got = await box.run(["build", "get", "build-1"]);
    expect(got.code).toBe(0);
    expect(got.out).toContain("instructions 42 B");
    expect(got.out).toContain("codex/gpt-5.5@high (focus 43 B)");
    expect(requestsFor(gateway, "build.get")[0]!.body.args.input).toEqual({
      pipelineId: "build-1",
    });

    const listed = await box.run(["build", "list", "--project", "p1", "--output", "id"]);
    expect(listed.code).toBe(0);
    expect(listed.out.trim()).toBe("build-1");
    expect((await box.run(["build", "list", "--json"])).code).toBe(2);

    const cancelled = await box.run(["build", "cancel", "build-1", "--request-id", "c1", "--json"]);
    expect(cancelled.code).toBe(0);
    expect(JSON.parse(cancelled.out).result.phase).toBe("failed");
    expect(requestsFor(gateway, "build.cancel")[0]!.body.args).toMatchObject({
      input: { pipelineId: "build-1" },
      request: { requestId: "c1" },
    });
  });
});

describe("round trip through a real backend", () => {
  /**
   * Runs every action through the real backend's `public_action`. Responses
   * carry the sandbox descriptor's identity, so the client sees one backend
   * across the restart, as it would across a service restart that kept its
   * installation; the request-key namespaces are the real backend's.
   */
  function forwardTo(target: { build: BuildHarness }): GatewayResponder {
    return async (request) => {
      const { harness } = target.build;
      const response = (await harness.commands.get("public_action")!(
        request.body.args,
        harness.context,
      )) as PublicActionResponse;
      if (response.ok && response.action === "capabilities") {
        const real = response.result as PublicCapabilities;
        return envelope({
          ...response,
          result: { ...real, backend: { ...real.backend, ...capabilities().backend } },
        });
      }
      return envelope(response);
    };
  }

  test("per-step instructions and lenses launched with the CLI land on the record and survive a restart", async () => {
    const target = { build: await createBuildHarness() };
    cleanups.push(() => target.build.cleanup());
    const { box } = await fixture(forwardTo(target));
    const instructionsFile = path.join(box.root, "build.md");
    const buildRules = "BUILD-RULES: write the failing test first.\nKeep the diff small.";
    await writeFile(instructionsFile, `${buildRules}\n`);
    const { projectId, ticketId } = target.build;
    const launch = [
      "build",
      "launch",
      ticketId,
      "--project",
      projectId,
      "--environment",
      "env-1",
      "--instructions-file",
      `build=${instructionsFile}`,
      "--instructions",
      "verify=VERIFY-RULES: run the CLI help.",
      "--reviewer",
      "claude=claude-opus-5",
      "--reviewer",
      "codex=gpt-5.5@high",
      "--focus",
      "1=Security\nTrace untrusted input to its sinks.",
      "--instructions",
      "2=REVIEWER-RULES: ignore generated files.",
      "--max-iterations",
      "2",
      "--request-id",
      "round-trip",
      "--json",
    ];
    const launched = await box.run(launch);
    expect(launched.code).toBe(0);
    const envelopeOut = JSON.parse(launched.out);
    expect(envelopeOut.receipt).toMatchObject({ action: "build.launch", state: "succeeded" });
    const pipelineId = envelopeOut.result.pipelineId as string;
    // The CLI prints the backend's receipt: IDs and states, never the text.
    for (const text of ["BUILD-RULES", "VERIFY-RULES", "REVIEWER-RULES", "untrusted input"]) {
      expect(launched.out).not.toContain(text);
    }

    // The same request key replays the launch instead of starting another.
    const replay = await box.run(launch);
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.out).receipt).toMatchObject({ replayed: true });

    target.build = await target.build.restart();
    const record = (await target.build.harness.storage.getBuildPipeline(pipelineId))!
      .snapshot as BuildPipeline;
    expect(record.steps?.build?.instructions).toBe(buildRules);
    expect(record.steps?.verify?.instructions).toBe("VERIFY-RULES: run the CLI help.");
    expect(record.reviewers).toEqual([
      {
        agent: "claude",
        model: "claude-opus-5",
        lens: { label: "Security", instruction: "Trace untrusted input to its sinks." },
      },
      {
        agent: "codex",
        model: "gpt-5.5",
        reasoningEffort: "high",
        instructions: "REVIEWER-RULES: ignore generated files.",
      },
    ]);
    expect(record.maxIterations).toBe(2);
    expect(await target.build.harness.storage.listBuildPipelines(projectId)).toHaveLength(1);

    const got = await box.run(["build", "get", pipelineId, "--json"]);
    expect(got.code).toBe(0);
    const detail = JSON.parse(got.out).result as PublicBuildPipelineDetail;
    expect(detail.steps.build?.instructionsBytes).toBe(Buffer.byteLength(buildRules));
    expect(detail.reviewers[0]?.lens).toEqual({ labelBytes: 8, instructionBytes: 35 });
    expect(detail.reviewers[1]?.instructionsBytes).toBe(
      Buffer.byteLength("REVIEWER-RULES: ignore generated files."),
    );
    expect(got.out).not.toContain("BUILD-RULES");

    // The restarted backend's Build prompt carries the instructions.
    for (let pass = 0; pass < 10 && target.build.provider.sent.length === 0; pass += 1) {
      await target.build.service.advanceNow(pipelineId);
    }
    const opening = target.build.provider.sent[0]?.prompt ?? "";
    expect(opening).toContain(BUILD_STEP_INSTRUCTIONS_FRAME_OPEN);
    expect(opening).toContain(buildRules);

    const cancelled = await box.run(["build", "cancel", pipelineId, "--json"]);
    expect(cancelled.code).toBe(0);
    expect(JSON.parse(cancelled.out).result).toMatchObject({ pipelineId, phase: "failed" });
  });
});
