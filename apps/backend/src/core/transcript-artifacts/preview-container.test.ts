/**
 * Container isolation mode. The argument vector is checked everywhere; the
 * live qualification runs only when Docker and the worker image are present
 * (build it with docker/artifact-preview-worker/build.sh), and is skipped with
 * a printed reason otherwise.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { PREVIEW_ADMISSION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type { ArtifactProbeV1 } from "@orkestrator/protocol/transcript-artifacts";
import { DEFAULT_PREVIEW_PROFILE } from "@orkestrator/protocol/transcript-artifacts-validation";

import { TranscriptInteractivePreparer } from "./interactive-prepare.js";
import {
  containerRunArgs,
  previewContainerOwner,
  reapOrphanPreviewContainers,
} from "./preview-supervisor.js";
import { TranscriptPreviewRunner } from "./preview-runner.js";
import {
  DEFAULT_PREVIEW_WORKER_IMAGE,
  PREVIEW_WORKER_USER,
  resolveSeccompProfile,
} from "./runtime.js";

const IMAGE = process.env.ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE ?? DEFAULT_PREVIEW_WORKER_IMAGE;
const imagePresent =
  spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 10_000 }).status ===
  0;
if (!imagePresent)
  console.warn(`[preview-container.test] live cases skipped: Docker or image ${IMAGE} unavailable`);
const liveTest = imagePresent ? test : test.skip;

describe("container isolation", () => {
  test("the docker run vector is fixed and network-less", () => {
    const args = containerRunArgs(
      {
        isolation: "container",
        docker: "docker",
        image: "img:1",
        seccompProfile: "/p.json",
        user: PREVIEW_WORKER_USER,
        memoryBytes: PREVIEW_ADMISSION_POLICY.workerMemoryBytes,
        cpus: 2,
        pids: 128,
      },
      "ork-artifact-preview-x",
    );
    const joined = args.join(" ");
    for (const flag of [
      "--rm",
      "--network none",
      "--read-only",
      "--tmpfs /tmp:rw,nosuid,nodev,size=64m",
      `--memory ${1024 * 1024 * 1024}`,
      "--cpus 2",
      "--pids-limit 128",
      "--user pwuser",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--security-opt seccomp=/p.json",
      "--log-driver none",
    ]) {
      expect(joined).toContain(flag);
    }
    expect(joined).not.toMatch(
      /-v |--volume|--mount|docker\.sock|--network host|--ipc host|--privileged|--no-sandbox/,
    );
    expect(args.at(-1)).toBe("img:1");
    expect(resolveSeccompProfile()).toBeDefined();
  });

  let runner: TranscriptPreviewRunner | undefined;
  afterAll(async () => {
    await runner?.close();
  });

  liveTest(
    "qualifies the worker image: probe, calculator probes, network denial and Mermaid",
    async () => {
      runner = new TranscriptPreviewRunner({
        isolation: "container",
        container: {
          docker: "docker",
          image: IMAGE,
          seccompProfile: resolveSeccompProfile()!,
          user: PREVIEW_WORKER_USER,
        },
      });
      const status = await runner.probe(true);
      if (!status.available) console.error("[preview-container.test] probe:", status.reason);
      expect(status).toMatchObject({ available: true, isolation: "container" });
      const preparer = new TranscriptInteractivePreparer({ frameAncestors: [] });
      const html = readFileSync(path.join(import.meta.dir, "fixtures", "calculator.html"), "utf8");
      const prepared = await preparer.prepare({
        artifactId: "art_container01",
        revision: 1,
        html,
        dependencyIds: [],
        assets: [],
      });
      if (!prepared.ok) throw new Error("preparation failed");
      const probes: ArtifactProbeV1[] = [
        { op: "expect-number", target: "total", equals: 60 },
        { op: "set-number", target: "tasks", value: 8 },
        { op: "expect-number", target: "total", equals: 96 },
      ];
      const result = await runner.run(
        {
          kind: "html-interactive",
          preparedDocument: prepared.prepared.document,
          contentSecurityPolicy: prepared.prepared.contentSecurityPolicy,
          readinessNonce: prepared.prepared.readinessNonce,
          profile: DEFAULT_PREVIEW_PROFILE,
          probes,
        },
        { environmentId: "env-c", conversationKey: "c", operationId: "op_container01" },
        new AbortController().signal,
      );
      if (!result.ok) console.error("[preview-container.test]", result.error, result.diagnostics);
      expect(result.ok).toBe(true);
      const mermaid = await runner.run(
        { kind: "mermaid", source: "flowchart TD\n A-->B", theme: "dark" },
        { environmentId: "env-c", conversationKey: "m", operationId: "op_container02" },
        new AbortController().signal,
      );
      expect(mermaid.ok).toBe(true);

      // A page that never becomes ready: the supervisor kills the container and verifies it is gone.
      const loop = await preparer.prepare({
        artifactId: "art_container02",
        revision: 1,
        html: "<p>x</p><script>for(;;){}</script>",
        dependencyIds: [],
        assets: [],
      });
      if (!loop.ok) throw new Error("preparation failed");
      const exits: boolean[] = [];
      // Own owner label: other test files run container workers concurrently.
      const owner = previewContainerOwner(`/tmp/ork-container-test-${process.pid}`);
      const killer = new TranscriptPreviewRunner({
        isolation: "container",
        container: {
          docker: "docker",
          image: IMAGE,
          seccompProfile: resolveSeccompProfile()!,
          user: PREVIEW_WORKER_USER,
          owner,
        },
        budgets: { readinessMs: 2_000 },
        onWorkerExit: (report) => exits.push(report.verified),
      });
      try {
        const started = Date.now();
        const timedOut = await killer.run(
          {
            kind: "html-interactive",
            preparedDocument: loop.prepared.document,
            contentSecurityPolicy: loop.prepared.contentSecurityPolicy,
            profile: DEFAULT_PREVIEW_PROFILE,
            probes: [],
          },
          { environmentId: "env-k", conversationKey: "k", operationId: "op_container03" },
          new AbortController().signal,
        );
        expect(timedOut.ok).toBe(false);
        if (!timedOut.ok) expect(timedOut.error.code).toBe("render_timeout");
        expect(Date.now() - started).toBeLessThan(PREVIEW_ADMISSION_POLICY.workerWallMs);
        const deadline = Date.now() + 20_000;
        while (killer.stats().running > 0 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 100));
        expect(exits).toEqual([true]);
        const leftovers = spawnSync(
          "docker",
          ["ps", "-aq", "--filter", `label=orkestrator.artifact-preview.owner=${owner}`],
          { encoding: "utf8" },
        ).stdout.trim();
        expect(leftovers).toBe("");
      } finally {
        await killer.close();
      }
    },
    180_000,
  );

  liveTest(
    "startup recovery removes only this backend's orphaned workers",
    async () => {
      const mine = previewContainerOwner("/tmp/ork-reaper-mine");
      const other = previewContainerOwner("/tmp/ork-reaper-other");
      const start = (owner: string, name: string) =>
        spawnSync(
          "docker",
          [
            "run",
            "-d",
            "--name",
            name,
            "--network",
            "none",
            "--label",
            "orkestrator.artifact-preview=1",
            "--label",
            `orkestrator.artifact-preview.owner=${owner}`,
            "--entrypoint",
            "sleep",
            IMAGE,
            "300",
          ],
          { encoding: "utf8", timeout: 30_000 },
        ).status;
      const suffix = Math.random().toString(36).slice(2, 8);
      expect(start(mine, `ork-reap-mine-${suffix}`)).toBe(0);
      expect(start(other, `ork-reap-other-${suffix}`)).toBe(0);
      try {
        expect(await reapOrphanPreviewContainers("docker", mine)).toBe(1);
        const listed = (owner: string) =>
          spawnSync(
            "docker",
            ["ps", "-aq", "--filter", `label=orkestrator.artifact-preview.owner=${owner}`],
            { encoding: "utf8" },
          ).stdout.trim();
        expect(listed(mine)).toBe("");
        expect(listed(other)).not.toBe("");
      } finally {
        spawnSync("docker", ["rm", "-f", `ork-reap-mine-${suffix}`, `ork-reap-other-${suffix}`], {
          stdio: "ignore",
        });
      }
    },
    60_000,
  );
});
