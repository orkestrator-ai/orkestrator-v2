import type { GraphTemplateErrorCode } from "@orkestrator/protocol/graphs/library";

/**
 * A refused template-library request (item 109). The gateway forwards `code`
 * beside the message, so a client can tell a stale revision from a missing
 * template without parsing text. Messages never carry template or file
 * contents.
 */
export class GraphTemplateError extends Error {
  constructor(
    readonly code: GraphTemplateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GraphTemplateError";
  }
}
