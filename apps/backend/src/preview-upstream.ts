import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect, rootCertificates } from "node:tls";

import { previewFailure, type PreviewErrorCategory } from "@orkestrator/protocol/preview-services";

import type { ResolvedPreviewTarget } from "./core/preview-service-registry.js";

export interface PreviewUpstreamOptions {
  connectTimeoutMs: number;
  /** Extra CA bundle (PEM) for HTTPS upstream verification. */
  ca?: () => string | undefined;
  /** Relay-backed targets open a channel through the container relay. */
  relayConnect?: (target: ResolvedPreviewTarget, signal: AbortSignal) => Promise<Duplex>;
}

/**
 * Node's `ca` option replaces the default roots. An operator CA must extend
 * them, so a development CA never removes trust in public certificates.
 */
export function upstreamTrust(extra: string | undefined): string[] | undefined {
  return extra ? [...rootCertificates, extra] : undefined;
}

function category(error: unknown, tls: boolean): PreviewErrorCategory {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ECONNREFUSED") return "connection-refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns-failed";
  if (code === "ETIMEDOUT") return "connect-timeout";
  // Anything else on a TLS socket failed the handshake or verification
  // (unknown issuer, wrong name, expiry); runtimes name these differently.
  if (tls) return "tls-failed";
  return "connection-refused";
}

/**
 * Open a connection to an authorized, already-resolved target. Plain targets
 * use TCP; HTTPS targets verify the certificate against the configured server
 * name (verification is never disabled); relay targets use the relay channel.
 * The caller supplies the target — this function never accepts a destination
 * from a request.
 */
export function connectPreviewUpstream(
  target: ResolvedPreviewTarget,
  options: PreviewUpstreamOptions,
  signal: AbortSignal,
): Promise<Duplex> {
  if (target.relay) {
    if (!options.relayConnect)
      return Promise.reject(
        previewFailure("unsupported", { message: "The container relay is unavailable." }),
      );
    return options.relayConnect(target, signal);
  }
  return new Promise((resolve, reject) => {
    const family = target.addressFamily === "ipv6" ? 6 : 4;
    const socket = target.tls
      ? tlsConnect({
          host: target.host,
          port: target.port,
          servername: target.tls.servername,
          rejectUnauthorized: true,
          ca: upstreamTrust(options.ca?.()),
          ALPNProtocols: ["http/1.1"],
        })
      : netConnect({ host: target.host, port: target.port, family });
    const ready = target.tls ? "secureConnect" : "connect";
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.off(ready, onReady);
      socket.off("error", onError);
    };
    const onReady = () => {
      cleanup();
      socket.on("error", () => undefined);
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(previewFailure(category(error, Boolean(target.tls))));
    };
    const onAbort = () => {
      cleanup();
      socket.destroy();
      reject(previewFailure("access-expired", { message: "The preview request was cancelled." }));
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(previewFailure("connect-timeout"));
    }, options.connectTimeoutMs);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once(ready, onReady);
    socket.once("error", onError);
  });
}
