/**
 * Development source hints: the backend sets `verified` itself, from a real
 * containment and existence check of each hint's path in the environment
 * workspace, and advertises `operations.sourceHints` only when that check is
 * wired.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  WebAnnotationCaptureInput,
  WebAnnotationSourceHint,
} from "@orkestrator/protocol/web-annotations";
import {
  fixtureCaptureInput,
  fixtureDestination,
} from "@orkestrator/protocol/testing/web-annotations-fixtures";
import type { DispatchEnvironment } from "./web-annotation-contracts.js";
import { StorageService } from "./storage.js";
import { WebAnnotationDispatchAdapter } from "./web-annotation-dispatch.js";
import { checkWebAnnotationWorkspacePaths } from "./web-annotation-source-checks.js";
import { ENV_A, createHarness, type ServiceHarness } from "./web-annotation-test-support.js";

let harness: ServiceHarness;
const dirs: string[] = [];
afterEach(async () => {
  await harness?.cleanup();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A local worktree with one source file, plus a file outside it behind a symlink. */
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "ork-source-hints-"));
  const outside = await mkdtemp(join(tmpdir(), "ork-source-hints-outside-"));
  dirs.push(root, outside);
  await mkdir(join(root, "apps/web/src"), { recursive: true });
  await writeFile(join(root, "apps/web/src/Save.tsx"), "export {};\n");
  await writeFile(join(outside, "secret.ts"), "export {};\n");
  await symlink(join(outside, "secret.ts"), join(root, "apps/web/src/link.ts"));
  return root;
}

async function wiredHarness() {
  harness = await createHarness();
  const root = await workspace();
  harness.host.environments.set(ENV_A, {
    id: ENV_A,
    environmentType: "local",
    worktreePath: root,
    containerId: null,
  });
  const checked: string[][] = [];
  (harness.dispatch as { checkWorkspacePaths?: unknown }).checkWorkspacePaths = (
    environment: DispatchEnvironment,
    paths: readonly string[],
  ) => {
    checked.push([...paths]);
    return checkWebAnnotationWorkspacePaths(environment, paths);
  };
  return { checked, root };
}

const HINTS: WebAnnotationSourceHint[] = [
  { producer: "vite-dev", path: "apps/web/src/Save.tsx", line: 12, verified: false },
  { producer: "vite-dev", path: "apps/web/src/Gone.tsx", verified: false },
  { producer: "vite-dev", path: "apps/web/src/link.ts", verified: false },
  { producer: "vite-dev", path: "../outside.ts", verified: false },
];

function hinted(hints = HINTS): WebAnnotationCaptureInput {
  const base = fixtureCaptureInput("element");
  return { ...base, evidence: { ...base.evidence!, sourceHints: hints } };
}

function verifiedPaths(hints: WebAnnotationSourceHint[] | undefined) {
  return hints?.map((hint) => [hint.path, hint.verified]);
}

const EXPECTED = [
  ["apps/web/src/Save.tsx", true],
  ["apps/web/src/Gone.tsx", false],
  // A symlink resolving outside the workspace and a lexical escape stay unverified.
  ["apps/web/src/link.ts", false],
  ["../outside.ts", false],
];

describe("source hint capability", () => {
  test("is advertised only when the workspace check is wired", async () => {
    harness = await createHarness();
    expect((await harness.service.capabilities(ENV_A)).operations.sourceHints).toBe(false);
    await harness.cleanup();
    await wiredHarness();
    expect((await harness.service.capabilities(ENV_A)).operations.sourceHints).toBe(true);
  });

  test("is off when authoring is off", async () => {
    harness = await createHarness({ rolloutMode: () => "read-only" });
    (harness.dispatch as { checkWorkspacePaths?: unknown }).checkWorkspacePaths = async () => [];
    expect((await harness.service.capabilities(ENV_A)).operations.sourceHints).toBe(false);
  });
});

