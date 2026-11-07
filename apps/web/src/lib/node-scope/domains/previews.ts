/**
 * The `previews` domain on a `lib/backend` factory's client (plan item 7004):
 * `previews(client)().register({ service, operationId })`. The adapter is
 * picked per call from the node's negotiated `domains` (`backendDomainApi`,
 * `lib/backend/domain-client.ts`): version 1 sends the envelope and decodes
 * results, version 0 is today's call. `lib/backend/previews.ts` calls it.
 */
import { previewsClient, type PreviewsApi } from "@orkestrator/protocol/contract/domains/previews";
import type { BackendClient } from "@/lib/backend/client";
import { backendDomainApi } from "@/lib/backend/domain-client";

export type { PreviewsApi } from "@orkestrator/protocol/contract/domains/previews";

export function previews(client: BackendClient): () => PreviewsApi {
  return backendDomainApi(client, previewsClient);
}
