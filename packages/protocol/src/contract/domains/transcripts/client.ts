/**
 * The `transcripts` domain client (§11.2 "Client adapters"). One client per
 * domain: each plan item that fills the domain adds its part of the API. Plan item 7004's part is the transcript artifact and media
 * calls (`./artifact-client.ts`); plan item 7001 adds the prompt, queue,
 * handoff and sync calls.
 *
 * Only the current version has an adapter: the older ones went with the
 * one-time support floor v2.39.1-beta (to-do 8304 (retired), 2026-11-26). A domains map
 * that omits this domain yields `unsupported-version`. Without a domains
 * map, calls use the lowest adapter unnegotiated. Later bumps keep an
 * adapter for every version a release in the 60-day window speaks.
 *
 * Browser-safe.
 */
import { domainClient } from "../../client.js";
import { transcriptArtifactsApiV1, type TranscriptArtifactsApi } from "./artifact-client.js";
import { transcriptsDomain } from "./domain.js";

export type TranscriptsApi = TranscriptArtifactsApi;

export const transcriptsClient = domainClient<typeof transcriptsDomain, TranscriptsApi>(
  transcriptsDomain,
  {
    1: (call) => ({ ...transcriptArtifactsApiV1(call) }),
  },
);
