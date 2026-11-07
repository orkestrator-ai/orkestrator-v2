/**
 * The `transcripts` domain client (§11.2 "Client adapters"). One client per
 * domain: each plan item that fills the domain adds its part of the API to
 * both adapters. Plan item 7004's part is the transcript artifact and media
 * calls (`./artifact-client.ts`); plan item 7001 adds the prompt, queue,
 * handoff and sync calls.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `transcripts` domain.
 *
 * Browser-safe.
 */
import { domainClient } from "../../client.js";
import {
  transcriptArtifactsApiLegacy,
  transcriptArtifactsApiV1,
  type TranscriptArtifactsApi,
} from "./artifact-client.js";
import { transcriptsDomain } from "./domain.js";

export type TranscriptsApi = TranscriptArtifactsApi;

export const transcriptsClient = domainClient<typeof transcriptsDomain, TranscriptsApi>(
  transcriptsDomain,
  {
    1: (call) => ({ ...transcriptArtifactsApiV1(call) }),
    0: (call, context) => ({ ...transcriptArtifactsApiLegacy(call, context) }),
  },
);
