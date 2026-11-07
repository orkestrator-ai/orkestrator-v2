/**
 * The `files` domain on a `lib/backend` factory's client (plan item 7002):
 * `files(client).read_local_file({ worktreePath, filePath })`. See
 * `./domain-api.ts` for the adapter choice.
 */
import { filesClient, type FilesApi } from "@orkestrator/protocol/contract/domains/files";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { FilesApi } from "@orkestrator/protocol/contract/domains/files";

export function files(client: BackendClient): FilesApi {
  return domainApi(client, filesClient);
}
