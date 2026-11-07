/**
 * The `native-sessions` domain client over a `lib/backend` factory's client
 * (plan item 7001, report §11.2 "Client adapters"). `createWorkflowsApi`,
 * `createFilesSessionsApi`, `createAgentHandoffsApi` and the other factories
 * whose commands are in this domain call `nativeSessions(client)`. The
 * adapter choice, the wire calls and the usage counting are the shared
 * helper's (`./domain-api.ts`, plan item 7010): a node that advertises
 * `native-sessions` gets version 1 (typed calls with the envelope, both
 * capability commands answered by the version without a round trip), any
 * other node or a client without negotiation version 0, today's calls
 * answered as sent.
 */
import {
  nativeSessionsClient,
  type NativeSessionsApi,
} from "@orkestrator/protocol/contract/domains/native-sessions";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { NativeSessionsApi } from "@orkestrator/protocol/contract/domains/native-sessions";

/**
 * The `native-sessions` API on `client`'s node, for the current connection
 * generation. Call it per use: a reconnect to another build picks again.
 */
export function nativeSessions(client: BackendClient): NativeSessionsApi {
  return domainApi(client, nativeSessionsClient);
}

/**
 * A decoded result as the web's own model type. The protocol schemas
 * describe the fields every reader routes on and keep the rest
 * (`openStruct`); the web's types are richer (transcript row generics,
 * literal unions) until plan item 7010 converges them.
 */
export function asWebModel<T>(result: Promise<unknown>): Promise<T> {
  return result as Promise<T>;
}
