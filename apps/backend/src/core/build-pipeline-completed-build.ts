import { createHash } from "node:crypto";
import {
  BUILD_PIPELINE_AGENTS,
  type BuildPipeline,
  type BuildPipelineAgent,
} from "@orkestrator/protocol/build-pipeline";
import {
  applyKeyInformationPatch,
  isBuildPipelineKeyInformation,
  type KeyInformationPatch,
} from "@orkestrator/protocol/build-pipeline-key-information";

/** Backend-only admission data. Never accepted by the ordinary launch commands. */
export interface CompletedBuildAttempt {
  tabId: string;
  sessionId: string;
  agent: BuildPipelineAgent;
  model?: string;
  reasoningEffort?: string;
  startedAt: string;
  completedAt: string;
  /** The committed work adopted by round 1, also used by code rewind. */
  commit: string;
  messages: unknown[];
  notes: KeyInformationPatch;
}

/** Install the original work before the admission becomes visible to a supervisor. */
export function adoptCompletedBuild(pipeline: BuildPipeline, attempt: CompletedBuildAttempt): void {
  try {
    installCompletedBuild(pipeline, attempt);
  } catch {
    throw new Error("Invalid completed Build attempt");
  }
}

function installCompletedBuild(pipeline: BuildPipeline, attempt: CompletedBuildAttempt): void {
  if (
    !pipeline.environmentId ||
    !attempt.tabId?.trim() ||
    !attempt.sessionId?.trim() ||
    attempt.tabId.length > 256 ||
    attempt.sessionId.length > 256 ||
    !BUILD_PIPELINE_AGENTS.includes(attempt.agent) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(attempt.commit) ||
    !Number.isFinite(Date.parse(attempt.startedAt)) ||
    !Number.isFinite(Date.parse(attempt.completedAt)) ||
    Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt) ||
    !Array.isArray(attempt.messages) ||
    attempt.messages.length > 10_000 ||
    Buffer.byteLength(JSON.stringify(attempt.messages), "utf8") > 8 * 1024 * 1024
  ) {
    throw new Error("Invalid completed Build attempt");
  }
  // Clone the handoff and transcript: later edits in a caller cannot change
  // what was admitted, including while the initial durable write is pending.
  const original = structuredClone(attempt);
  if (!original.notes || typeof original.notes !== "object" || Array.isArray(original.notes)) {
    throw new Error("Invalid notes");
  }
  for (const field of ["summary", "statement", "context", "solution"] as const) {
    if (original.notes[field] !== undefined && typeof original.notes[field] !== "string")
      throw new Error("Invalid notes");
  }
  for (const field of ["workDone", "notDone", "tests", "decisions", "issues"] as const) {
    if (original.notes[field] !== undefined && !Array.isArray(original.notes[field]))
      throw new Error("Invalid notes");
  }
  if (Buffer.byteLength(JSON.stringify(original.notes), "utf8") > 256 * 1024)
    throw new Error("Invalid notes");
  const keyInformation = applyKeyInformationPatch(undefined, original.notes, {
    author: "build",
    round: 0,
    at: original.completedAt,
  });
  if (!isBuildPipelineKeyInformation(keyInformation)) throw new Error("Invalid notes");
  const digest = createHash("sha256")
    .update(
      JSON.stringify(original, (_key, value) => {
        if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
          throw new Error("Non-JSON attempt");
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
          if (Object.getPrototypeOf(value) !== Object.prototype)
            throw new Error("Non-JSON attempt");
          return Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]]),
          );
        }
        return value;
      }),
    )
    .digest("hex");
  pipeline.sessions = [
    {
      phase: "build",
      agent: original.agent,
      ...(original.model ? { model: original.model } : {}),
      ...(original.reasoningEffort ? { reasoningEffort: original.reasoningEffort } : {}),
      iteration: 0,
      sessionKey: `${pipeline.id}:build:0:${original.tabId}`,
      sdkSessionId: original.sessionId,
      adoptedFromTabId: original.tabId,
      adoptedAttemptDigest: digest,
      label: "Build Session",
      status: "idle",
      startedAt: original.startedAt,
      completedAt: original.completedAt,
      headAtStart: original.commit,
      messages: original.messages,
    },
  ];
  pipeline.currentSessionIndex = 0;
  pipeline.iteration = 0;
  // Keep environment/source configuration on the normal durable bootstrap
  // path. The supervisor recognises this settled Build at the setup handoff.
  pipeline.phase = "starting-environment";
  pipeline.keyInformation = keyInformation;
}
