/**
 * Signatures on the requests that change what an agent may do.
 *
 * A bridge's bearer token proves only that a caller once received it. An agent
 * that can run a background process as the bridge's uid can kill its bridge,
 * listen on the same port and read the token from the backend's next request.
 * So the backend also holds an Ed25519 private key per bridge, the bridge gets
 * only the public key ({@link bridgeAuthorityKeyEnv}), and every mutating
 * request carries a signature over its method, path, a digest of its body, the
 * time it was made and a nonce. A captured token then still reads transcripts,
 * but it answers no approval, sends no prompt and widens no policy: the
 * signature it would need is over a request the backend never made.
 *
 * Replay is bounded twice. A signature is accepted only within
 * {@link BRIDGE_AUTHORITY_WINDOW_MS} of when it was made, and only once: the
 * verifier remembers each nonce for that long, within a count bound, and
 * refuses anything no newer than a nonce it had to forget.
 *
 * A bridge started without a key enforces nothing, which is how an older
 * backend and every test harness keep working.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import type { IncomingMessage } from "node:http";

export const BRIDGE_AUTHORITY_HEADER = "x-orkestrator-authority";
export const BRIDGE_AUTHORITY_REFUSED_CODE = "authority-signature-required";
/** How long after it was made a signature is accepted, either side of now. */
export const BRIDGE_AUTHORITY_WINDOW_MS = 5 * 60_000;
/** The nonces a verifier remembers; past it, older signatures are refused instead. */
export const BRIDGE_AUTHORITY_MAX_NONCES = 8_192;
/** The largest body a Fetch-based bridge buffers to check a signature. */
export const BRIDGE_AUTHORITY_MAX_BODY_BYTES = 16 * 1024 * 1024;

const SCHEME = "orkestrator-bridge-authority-v1";
const KEY_PATTERN = /^[A-Za-z0-9_-]{40,200}$/;
const HEADER_PATTERN = /^v1 t=(\d{1,16}) n=([A-Za-z0-9_-]{22}) s=([A-Za-z0-9_-]{86})$/;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Mutating routes that only narrow or only read, so a token alone may call
 * them: a close stops work and denies what is parked, the activity batch is a
 * read sent as a POST, and the log policy is diagnostics.
 */
const UNSIGNED_ROUTES: readonly RegExp[] = [
  /^\/session\/[^/]+\/close$/,
  /^\/sessions\/activity$/,
  /^\/debug\/log-policy$/,
];

/** The variable carrying the public key for the bridge whose token env is `tokenEnv`. */
export function bridgeAuthorityKeyEnv(tokenEnv: string): string {
  return `${tokenEnv}_AUTHORITY_KEY`;
}

export interface BridgeAuthorityKeyPair {
  /** PKCS #8 DER, base64url. Stays with the backend. */
  privateKey: string;
  /** SPKI DER, base64url. What the bridge is given. */
  publicKey: string;
}

export function mintBridgeAuthorityKeyPair(): BridgeAuthorityKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
  };
}

/** Whether `value` has the shape of an encoded key; says nothing about whether it is one. */
export function isBridgeAuthorityKey(value: unknown): value is string {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

export function bridgeAuthorityPrivateKey(encoded: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "pkcs8" });
}