describe("source hint verification", () => {
  test("a new note verifies only hints whose path exists inside the workspace", async () => {
    const { checked } = await wiredHarness();
    const receipt = await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-hinted",
      capture: hinted(),
      body: "Hinted.",
    });
    expect(checked).toEqual([HINTS.map((hint) => hint.path)]);
    const capture = await harness.service.capture(ENV_A, receipt.captureId!);
    expect(verifiedPaths(capture.evidence?.sourceHints)).toEqual(EXPECTED);
    // Line and producer are kept as reported; only the path was checked.
    expect(capture.evidence?.sourceHints?.[0]).toEqual({ ...HINTS[0]!, verified: true });
  });

  test("a replaced capture is checked again", async () => {
    await wiredHarness();
    const created = await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-plain",
      capture: fixtureCaptureInput("element"),
      body: "Plain.",
    });
    const { annotation } = await harness.service.get(ENV_A, created.annotationId!);
    const receipt = await harness.service.replaceCapture({
      environmentId: ENV_A,
      operationId: "op-replace",
      annotationId: annotation.id,
      expectedContentRevision: annotation.contentRevision,
      capture: hinted(),
    });
    const capture = await harness.service.capture(ENV_A, receipt.captureId!);
    expect(verifiedPaths(capture.evidence?.sourceHints)).toEqual(EXPECTED);
  });

  for (const mutation of ["create", "replace"] as const) {
    for (const initiallyExists of [false, true]) {
      test(`${mutation} replays its original receipt after a hinted file ${initiallyExists ? "disappears" : "appears"}`, async () => {
        const { root } = await wiredHarness();
        const path = "apps/web/src/Replay.tsx";
        const file = join(root, path);
        if (initiallyExists) await writeFile(file, "export {};\n");
        const capture = hinted([{ producer: "vite-dev", path, verified: false }]);
        const base = {
          environmentId: ENV_A,
          operationId: "op-replay",
          capture,
          body: "Replay source verification.",
        };
        const original = await harness.service.create({
          ...base,
          operationId: "op-original",
          capture: fixtureCaptureInput("element"),
        });
        const replacement = {
          ...base,
          annotationId: original.annotationId!,
          expectedContentRevision: original.contentRevision,
        };
        const submit = () =>
          mutation === "create"
            ? harness.service.create(base)
            : harness.service.replaceCapture(replacement);
        const receipt = await submit();
        const stored = await harness.service.capture(ENV_A, receipt.captureId!);
        expect(stored.evidence?.sourceHints).toEqual([
          { producer: "vite-dev", path, verified: initiallyExists },
        ]);
        if (initiallyExists) await rm(file);
        else await writeFile(file, "export {};\n");
        // Establish that a fresh check really sees a different state on replay.
        expect(
          await checkWebAnnotationWorkspacePaths(
            { id: ENV_A, environmentType: "local", worktreePath: root },
            [path],
          ),
        ).toEqual([{ path, status: initiallyExists ? "missing" : "exists" }]);
        expect(await submit()).toEqual(receipt);
        expect(await harness.service.capture(ENV_A, receipt.captureId!)).toEqual(stored);
        const current = await harness.service.get(ENV_A, receipt.annotationId!);
        expect(current.revision).toBe(receipt.environmentRevision);
        expect(current.annotation.currentCaptureId).toBe(receipt.captureId!);
      });
    }
  }

  test("non-local hints dispatch to the container checker and persist its statuses", async () => {
    const { root } = await wiredHarness();
    // A host worktree exists, but a non-local environment must use its container.
    harness.host.environments.set(ENV_A, {
      id: ENV_A,
      environmentType: "docker",
      worktreePath: root,
      containerId: "source-hints-container",
    });
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const adapter = new WebAnnotationDispatchAdapter({
      // Path checks use the command boundary, without opening the host store.
      storage: new StorageService(join(harness.dir, "dispatch-host")),
      nativeAgents: null,
      invoke: async (command, args) => {
        calls.push({ command, args });
        // Deliberately disagree with the host: Save exists there, Gone does not.
        return ["missing", "exists", "outside-workspace"];
      },
    });
    Object.assign(harness.dispatch, {
      checkWorkspacePaths: adapter.checkWorkspacePaths.bind(adapter),
    });
    const receipt = await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-container-hints",
      capture: hinted(),
      body: "Container hints.",
    });
    expect(calls).toEqual([
      {
        command: "check_container_workspace_paths",
        args: {
          containerId: "source-hints-container",
          paths: HINTS.slice(0, 3).map((hint) => hint.path),
        },
      },
    ]);
    const capture = await harness.service.capture(ENV_A, receipt.captureId!);
    expect(verifiedPaths(capture.evidence?.sourceHints)).toEqual([
      [HINTS[0]!.path, false],
      [HINTS[1]!.path, true],
      [HINTS[2]!.path, false],
      [HINTS[3]!.path, false],
    ]);
  });

  test("a result capture is checked too", async () => {
    await wiredHarness();
    const created = await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-note",
      capture: fixtureCaptureInput("element"),
      body: "Note.",
    });
    const { annotation } = await harness.service.get(ENV_A, created.annotationId!);
    const preparation = await harness.service.prepare({
      environmentId: ENV_A,
      operation: "implement",
      destination: fixtureDestination,
      annotations: [
        {
          annotationId: annotation.id,
          expectedContentRevision: annotation.contentRevision,
          expectedCaptureId: annotation.currentCaptureId,
        },
      ],
      instruction: "",
    });
    await harness.service.send({
      environmentId: ENV_A,
      preparationId: preparation.preparationId,
      requestId: "req-1",
      bodyHash: preparation.bodyHash,
    });
    const captured = await harness.service.captureResult({
      environmentId: ENV_A,
      operationId: "op-after",
      requestId: "req-1",
      capture: hinted(),
    });
    const capture = await harness.service.capture(ENV_A, captured.captureId);
    expect(verifiedPaths(capture.evidence?.sourceHints)).toEqual(EXPECTED);
  });

  test("without a wired check every hint stays an unverified candidate", async () => {
    harness = await createHarness();
    const receipt = await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-unchecked",
      capture: hinted(),
      body: "Unchecked.",
    });
    const capture = await harness.service.capture(ENV_A, receipt.captureId!);
    expect(capture.evidence?.sourceHints).toEqual(HINTS);
  });

  test("a failing check leaves hints unverified and still saves the note", async () => {
    harness = await createHarness();
    (harness.dispatch as { checkWorkspacePaths?: unknown }).checkWorkspacePaths = async () => {
      throw new Error("docker exec failed");
    };
    const receipt = await harness.service.create({
      environmentId: ENV_A,
      operationId: "op-failing",
      capture: hinted(),
      body: "Failing check.",
    });
    const capture = await harness.service.capture(ENV_A, receipt.captureId!);
    expect(capture.evidence?.sourceHints).toEqual(HINTS);
  });

  test("a client-declared verification is still refused before any check", async () => {
    const { checked } = await wiredHarness();
    await expect(
      harness.service.create({
        environmentId: ENV_A,
        operationId: "op-forged",
        capture: hinted([{ ...HINTS[0]!, verified: true }]),
        body: "Forged.",
      }),
    ).rejects.toThrow("assigned by the receiver");
    expect(checked).toEqual([]);
  });
});
