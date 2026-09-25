import {
  DESIGN_RUNTIME_VERSION,
  type DesignValidationReport,
} from "@orkestrator/protocol/design-canvas";
import type { DesignFrameValidation } from "@orkestrator/protocol/design-operations";
import { DesignError, isDesignError } from "./design-errors.js";
import { unavailableValidation, validationFromReport } from "./design-execute.js";
import { cloneRecord, type DesignPrivateRecord } from "./design-records.js";
import type { DesignService } from "./design-service.js";

const inFlight = new WeakMap<
  DesignService,
  Map<string, Promise<DesignFrameValidation | undefined>>
>();
/** Content identities already attempted automatically in this process (bounded). */
const attempted = new WeakMap<DesignService, Set<string>>();
const MAX_ATTEMPTED = 2048;

function stale(validation: DesignFrameValidation) {
  return (
    validation.state === "unvalidated" ||
    validation.state === "renderer-unavailable" ||
    validation.runtimeVersion < DESIGN_RUNTIME_VERSION
  );
}

/**
 * Validates lazily by content identity: at most a few frames per snapshot, each
 * content identity once per process unless the user explicitly retries. Never
 * launches Chromium when no executable exists.
 */
export function scheduleStale(
  service: DesignService,
  environmentId: string,
  record: DesignPrivateRecord,
) {
  const health = service.renderer.status();
  if (health.state === "missing-executable" || health.state === "stopping") return;
  let started = 0;
  const seen = attempted.get(service) ?? new Set<string>();
  attempted.set(service, seen);
  for (const frame of record.document.frames) {
    const meta = record.frames[frame.id];
    if (!meta || !stale(meta.validation)) continue;
    const key = `${record.canvasId}:${frame.id}:${meta.contentId}`;
    if (seen.has(key)) continue;
    if (started >= 4) break;
    seen.add(key);
    if (seen.size > MAX_ATTEMPTED) seen.delete(seen.values().next().value!);
    started++;
    schedule(service, environmentId, record.canvasId, frame.id);
  }
}

export function schedule(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  frameId: string,
) {
  service.track(validate(service, environmentId, canvasId, frameId));
}

/** Runs (or joins) validation of the frame's current content and records the result. */
export function validate(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  frameId: string,
): Promise<DesignFrameValidation | undefined> {
  const jobs = inFlight.get(service) ?? new Map();
  inFlight.set(service, jobs);
  // Joined only by the same environment: each caller's ownership is checked in run().
  const key = `${environmentId}:${canvasId}:${frameId}`;
  const existing = jobs.get(key);
  if (existing) return existing;
  const job = run(service, environmentId, canvasId, frameId).finally(() => jobs.delete(key));
  jobs.set(key, job);
  return job;
}

async function run(
  service: DesignService,
  environmentId: string,
  canvasId: string,
  frameId: string,
): Promise<DesignFrameValidation | undefined> {
  const { record } = await service.loadFor(canvasId, environmentId);
  const frame = record.document.frames.find((candidate) => candidate.id === frameId);
  const meta = record.frames[frameId];
  if (!frame || !meta) throw new DesignError("not-found", "Frame not found");
  const contentId = meta.contentId;
  let result: Omit<DesignFrameValidation, "frameId" | "contentId">;
  try {
    const report = (await service.render(
      environmentId,
      canvasId,
      frame,
      { op: "validate", html: frame.html },
      "validation",
    )) as DesignValidationReport;
    result = validationFromReport(report);
  } catch (error) {
    if (isDesignError(error, "renderer-unavailable")) result = unavailableValidation();
    else if (isDesignError(error, "deadline"))
      result = {
        ...unavailableValidation(),
        reasons: [{ code: "runtime-timeout" }],
        message: "Validation timed out. Retry when the design renderer is less busy.",
      };
    else if (isDesignError(error, "capacity")) return undefined;
    else if (
      !/Frame exceeds 5000 elements|HTML exceeds 256 KiB/.test((error as Error)?.message ?? "")
    )
      // A crashed target or destroyed context says nothing about the content;
      // never persist it as a permanent "invalid" verdict.
      result = {
        ...unavailableValidation(),
        reasons: [{ code: "runtime-error" }],
        message: "The design renderer failed while validating. Retry validation.",
      };
    else
      result = {
        runtimeVersion: DESIGN_RUNTIME_VERSION,
        state: "invalid",
        reasons: [{ code: /5000/.test((error as Error).message) ? "dom-limit" : "html-limit" }],
        truncated: false,
        message: "This frame could not be rendered by the design runtime.",
        validatedAt: service.iso(),
      };
  }
  return service.lane(canvasId, async () => {
    const latest = await service.loadFor(canvasId, environmentId);
    const current = latest.record.frames[frameId];
    // A result for older content never overwrites the status of newer content.
    if (!current || current.contentId !== contentId) return undefined;
    const validation: DesignFrameValidation = { ...result, frameId, contentId };
    // Reading never migrates a legacy document; only a real edit does.
    if (latest.legacy) return validation;
    const previous = current.validation;
    if (
      previous.state === validation.state &&
      previous.runtimeVersion === validation.runtimeVersion &&
      JSON.stringify(previous.reasons) === JSON.stringify(validation.reasons)
    )
      return previous;
    const next = cloneRecord(latest.record);
    next.frames[frameId] = { ...current, validation };
    next.statusVersion++;
    await service.commit(next, latest.legacy, {
      revision: next.document.revision,
      frameId,
      kind: "status",
      statusVersion: next.statusVersion,
    });
    return validation;
  });
}
