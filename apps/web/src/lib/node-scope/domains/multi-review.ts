/**
 * The `multi-review` domain on a `lib/backend` factory's client (plan item
 * 7007): `multiReview(client).cancel_multi_review({ workflowId })`. See
 * `./domain-api.ts` for the adapter choice.
 */
import {
  multiReviewClient,
  type MultiReviewApi,
} from "@orkestrator/protocol/contract/domains/multi-review";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { MultiReviewApi } from "@orkestrator/protocol/contract/domains/multi-review";

export function multiReview(client: BackendClient): MultiReviewApi {
  return domainApi(client, multiReviewClient);
}
