/**
 * Read an OpenCode JSON response with a size bound.
 *
 * OpenCode's MCP status may echo submitted server configuration, so a response
 * is never read whole on trust: past the bound the read stops and fails.
 */
export const MAX_OPENCODE_MCP_STATUS_BYTES = 64 * 1024;

export async function readBoundedOpenCodeResponse(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new Error("OpenCode returned an empty MCP status response");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OPENCODE_MCP_STATUS_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("OpenCode MCP status response is too large");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_OPENCODE_MCP_STATUS_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("OpenCode MCP status response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  ).toString("utf8");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("OpenCode returned an invalid MCP status response");
  }
}
