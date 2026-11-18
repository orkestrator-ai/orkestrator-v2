/** Content negotiation for the bridge's JSON answers. */
import type { IncomingMessage } from "node:http";

/**
 * Whether the client accepts a gzip answer. Read once per request: a hop that
 * asks for `identity` on purpose must get an uncompressed body.
 */
export function acceptsGzip(request: IncomingMessage): boolean {
  const header = request.headers["accept-encoding"];
  const value = Array.isArray(header) ? header.join(",") : header;
  if (typeof value !== "string") return false;

  let wildcard: number | undefined;
  for (const item of value.split(",")) {
    const [rawCoding, ...rawParameters] = item.split(";");
    const coding = rawCoding?.trim().toLowerCase();
    if (coding !== "gzip" && coding !== "*") continue;

    let quality = 1;
    for (const rawParameter of rawParameters) {
      const [rawName, rawValue] = rawParameter.split("=", 2);
      if (rawName?.trim().toLowerCase() !== "q") continue;
      const parsed = Number(rawValue?.trim());
      quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    }
    // A named coding takes precedence over a wildcard, including an explicit
    // refusal (`gzip;q=0, *;q=1`).
    if (coding === "gzip") return quality > 0;
    wildcard = quality;
  }
  return (wildcard ?? 0) > 0;
}