function publicKeyFrom(encoded: string): KeyObject | null {
  if (!isBridgeAuthorityKey(encoded)) return null;
  try {
    const key = createPublicKey({
      key: Buffer.from(encoded, "base64url"),
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

/**
 * The path and query a request names, as WHATWG URL parsing leaves them. Both
 * sides normalise through it, so `fetch`'s own normalisation cannot make a
 * signature fail.
 */
export function bridgeAuthorityTarget(url: string): string {
  const parsed = new URL(url, "http://bridge.invalid");
  return `${parsed.pathname}${parsed.search}`;
}

/** Whether a request to `target` must be signed when the bridge holds a key. */
export function bridgeRequestNeedsAuthority(method: string, target: string): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return false;
  const pathname = bridgeAuthorityTarget(target).split("?", 1)[0]!;
  return !UNSIGNED_ROUTES.some((pattern) => pattern.test(pathname));
}

function bodyDigest(body: string | Uint8Array | null | undefined): string {
  return createHash("sha256")
    .update(body ?? "")
    .digest("hex");
}

function signedMessage(
  method: string,
  target: string,
  issuedAt: number,
  nonce: string,
  digest: string,
): Buffer {
  return Buffer.from(
    [SCHEME, method.toUpperCase(), target, String(issuedAt), nonce, digest].join("\n"),
  );
}

export interface BridgeRequestToSign {
  method: string;
  /** The full URL, or the path and query. */
  url: string;
  body?: string | Uint8Array | null;
}

/** The {@link BRIDGE_AUTHORITY_HEADER} value for one request. */
export function signBridgeRequest(
  privateKey: string | KeyObject,
  request: BridgeRequestToSign,
  options: { now?: number; nonce?: string } = {},
): string {
  const key = typeof privateKey === "string" ? bridgeAuthorityPrivateKey(privateKey) : privateKey;
  const issuedAt = Math.trunc(options.now ?? Date.now());
  const nonce = options.nonce ?? randomBytes(16).toString("base64url");
  const signature = sign(
    null,
    signedMessage(
      request.method,
      bridgeAuthorityTarget(request.url),
      issuedAt,
      nonce,
      bodyDigest(request.body),
    ),
    key,
  ).toString("base64url");
  return `v1 t=${issuedAt} n=${nonce} s=${signature}`;
}

export type BridgeAuthorityFailure = "missing" | "malformed" | "stale" | "replayed" | "invalid";

export type BridgeAuthorityCheck = { ok: true } | { ok: false; reason: BridgeAuthorityFailure };

export interface BridgeAuthorityRequest {
  method: string;
  /** The full URL, or the path and query. */
  url: string;
  header: string | null | undefined;
  body: Uint8Array;
}

export interface BridgeAuthority {
  /** False when the bridge was given no key: nothing is checked. */
  readonly enforced: boolean;
  /** Whether this request must carry a signature before the bridge acts on it. */
  requires(method: string, url: string): boolean;
  check(request: BridgeAuthorityRequest): BridgeAuthorityCheck;
}

const UNENFORCED: BridgeAuthority = {
  enforced: false,
  requires: () => false,
  check: () => ({ ok: true }),
};

/**
 * A verifier over `publicKey`. A key that does not parse is a key nobody
 * holds: every request that needs a signature is refused, as a malformed
 * verifier fails the credential closed.
 */
export function bridgeAuthorityFromPublicKey(
  publicKey: string | undefined,
  options: { now?: () => number; maxNonces?: number } = {},
): BridgeAuthority {
  if (publicKey === undefined) return UNENFORCED;
  const key = publicKeyFrom(publicKey);
  const now = options.now ?? Date.now;
  const maxNonces = options.maxNonces ?? BRIDGE_AUTHORITY_MAX_NONCES;
  // Insertion order is arrival order, which is close to issue order.
  const seen = new Map<string, number>();
  // Nothing issued at or before this may be accepted: a nonce from then was forgotten.
  let floor = -Infinity;
  const remember = (nonce: string, issuedAt: number, current: number) => {
    for (const [oldNonce, oldIssuedAt] of seen) {
      if (seen.size < maxNonces && oldIssuedAt >= current - BRIDGE_AUTHORITY_WINDOW_MS) break;
      seen.delete(oldNonce);
      floor = Math.max(floor, oldIssuedAt);
    }
    seen.set(nonce, issuedAt);
  };
  return {
    enforced: true,
    requires: bridgeRequestNeedsAuthority,
    check(request) {
      if (!request.header) return { ok: false, reason: "missing" };
      const match = HEADER_PATTERN.exec(request.header.trim());
      if (!match) return { ok: false, reason: "malformed" };
      const issuedAt = Number(match[1]);
      const nonce = match[2]!;
      const current = now();
      if (Math.abs(current - issuedAt) > BRIDGE_AUTHORITY_WINDOW_MS || issuedAt <= floor) {
        return { ok: false, reason: "stale" };
      }
      if (!key) return { ok: false, reason: "invalid" };
      const valid = verify(
        null,
        signedMessage(
          request.method,
          bridgeAuthorityTarget(request.url),
          issuedAt,
          nonce,
          bodyDigest(request.body),
        ),
        key,
        Buffer.from(match[3]!, "base64url"),
      );
      if (!valid) return { ok: false, reason: "invalid" };
      // Checked after the signature, so an unsigned guess cannot spend a nonce.
      if (seen.has(nonce)) return { ok: false, reason: "replayed" };
      remember(nonce, issuedAt, current);
      return { ok: true };
    },
  };
}

/**
 * Read this bridge's public key from the environment once and remove it, so
 * nothing the bridge spawns inherits it. Not a secret, but the agent has no use
 * for it and a child that re-read it would be a second bridge's worth of trust.
 */
export function loadBridgeAuthority(
  tokenEnv: string,
  options: { env?: NodeJS.ProcessEnv; now?: () => number } = {},
): BridgeAuthority {
  const env = options.env ?? process.env;
  const name = bridgeAuthorityKeyEnv(tokenEnv);
  const value = env[name]?.trim();
  delete env[name];
  return bridgeAuthorityFromPublicKey(value || undefined, { now: options.now });
}

export interface BridgeAuthorityRefusal {
  status: 403 | 413;
  body: { error: string; code?: string; reason?: BridgeAuthorityFailure };
}

function refusal(reason: BridgeAuthorityFailure): BridgeAuthorityRefusal {
  return {
    status: 403,
    body: {
      error: "This request changes an agent's authority and needs the backend's signature",
      code: BRIDGE_AUTHORITY_REFUSED_CODE,
      reason,
    },
  };
}

const TOO_LARGE: BridgeAuthorityRefusal = {
  status: 413,
  body: { error: "Request body is too large" },
};

const admittedBodies = new WeakMap<IncomingMessage, Buffer>();

/**
 * Check a `node:http` request before it is routed. A request that needs a
 * signature has its body read here, bounded by `maxBodyBytes`, and kept for
 * {@link takeAdmittedBody}: the body checked is the body the handler parses.
 * Answers the refusal to send, or null to go on.
 */
export async function admitNodeBridgeRequest(
  authority: BridgeAuthority,
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<BridgeAuthorityRefusal | null> {
  const method = request.method ?? "GET";
  const url = request.url ?? "/";
  if (!authority.requires(method, url)) return null;
  const header = request.headers[BRIDGE_AUTHORITY_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  // Refused before the body is read, so an unsigned request costs nothing.
  if (!value) return refusal("missing");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > maxBodyBytes) return TOO_LARGE;
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  const result = authority.check({ method, url, header: value, body });
  if (!result.ok) return refusal(result.reason);
  admittedBodies.set(request, body);
  return null;
}

/** The body {@link admitNodeBridgeRequest} read and checked, once. */
export function takeAdmittedBody(request: IncomingMessage): Buffer | undefined {
  const body = admittedBodies.get(request);
  admittedBodies.delete(request);
  return body;
}

async function readBounded(request: Request, maxBodyBytes: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBodyBytes) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBodyBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * {@link admitNodeBridgeRequest} for a Fetch `Request` (the Hono bridges). On
 * success `request` is a copy carrying the checked body, for the handler to
 * read in place of the consumed original.
 */
export async function admitFetchBridgeRequest(
  authority: BridgeAuthority,
  original: Request,
  maxBodyBytes = BRIDGE_AUTHORITY_MAX_BODY_BYTES,
): Promise<{ refusal: BridgeAuthorityRefusal } | { request?: Request }> {
  if (!authority.requires(original.method, original.url)) return {};
  const header = original.headers.get(BRIDGE_AUTHORITY_HEADER);
  if (!header) return { refusal: refusal("missing") };
  const body = await readBounded(original, maxBodyBytes);
  if (!body) return { refusal: TOO_LARGE };
  const result = authority.check({ method: original.method, url: original.url, header, body });
  if (!result.ok) return { refusal: refusal(result.reason) };
  const headers = new Headers(original.headers);
  headers.set("content-length", String(body.byteLength));
  headers.delete("transfer-encoding");
  return {
    request: new Request(original.url, {
      method: original.method,
      headers,
      body: body.byteLength > 0 ? new Uint8Array(body) : undefined,
      signal: original.signal,
    }),
  };
}
