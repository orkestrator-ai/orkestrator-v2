/**
 * Renderer view of the feature-planner contract.
 *
 * The prompts and state-block parsers moved to `@orkestrator/protocol` when the
 * planning workflow became backend-owned: the backend builds the prompt and
 * parses the reply, and a second copy here would silently disagree about what
 * the model was told to emit. This module re-exports them and supplies the
 * renderer's clock/id sources for the one helper that needs them.
 */
import type { FeaturePlan, FeatureStoryCard } from "@/lib/backend";
import { createUuid } from "@/lib/uuid";
import {
  createStoryCardsFromParsedState as createStoryCards,
  type ParsedFeaturePlannerState,
} from "@orkestrator/protocol/feature-planning";

export {
  FEATURE_PLANNER_SYSTEM_PROMPT,
  createFeaturePlannerInitialPrompt,
  createFeaturePlannerResumePrompt,
  createStoryRefinementPrompt,
  formatFeatureStoriesForBuild,
  parseFeaturePlannerState,
  parseStoryRefinement,
  selectFeaturePlannerPrompt,
  stripFeaturePlannerStateBlocks,
  stripStoryRefinementStateBlocks,
} from "@orkestrator/protocol/feature-planning";

export type {
  ParsedFeaturePlannerState,
  ParsedStoryRefinement,
} from "@orkestrator/protocol/feature-planning";

/**
 * Local-preview variant used when the renderer renders stories optimistically.
 * The authoritative cards are built backend-side with backend-issued ids.
 */
export function createStoryCardsFromParsedState(
  parsed: ParsedFeaturePlannerState,
  existingStories: FeatureStoryCard[] = [],
): FeatureStoryCard[] {
  return createStoryCards(parsed, existingStories, {
    now: new Date().toISOString(),
    newStoryId: createUuid,
  }) as FeatureStoryCard[];
}

export type { FeaturePlan, FeatureStoryCard };
