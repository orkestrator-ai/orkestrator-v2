/**
 * What each Build Pipeline stage is told when its session opens.
 *
 * The stage contracts live in `build-pipeline-prompts.ts`; this reads the
 * inputs they need (project notes, the review instruction, the target branch,
 * the review handoff, the Address report, the pull request a restart updates)
 * and appends the user's per-step instructions after the contract.
 */
import {
  type BuildPipeline,
  type BuildPipelineAgent,
  type PipelineSessionPhase,
  isSupersededPipelineSession,
  stepKeyForSessionPhase,
  usesReviewFanout,
} from "@orkestrator/protocol/build-pipeline";
import {
  pipelineStepInstructions,
  withBuildStepInstructions,
} from "@orkestrator/protocol/build-pipeline-stage-instructions";
import type { ReviewPackageReference } from "@orkestrator/protocol/review-workflow";
import { STRUCTURED_REVIEW_REPORT_JSON_SCHEMA } from "@orkestrator/protocol/structured-review";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import { sessionAgent, VERIFICATION_SCHEMA } from "./build-pipeline-service-helpers.js";
import { forcePushUpstream } from "./build-pipeline-code-rewind.js";
import {
  addressPrompt,
  addressValidationInstruction,
  buildPipelineReviewPackageContext,
  buildPrompt,
  fixPrompt,
  prPrompt,
  resolveConflictsPrompt,
  verificationPrompt,
  type ReviewWorktreeSnapshot,
} from "./build-pipeline-prompts.js";
import {
  BUILD_PIPELINE_HANDOFF_TAIL_MESSAGES,
  buildReviewHandoffPrompt,
  prependReviewHandoff,
} from "./build-pipeline-handoff.js";
import {
  REVIEW_FIX_RESULT_JSON_SCHEMA,
  REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
  createDiscoveryPrompt,
} from "./review-prompts.js";
import type { BuildPipelineContext } from "./build-pipeline-context.js";
import { verificationAddressReport } from "./build-pipeline-address-report.js";

/** A stage's opening prompt, its result schema and the images it is sent with. */
export interface StagePrompt {
  prompt: string;
  schema?: JsonSchema;
  images: BuildPipeline["taskSnapshot"]["images"];
}

export class BuildPipelineStagePrompts {
  constructor(
    private readonly ctx: BuildPipelineContext,
    /** Throws when the package or one of its artifacts changed since it was sealed. */
    private readonly verifyReviewPackage: (
      environmentId: string,
      reviewPackage: ReviewPackageReference,
    ) => Promise<unknown>,
  ) {}

  /**
   * The prompt that opens a stage's session: the stage's own contract, then the
   * user's instructions for the step it runs under (Fix runs under Build).
   *
   * The baseline is passed in rather than probed here: the same observation has
   * to reach both the prompt the verifier reads and the session field the guard
   * later compares against, and two probes could disagree.
   */
  async promptFor(
    pipeline: BuildPipeline,
    phase: PipelineSessionPhase,
    agent: BuildPipelineAgent,
    worktree?: ReviewWorktreeSnapshot,
  ): Promise<StagePrompt> {
    const stage = await this.contractFor(pipeline, phase, agent, worktree);
    return {
      ...stage,
      prompt: withBuildStepInstructions(
        stage.prompt,
        pipelineStepInstructions(pipeline, stepKeyForSessionPhase(phase)),
      ),
    };
  }

  private async contractFor(
    pipeline: BuildPipeline,
    phase: PipelineSessionPhase,
    agent: BuildPipelineAgent,
    worktree?: ReviewWorktreeSnapshot,
  ): Promise<StagePrompt> {
    const notes = (await this.ctx.storage.kanban.getProjectNotes(pipeline.projectId)).content;
    const config = await this.ctx.storage.loadConfig();
    const repository = await this.ctx.storage.getRepositoryConfig(pipeline.projectId);
    const target = repository.prBaseBranch || "main";
    if (phase === "build") {
      return {
        prompt: buildPrompt(pipeline, notes, target),
        schema:
          usesReviewFanout(pipeline) || pipeline.reviewPreparation
            ? undefined
            : REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
        images: pipeline.taskSnapshot.images,
      };
    }
    // Address can mutate workspace evidence after review. Check the package
    // and its artifacts again at every consuming stage, especially verification.
    if (
      (phase === "review" || phase === "address" || phase === "verify") &&
      pipeline.reviewPackage &&
      "kind" in pipeline.reviewPackage
    ) {
      await this.verifyReviewPackage(pipeline.environmentId, pipeline.reviewPackage);
    }
    if (phase === "review") {
      if (!pipeline.reviewPackage) {
        throw new Error("Cannot review without an immutable review package");
      }
      return {
        prompt: createDiscoveryPrompt({
          reviewPackage: pipeline.reviewPackage,
          reviewInstruction: config.global.reviewInstruction,
          context: buildPipelineReviewPackageContext(pipeline, notes).context,
        }),
        schema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
        images: pipeline.taskSnapshot.images,
      };
    }
    if (phase === "address") {
      if (!pipeline.structuredReview) {
        throw new Error("Cannot address issues without the structured review");
      }
      const sourceSession = [...pipeline.sessions]
        .reverse()
        .find((session) => session.phase === "review" && !isSupersededPipelineSession(session));
      if (!sourceSession) {
        throw new Error("Cannot address issues without the review session");
      }
      const handoff = buildReviewHandoffPrompt({
        environmentId: pipeline.environmentId,
        sourceAgent: sessionAgent(pipeline, sourceSession),
        destinationAgent: agent,
        sourceSession,
        sourceTranscript: await this.ctx.transcriptCheckpoints.window(
          pipeline.id,
          sourceSession,
          BUILD_PIPELINE_HANDOFF_TAIL_MESSAGES,
        ),
      });
      return {
        prompt: prependReviewHandoff(
          handoff,
          addressPrompt(
            pipeline.structuredReview,
            addressValidationInstruction(pipeline.reviewPackage, target),
          ),
        ),
        schema: REVIEW_FIX_RESULT_JSON_SCHEMA,
        images: [],
      };
    }
    if (phase === "verify") {
      return {
        prompt: verificationPrompt(
          pipeline,
          notes,
          target,
          worktree,
          await verificationAddressReport(this.ctx.transcriptCheckpoints, pipeline),
        ),
        schema: VERIFICATION_SCHEMA,
        images: pipeline.taskSnapshot.images,
      };
    }
    if (phase === "fix") {
      return {
        prompt: fixPrompt(
          pipeline,
          notes,
          pipeline.verificationFeedback ?? "The verification did not pass.",
          target,
        ),
        schema:
          usesReviewFanout(pipeline) || pipeline.reviewPreparation
            ? undefined
            : REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
        images: pipeline.taskSnapshot.images,
      };
    }
    if (phase === "pr") {
      // A restart that ships again must update the pull request the earlier
      // Ship opened, never open a second one. An environment PR without an
      // earlier Ship belongs to a reused environment, not to this pipeline.
      const shippedBefore = pipeline.sessions.some((session) => session.phase === "pr");
      const existingPullRequestUrl = shippedBefore
        ? ((await this.ctx.storage.getEnvironment(pipeline.environmentId))?.prUrl ?? undefined)
        : undefined;
      const forcePush = forcePushUpstream(pipeline);
      return {
        prompt: prPrompt(target, {
          ...(existingPullRequestUrl ? { existingPullRequestUrl } : {}),
          ...(forcePush ? { forcePushUpstream: forcePush } : {}),
        }),
        images: [],
      };
    }
    return { prompt: resolveConflictsPrompt(target), images: [] };
  }
}
