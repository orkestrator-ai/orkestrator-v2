/**
 * The `transcripts` domain on a `lib/backend` factory's client (plan item
 * 7004 for the artifact and media part): `transcripts(client)().pinMedia(…)`.
 * The adapter is picked per call from the node's negotiated `domains`
 * (`domainApi`, `./domain-api.ts`): version 1 sends the
 * envelope and decodes results, version 0 is today's call.
 * `lib/backend/transcript-artifacts.ts` calls it.
 */
import {
  transcriptsClient,
  type TranscriptsApi,
} from "@orkestrator/protocol/contract/domains/transcripts";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { TranscriptsApi } from "@orkestrator/protocol/contract/domains/transcripts";

export function transcripts(client: BackendClient): () => TranscriptsApi {
  return () => domainApi(client, transcriptsClient);
}
