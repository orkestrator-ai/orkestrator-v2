/**
 * The `pipelines` domain on a `lib/backend` factory's client (plan item 7007):
 * `pipelines(client).pause_build_pipeline({ pipelineId })`. See
 * `./domain-api.ts` for the adapter choice: a node that advertises the domain
 * gets version 1 (envelope, decoded results), any other node today's call by
 * name.
 */
import {
  pipelinesClient,
  type PipelinesApi,
} from "@orkestrator/protocol/contract/domains/pipelines";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { PipelinesApi } from "@orkestrator/protocol/contract/domains/pipelines";

export function pipelines(client: BackendClient): PipelinesApi {
  return domainApi(client, pipelinesClient);
}
