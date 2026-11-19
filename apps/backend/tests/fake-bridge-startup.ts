import { LOCAL_BRIDGE_READY_PREFIX } from "@orkestrator/protocol/node/local-bridge-readiness";

/** Source embedded in disposable local-bridge entrypoints. */
export const FAKE_BRIDGE_STARTUP = `
function announceBridgeReady() {
  process.stdout.write(${JSON.stringify(LOCAL_BRIDGE_READY_PREFIX)} + process.env.PORT + "\\n");
}

function bridgeAuthStatus(authorization) {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  const verifier = process.env.CLAUDE_BRIDGE_TOKEN_SHA256 ??
    process.env.CODEX_BRIDGE_TOKEN_SHA256 ??
    process.env.CURSOR_BRIDGE_TOKEN_SHA256 ??
    process.env.PI_BRIDGE_TOKEN_SHA256 ??
    process.env.ACP_BRIDGE_TOKEN_SHA256;
  return token && require("node:crypto").createHash("sha256").update(token).digest("hex") === verifier
    ? 200 : 401;
}
`;

/**
 * Prints a bridge's bind announcement on an in-process fake child's stdout, as
 * a real bridge does once its server listens. Startup is not healthy without it.
 */
export function announceFakeBridgeReady(
  stdout: { emit(event: "data", chunk: Buffer): boolean },
  port: number | string,
): void {
  stdout.emit("data", Buffer.from(`${LOCAL_BRIDGE_READY_PREFIX}${port}\n`));
}
