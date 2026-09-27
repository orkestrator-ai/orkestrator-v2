/**
 * Extra helpers for the storage, quota, archive, sync, rollout, and
 * migration-compatibility suites. Builds on `web-annotation-test-support.ts`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseWebAnnotationError,
  type WebAnnotationErrorDetail,
  type WebAnnotationRequestOperation,
} from "@orkestrator/protocol/web-annotations";
import { fixtureDestination } from "@orkestrator/protocol/web-annotations-fixtures";
import type { WebAnnotationService } from "./web-annotation-service.js";
import { ENV_A } from "./web-annotation-test-support.js";

export async function sendRequest(
  service: WebAnnotationService,
  annotationId: string,
  requestId: string,
  options: {
    environmentId?: string;
    operation?: WebAnnotationRequestOperation;
    instruction?: string;
  } = {},
) {
  const environmentId = options.environmentId ?? ENV_A;
  const { annotation } = await service.get(environmentId, annotationId);
  const preparation = await service.prepare({
    environmentId,
    operation: options.operation ?? "implement",
    destination: fixtureDestination,
    annotations: [
      {
        annotationId,
        expectedContentRevision: annotation.contentRevision,
        expectedCaptureId: annotation.currentCaptureId,
      },
    ],
    instruction: options.instruction ?? "",
  });
  return service.send({
    environmentId,
    preparationId: preparation.preparationId,
    requestId,
    bodyHash: preparation.bodyHash,
  });
}

/** The typed detail of a rejected promise (fails the test if it resolves). */
export async function rejectionDetail(
  promise: Promise<unknown>,
): Promise<{ detail: WebAnnotationErrorDetail | null; message: string }> {
  try {
    await promise;
  } catch (error) {
    return parseWebAnnotationError(error);
  }
  throw new Error("expected the operation to be rejected");
}

export function environmentDir(dataDir: string, environmentId = ENV_A): string {
  return join(dataDir, "web-annotations", environmentId);
}

export async function readJsonFile(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

/** Capture every console channel while `work` runs. */
export async function captureConsole(work: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((method) => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      lines.push(
        args
          .map((arg) =>
            typeof arg === "string"
              ? arg
              : arg instanceof Error
                ? `${arg.name}: ${arg.message}`
                : JSON.stringify(arg),
          )
          .join(" "),
      );
    };
  }
  try {
    await work();
  } finally {
    methods.forEach((method, index) => {
      console[method] = originals[index]!;
    });
  }
  return lines.join("\n");
}
