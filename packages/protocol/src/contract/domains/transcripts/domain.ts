/**
 * The `transcripts` contract domain (docs/reports/unified-federation.md §11.2).
 * Version 1 until a change an older peer cannot handle silently.
 *
 * Two plan items fill it: 7004 owns the transcript artifact and media
 * commands (`./artifact-commands.ts`), 7001 the prompts, queues, handoffs and
 * sync. Both share this one definition and the one domain client
 * (`./client.ts`), because a domain has one version and one client.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const transcriptsDomain = defineDomain({ name: "transcripts", version: 1 });
