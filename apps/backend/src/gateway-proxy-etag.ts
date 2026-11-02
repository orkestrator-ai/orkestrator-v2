import { createHash } from "node:crypto";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

import { headerValueToString, rewriteBrowserPreviewBody } from "./gateway-internals.js";

/**
 * Validators for proxied responses whose bytes the gateway changed.
 *
 * When the loopback proxy compresses a body, or the legacy browser preview
 * rewrites one, the upstream `ETag` no longer describes the bytes sent. Rather
 * than dropping it (which made every reload re-download, re-rewrite and
 * re-compress every module), the gateway sends a weak tag derived from it:
 *
 *     W/"<upstream opaque-tag>|ork:<w|s>:<content-coding>[:<rewrite key>]"
 *
 * `w`/`s` records whether the upstream tag was weak, so the original can be
 * rebuilt exactly (Vite compares `If-None-Match` as a plain string). The
 * rewrite key covers the route prefix, the target port and the rewriter
 * itself, so a tag minted for one preview route, or by an older rewriter,
 * never revalidates bytes rewritten differently. On `If-None-Match` the
 * gateway sends the rebuilt upstream tags; on the upstream's 304 it answers
 * with the tag the client holds.
 */

const ETAG = /^(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"$/;
const DERIVED = /^W\/"([\x21\x23-\x7e\x80-\xff]*)\|ork:([ws]):([a-z0-9-]+)(?::([0-9a-f]{16}))?"$/;
/** Longer upstream tags are left out rather than carried into a derived tag. */
const MAX_UPSTREAM_ETAG_LENGTH = 256;
/** `If-None-Match` lists longer than this are forwarded without mapping. */
const MAX_IF_NONE_MATCH_TAGS = 32;

let rewriterFingerprint: string | null = null;

/** Identifies the rewrite applied by one preview route. */
export function browserPreviewRewriteKey(proxyPrefix: string, target: URL): string {
  // The rewriter's own source, so a changed rewrite never revalidates old bytes.
  rewriterFingerprint ??= createHash("sha256")
    .update(rewriteBrowserPreviewBody.toString())
    .digest("hex");
  return createHash("sha256")
    .update(`${rewriterFingerprint}\n${proxyPrefix}\n${target.port || "80"}`)
    .digest("hex")
    .slice(0, 16);
}

/** The weak tag for transformed bytes, or null when the upstream sent no usable tag. */
export function derivedProxyEtag(
  upstream: string | string[] | number | undefined,
  contentCoding: string,
  rewriteKey: string | null,
): string | null {
  const value = headerValueToString(upstream);
  if (!value || value.length > MAX_UPSTREAM_ETAG_LENGTH) return null;
  const match = ETAG.exec(value);
  if (!match) return null;
  const weak = match[1] ? "w" : "s";
  return `W/"${match[2]}|ork:${weak}:${contentCoding}${rewriteKey ? `:${rewriteKey}` : ""}"`;
}

/** The upstream tag a derived tag was minted from, if it belongs to this route. */
function upstreamTagFor(tag: string, rewriteKey: string | null): string | null | undefined {
  const match = DERIVED.exec(tag);
  if (!match) return undefined; // Not ours: an upstream tag passed through unchanged.
  const key = match[4] ?? null;
  // Compression alone is valid on any route; a rewrite only on its own route.
  if (key !== null && key !== rewriteKey) return null;
  return match[2] === "w" ? `W/"${match[1]}"` : `"${match[1]}"`;
}

export interface MappedPreconditions {
  /** Upstream tag → the derived tag the client sent for it. */
  derived: Map<string, string>;
}

/**
 * Rewrite `If-None-Match` for the upstream: derived tags become the upstream
 * tags they came from, tags for another route or rewrite are dropped, and
 * everything else passes unchanged. Returns the mapping for the 304.
 */
export function mapIfNoneMatchForUpstream(
  headers: IncomingHttpHeaders,
  rewriteKey: string | null,
): MappedPreconditions {
  const derived = new Map<string, string>();
  const value = headerValueToString(headers["if-none-match"]);
  if (!value) return { derived };
  const tags = value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.length > MAX_IF_NONE_MATCH_TAGS) return { derived };
  const forwarded: string[] = [];
  for (const tag of tags) {
    const upstream = upstreamTagFor(tag, rewriteKey);
    if (upstream === undefined) forwarded.push(tag);
    else if (upstream !== null) {
      forwarded.push(upstream);
      if (!derived.has(upstream)) derived.set(upstream, tag);
    }
  }
  if (forwarded.length) headers["if-none-match"] = forwarded.join(", ");
  else delete headers["if-none-match"];
  return { derived };
}

/**
 * On the upstream's 304, give the client back the derived tag it holds, so
 * its cached (transformed) representation keeps validating.
 */
export function restoreDerivedEtag(
  responseHeaders: OutgoingHttpHeaders,
  preconditions: MappedPreconditions,
): void {
  if (!preconditions.derived.size) return;
  const upstream = headerValueToString(responseHeaders.etag);
  const derived = upstream ? preconditions.derived.get(upstream) : undefined;
  if (derived) responseHeaders.etag = derived;
}
