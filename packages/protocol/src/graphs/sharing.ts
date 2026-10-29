/**
 * Template sharing (item 405, plan Phase 4, D2, report §6.9): the share
 * bundle format `orkestrator.graph-bundle` version 1, its strict guard and
 * digest checks, the signing payload, the capability summary a reviewer sees
 * before trusting a template, and the wire shapes of the sharing and review
 * commands.
 *
 * Browser-safe: digests use the package's synchronous SHA-256. Signing and
 * signature verification (Ed25519) happen in the backend only, which holds the
 * installation's private key.
 */
import { canonicalJson, parseStrictJson } from "../canonical-json.js";
import type { ChangeDiffHunk } from "../change-resources.js";
import { FieldErrorCollector, isPlainRecord, type FieldError } from "../field-validation.js";
import type { GraphCompileDiagnostic } from "./compile-diagnostics.js";
import { GRAPH_TEMPLATE_BOUNDS, graphUtf8Bytes } from "./grammar.js";
import {
  graphCanonicalJsonText,
  graphTemplateExportText,
  type GraphProjectTemplateSource,
  type GraphTemplateCompileSummary,
  type GraphTemplateDetail,
  type GraphTemplateRef,
  type GraphTemplateTrustState,
} from "./library.js";
import {
  graphTemplateDigest,
  type CompiledGraphPlan,
  type GraphSideEffectReason,
  type GraphTaintSourceReason,
} from "./plan.js";
import { sha256Bytes, sha256Hex } from "./sha256.js";
import { GRAPH_SYSTEM_ACTION_SPECS } from "./system-actions.js";
import {
  parseGraphTemplate,
  validateGraphTemplate,
  type GraphCapabilityProfileId,
  type GraphSystemAction,
  type GraphTemplateV1,
} from "./template.js";

// ---------------------------------------------------------------- format

export const GRAPH_BUNDLE_FORMAT = "orkestrator.graph-bundle";
export const GRAPH_BUNDLE_FORMAT_VERSION = 1;
/** File-name suffix of a share bundle. */
export const GRAPH_BUNDLE_SUFFIX = ".graph-bundle.json";
export const GRAPH_BUNDLE_SIGNATURE_ALGORITHM = "ed25519";
/** Prefix of the bytes a bundle signature signs. */
export const GRAPH_BUNDLE_SIGNING_DOMAIN = "orkestrator.graph-bundle/1\n";

export const GRAPH_SHARING_BOUNDS = Object.freeze({
  /** Bundle text, UTF-8 bytes (the template inside keeps its own 1 MiB guard). */
  maxBundleBytes: 2 * 1024 * 1024,
  /** Characters in a bundle's `author`. */
  maxAuthorChars: 120,
  /** Trusted signing keys per installation. */
  maxTrustedKeys: 64,
  /** Characters in a trusted key's label. */
  maxKeyLabelChars: 80,
  /** An approved template's canonical text is kept for diffs up to this many bytes. */
  maxApprovedTextBytes: 256 * 1024,
  /** Approved texts kept per project; past it the oldest approvals lose their text. */
  maxApprovedTextBytesPerProject: 4 * 1024 * 1024,
  /** Rendered diff lines (context included) in a review item. */
  maxDiffOutputLines: 400,
  /** Node ids listed per capability-summary line; the rest are counted. */
  maxListedNodes: 32,
  /** Taint warnings carried in a capability summary. */
  maxTaintWarnings: 20,
});

/** A detached Ed25519 signature over {@link graphBundleSigningPayload}. */
export interface GraphTemplateBundleSignature {
  algorithm: typeof GRAPH_BUNDLE_SIGNATURE_ALGORITHM;
  /** Raw 32-byte public key, base64url without padding. */
  publicKey: string;
  /** {@link graphSharingKeyId} of `publicKey`. */
  keyId: string;
  /** Raw 64-byte signature, base64url without padding. */
  value: string;
}

export interface GraphTemplateBundleV1 {
  format: typeof GRAPH_BUNDLE_FORMAT;
  formatVersion: typeof GRAPH_BUNDLE_FORMAT_VERSION;
  /** Self-contained: custom types travel in `template.types`. */
  template: GraphTemplateV1;
  /** {@link graphTemplateDigest} of `template` (layout left out): the identity users confirm. */
  digest: string;
  /** {@link graphTemplateContentDigest}: every byte of the template, layout included. */
  contentDigest: string;
  /** RFC 3339 UTC. */
  exportedAt: string;
  /** Optional display name; bounded, one line. */
  author?: string;
  signature?: GraphTemplateBundleSignature;
}

const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{32}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
// oxlint-disable-next-line no-control-regex -- the author must be one printable line
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** SHA-256 of the template's canonical export text: covers layout too. */
export function graphTemplateContentDigest(template: GraphTemplateV1): string {
  return sha256Hex(graphTemplateExportText(template));
}

/** Whether `author` is an acceptable bundle author (bounded, one printable line). */
export function graphBundleAuthorIssue(author: unknown): string | null {
  if (typeof author !== "string") return "author must be a string";
  if (!author.trim()) return "author must not be blank";
  if (Array.from(author).length > GRAPH_SHARING_BOUNDS.maxAuthorChars) {
    return `author is at most ${GRAPH_SHARING_BOUNDS.maxAuthorChars} characters`;
  }
  if (CONTROL.test(author)) return "author must be one line without control characters";
  return null;
}

// ---------------------------------------------------------------- base64url and keys

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Base64url without padding. */
export function encodeGraphBase64Url(bytes: Uint8Array): string {
  let out = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const n = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    out +=
      B64URL_ALPHABET[(n >> 18) & 63]! +
      B64URL_ALPHABET[(n >> 12) & 63]! +
      B64URL_ALPHABET[(n >> 6) & 63]! +
      B64URL_ALPHABET[n & 63]!;
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const n = bytes[index]! << 16;
    out += B64URL_ALPHABET[(n >> 18) & 63]! + B64URL_ALPHABET[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
    out +=
      B64URL_ALPHABET[(n >> 18) & 63]! +
      B64URL_ALPHABET[(n >> 12) & 63]! +
      B64URL_ALPHABET[(n >> 6) & 63]!;
  }
  return out;
}

/** Base64url (no padding) to bytes, or null when it is not canonical base64url. */
export function decodeGraphBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of text) {
    buffer = (buffer << 6) | B64URL_ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero, so each byte string has one encoding.
  if ((buffer & ((1 << bits) - 1)) !== 0) return null;
  return bytes;
}

/** A raw Ed25519 public key (32 bytes, base64url), or null. */
export function graphSharingPublicKeyBytes(publicKey: unknown): Uint8Array | null {
  if (typeof publicKey !== "string" || publicKey.length !== 43) return null;
  const bytes = decodeGraphBase64Url(publicKey);
  return bytes && bytes.length === 32 ? bytes : null;
}

/** A key's id: the first 16 bytes of SHA-256 of the raw public key, as hex. */
export function graphSharingKeyId(publicKey: string): string {
  const bytes = graphSharingPublicKeyBytes(publicKey);
  if (!bytes) throw new Error("Not an Ed25519 public key");
  let hex = "";
  for (const byte of sha256Bytes(bytes).subarray(0, 16)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** `ab12 cd34 …`: a key id grouped for reading aloud. */
export function graphSharingFingerprint(keyId: string): string {
  return keyId.replace(/(.{4})(?=.)/g, "$1 ");
}

// ---------------------------------------------------------------- signing payload and text

/**
 * The exact bytes (as a string) a bundle's signature signs. Both digests are
 * inside, so a valid signature binds every byte of the template and the
 * bundle's metadata.
 */
export function graphBundleSigningPayload(
  bundle: Pick<
    GraphTemplateBundleV1,
    "digest" | "contentDigest" | "exportedAt" | "author" | "template"
  >,
  keyId: string,
): string {
  return `${GRAPH_BUNDLE_SIGNING_DOMAIN}${canonicalJson({
    ...(bundle.author !== undefined ? { author: bundle.author } : {}),
    contentDigest: bundle.contentDigest,
    digest: bundle.digest,
    exportedAt: bundle.exportedAt,
    keyId,
    templateId: bundle.template.id,
  })}`;
}

/** An unsigned bundle for `template`, its digests computed. */
export function createGraphTemplateBundle(
  template: GraphTemplateV1,
  input: { exportedAt: string; author?: string },
): GraphTemplateBundleV1 {
  return {
    format: GRAPH_BUNDLE_FORMAT,
    formatVersion: GRAPH_BUNDLE_FORMAT_VERSION,
    template,
    digest: graphTemplateDigest(template),
    contentDigest: graphTemplateContentDigest(template),
    exportedAt: input.exportedAt,
    ...(input.author !== undefined ? { author: input.author } : {}),
  };
}

/** Canonical bundle text (sorted keys, two-space indent, trailing newline). */
export function graphTemplateBundleText(bundle: GraphTemplateBundleV1): string {
  canonicalJson(bundle, GRAPH_TEMPLATE_BOUNDS.maxTemplateDepth + 4);
  return graphCanonicalJsonText(bundle);
}

/** `<id>.graph-bundle.json`. */
export function graphTemplateBundleFileName(template: Pick<GraphTemplateV1, "id">): string {
  return `${template.id}${GRAPH_BUNDLE_SUFFIX}`;
}

// ---------------------------------------------------------------- guard

/** Why share-import text was refused. */
export const GRAPH_SHARE_REFUSAL_CODES = [
  "invalid-bundle",
  "invalid-template",
  "digest-mismatch",
  "content-digest-mismatch",
  "signature-invalid",
] as const;
export type GraphShareRefusalCode = (typeof GRAPH_SHARE_REFUSAL_CODES)[number];

export type GraphShareTextParse =
  | { ok: true; kind: "bundle"; bundle: GraphTemplateBundleV1 }
  | { ok: true; kind: "template"; template: GraphTemplateV1 }
  | {
      ok: false;
      refused: GraphShareRefusalCode;
      errors: FieldError[];
      omittedErrors: number;
    };

function refusal(
  refused: GraphShareRefusalCode,
  errors: FieldError[],
  omittedErrors = 0,
): Extract<GraphShareTextParse, { ok: false }> {
  return { ok: false, refused, errors, omittedErrors };
}

/**
 * Share-import text: a bundle (checked strictly, both digests verified) or a
 * plain template (`format: "orkestrator.graph"`). Duplicate keys and unknown
 * fields are refused. The signature's cryptographic check is the backend's;
 * this checks its shape.
 */
export function parseGraphShareText(text: string): GraphShareTextParse {
  if (graphUtf8Bytes(text) > GRAPH_SHARING_BOUNDS.maxBundleBytes) {
    return refusal("invalid-bundle", [
      {
        path: "$",
        code: "too_large",
        message: `A bundle is at most ${GRAPH_SHARING_BOUNDS.maxBundleBytes} bytes`,
      },
    ]);
  }
  const parsed = parseStrictJson(text, GRAPH_TEMPLATE_BOUNDS.maxTemplateDepth + 4);
  if (!parsed.ok) {
    return refusal("invalid-bundle", [
      { path: parsed.path, code: "invalid_json", message: parsed.message.slice(0, 300) },
    ]);
  }
  const value = parsed.value;
  if (isPlainRecord(value) && value.format !== GRAPH_BUNDLE_FORMAT) {
    // A plain template: exactly 109's import rules (its own byte limit included).
    const guard = parseGraphTemplate(text);
    if (!guard.ok) return refusal("invalid-template", guard.errors, guard.omittedErrors);
    return { ok: true, kind: "template", template: guard.value };
  }
  return validateGraphTemplateBundle(value);
}

const BUNDLE_KEYS = [
  "format",
  "formatVersion",
  "template",
  "digest",
  "contentDigest",
  "exportedAt",
  "author",
  "signature",
];
const SIGNATURE_KEYS = ["algorithm", "publicKey", "keyId", "value"];

/** A parsed bundle value: shape, template guard, then both digests. */
export function validateGraphTemplateBundle(value: unknown): GraphShareTextParse {
  const errors = new FieldErrorCollector();
  if (!isPlainRecord(value)) {
    return refusal("invalid-bundle", [
      { path: "$", code: "type", message: "A bundle is a JSON object" },
    ]);
  }
  for (const key of Object.keys(value)) {
    if (!BUNDLE_KEYS.includes(key)) errors.add(key, "unknown_field", "Unknown field");
  }
  if (value.format !== GRAPH_BUNDLE_FORMAT) {
    errors.add("format", "format", `format must be ${GRAPH_BUNDLE_FORMAT}`);
  }
  if (value.formatVersion !== GRAPH_BUNDLE_FORMAT_VERSION) {
    errors.add(
      "formatVersion",
      "version",
      `formatVersion must be ${GRAPH_BUNDLE_FORMAT_VERSION}; this bundle needs a newer Orkestrator`,
    );
  }
  for (const key of ["digest", "contentDigest"] as const) {
    if (typeof value[key] !== "string" || !HEX64.test(value[key] as string)) {
      errors.add(key, "digest", `${key} must be a lower-case SHA-256 hex digest`);
    }
  }
  if (
    typeof value.exportedAt !== "string" ||
    !RFC3339_UTC.test(value.exportedAt) ||
    Number.isNaN(Date.parse(value.exportedAt))
  ) {
    errors.add("exportedAt", "timestamp", "exportedAt must be an RFC 3339 UTC timestamp");
  }
  if (value.author !== undefined) {
    const issue = graphBundleAuthorIssue(value.author);
    if (issue) errors.add("author", "author", issue);
  }
  if (value.signature !== undefined) {
    const signature = value.signature;
    if (!isPlainRecord(signature)) {
      errors.add("signature", "type", "signature must be an object");
    } else {
      for (const key of Object.keys(signature)) {
        if (!SIGNATURE_KEYS.includes(key)) {
          errors.add(`signature.${key}`, "unknown_field", "Unknown field");
        }
      }
      if (signature.algorithm !== GRAPH_BUNDLE_SIGNATURE_ALGORITHM) {
        errors.add("signature.algorithm", "algorithm", "signature.algorithm must be ed25519");
      }
      if (!graphSharingPublicKeyBytes(signature.publicKey)) {
        errors.add(
          "signature.publicKey",
          "key",
          "signature.publicKey must be a 32-byte base64url key",
        );
      }
      if (typeof signature.keyId !== "string" || !KEY_ID.test(signature.keyId)) {
        errors.add("signature.keyId", "key", "signature.keyId must be 32 lower-case hex digits");
      }
      const raw =
        typeof signature.value === "string" ? decodeGraphBase64Url(signature.value) : null;
      if (!raw || raw.length !== 64) {
        errors.add("signature.value", "signature", "signature.value must be 64 bytes, base64url");
      }
    }
  }
  if (!isPlainRecord(value.template)) {
    errors.add("template", "type", "template must be a graph template object");
  }
  if (errors.failed) return refusal("invalid-bundle", errors.errors, errors.omitted);

  const guard = validateGraphTemplate(value.template);
  if (!guard.ok) {
    return refusal(
      "invalid-template",
      guard.errors.map((error) => ({
        ...error,
        path: error.path === "$" ? "template" : `template.${error.path}`,
      })),
      guard.omittedErrors,
    );
  }
  const bundle = value as unknown as GraphTemplateBundleV1;
  const template = guard.value;
  if (graphTemplateDigest(template) !== bundle.digest) {
    return refusal("digest-mismatch", [
      {
        path: "digest",
        code: "digest_mismatch",
        message: "The template does not match the bundle's digest: it was changed after export",
      },
    ]);
  }
  if (graphTemplateContentDigest(template) !== bundle.contentDigest) {
    return refusal("content-digest-mismatch", [
      {
        path: "contentDigest",
        code: "digest_mismatch",
        message:
          "The template's content (layout included) does not match the bundle: it was changed after export",
      },
    ]);
  }
  const signature = bundle.signature;
  if (signature && graphSharingKeyId(signature.publicKey) !== signature.keyId) {
    return refusal("signature-invalid", [
      {
        path: "signature.keyId",
        code: "signature_invalid",
        message: "signature.keyId does not belong to signature.publicKey",
      },
    ]);
  }
  return { ok: true, kind: "bundle", bundle: { ...bundle, template } };
}

// ---------------------------------------------------------------- capability summary

/** Node ids, at most {@link GRAPH_SHARING_BOUNDS.maxListedNodes}, plus how many more. */
export interface GraphNodeList {
  nodes: string[];
  more: number;
}

/**
 * What a template would be allowed to do, for a person deciding whether to
 * trust it: profiles, added capabilities, workspace writers, tool groups,
 * system actions and their side effects, what the ceiling removed, and where
 * untrusted content reaches a side effect. Derived from the template, and from
 * the compiled plan when it compiles.
 */
export interface GraphTemplateCapabilitySummary {
  agentNodes: number;
  /** Agent nodes per capability profile, profiles sorted. */
  profiles: Array<{ profile: GraphCapabilityProfileId } & GraphNodeList>;
  /** Capabilities nodes add to their profile with `allow`, sorted. */
  allowed: Array<{ capability: string } & GraphNodeList>;
  /** Nodes declaring workspace write access. */
  workspaceWriters: GraphNodeList;
  /** Agent nodes that keep hosted web search or network access (plan only). */
  networkNodes: GraphNodeList | null;
  /** Orkestrator tool groups any node opted into, sorted. */
  orkestratorGroups: string[];
  /** System actions, with whether each changes something outside the run. */
  systemActions: Array<
    { action: GraphSystemAction; label: string; sideEffect: boolean } & GraphNodeList
  >;
  /** Agent nodes that may ask a person, and human nodes. */
  askHuman: GraphNodeList;
  humanNodes: number;
  /** Sub-graph nodes (each runs another template's capabilities). */
  subgraphs: GraphNodeList;
  /** Capabilities the project ceiling removed, per node (plan only). */
  removedByCeiling: Array<{ node: string; capabilities: string[] }>;
  /** Nodes whose spec asks for `git.push` or `github.write` (always refused, D12). */
  remoteWriteRequests: GraphNodeList;
  /** Side-effect nodes untrusted content can reach (plan only). */
  taint: Array<{
    node: string;
    sideEffect: GraphSideEffectReason;
    source?: GraphTaintSourceReason;
    sources: string[];
  }>;
  /** Taint diagnostics, bounded. */
  taintWarnings: Array<Pick<GraphCompileDiagnostic, "code" | "severity" | "message" | "nodeId">>;
  /** False when the template did not compile; plan-only fields are then null or empty. */
  compiled: boolean;
}

function nodeList(ids: Iterable<string>): GraphNodeList {
  const sorted = [...new Set(ids)].sort();
  const max = GRAPH_SHARING_BOUNDS.maxListedNodes;
  return { nodes: sorted.slice(0, max), more: Math.max(0, sorted.length - max) };
}

function grouped<K extends string>(entries: Array<[K, string]>): Array<[K, GraphNodeList]> {
  const map = new Map<K, string[]>();
  for (const [key, node] of entries) map.set(key, [...(map.get(key) ?? []), node]);
  return [...map]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, nodes]) => [key, nodeList(nodes)]);
}

const REMOTE_WRITES = new Set(["git.push", "github.write"]);

/** The capability summary of `template`; pass the compiled plan and diagnostics when available. */
export function graphTemplateCapabilitySummary(
  template: GraphTemplateV1,
  compiled: { plan: CompiledGraphPlan | null; diagnostics: readonly GraphCompileDiagnostic[] },
): GraphTemplateCapabilitySummary {
  const profiles: Array<[GraphCapabilityProfileId, string]> = [];
  const allowed: Array<[string, string]> = [];
  const writers: string[] = [];
  const groups = new Set<string>();
  const actions: Array<[GraphSystemAction, string]> = [];
  const askHuman: string[] = [];
  const subgraphs: string[] = [];
  const remote: string[] = [];
  let agentNodes = 0;
  let humanNodes = 0;
  for (const node of template.nodes) {
    switch (node.kind) {
      case "agent": {
        agentNodes += 1;
        profiles.push([node.capabilities.profile, node.id]);
        for (const capability of node.capabilities.allow ?? []) {
          allowed.push([capability, node.id]);
          if (capability.startsWith("orkestrator:")) groups.add(capability.slice(12));
          if (REMOTE_WRITES.has(capability)) remote.push(node.id);
        }
        if (node.workspaceAccess === "write") writers.push(node.id);
        if (node.askHuman) askHuman.push(node.id);
        break;
      }
      case "system":
        actions.push([node.action, node.id]);
        break;
      case "human":
        humanNodes += 1;
        break;
      case "subgraph":
        subgraphs.push(node.id);
        break;
      default:
        break;
    }
  }
  const plan = compiled.plan;
  const network: string[] = [];
  const removedByCeiling: GraphTemplateCapabilitySummary["removedByCeiling"] = [];
  const taint: GraphTemplateCapabilitySummary["taint"] = [];
  if (plan) {
    for (const node of plan.nodes) {
      if (node.kind === "agent") {
        if (node.capabilities.webSearch || !node.capabilities.denied.includes("network")) {
          network.push(node.id);
        }
        for (const group of node.capabilities.orkestratorGroups) groups.add(group);
        if (node.capabilities.removedByCeiling.length > 0) {
          removedByCeiling.push({
            node: node.id,
            capabilities: [...node.capabilities.removedByCeiling],
          });
        }
      }
      if (node.taint.tainted && node.taint.sideEffect) {
        taint.push({
          node: node.id,
          sideEffect: node.taint.sideEffect,
          ...(node.taint.source ? { source: node.taint.source } : {}),
          sources: [...node.taint.sources].slice(0, GRAPH_SHARING_BOUNDS.maxListedNodes),
        });
      }
    }
  }
  removedByCeiling.sort((a, b) => (a.node < b.node ? -1 : 1));
  taint.sort((a, b) => (a.node < b.node ? -1 : 1));
  return {
    agentNodes,
    profiles: grouped(profiles).map(([profile, list]) => ({ profile, ...list })),
    allowed: grouped(allowed).map(([capability, list]) => ({ capability, ...list })),
    workspaceWriters: nodeList(writers),
    networkNodes: plan ? nodeList(network) : null,
    orkestratorGroups: [...groups].sort(),
    systemActions: grouped(actions).map(([action, list]) => ({
      action,
      label: GRAPH_SYSTEM_ACTION_SPECS[action]?.label ?? action,
      sideEffect: GRAPH_SYSTEM_ACTION_SPECS[action]?.sideEffect ?? true,
      ...list,
    })),
    askHuman: nodeList(askHuman),
    humanNodes,
    subgraphs: nodeList(subgraphs),
    removedByCeiling,
    remoteWriteRequests: nodeList(remote),
    taint,
    taintWarnings: compiled.diagnostics
      .filter((diagnostic) => diagnostic.code.startsWith("taint"))
      .slice(0, GRAPH_SHARING_BOUNDS.maxTaintWarnings)
      .map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.nodeId ? { nodeId: diagnostic.nodeId } : {}),
      })),
    compiled: plan !== null,
  };
}

// ---------------------------------------------------------------- commands

/** `graph_template_share_export {ref, sign?, author?}`. */
export interface GraphTemplateShareExport {
  /** `<id>.graph-bundle.json`. */
  fileName: string;
  /** {@link graphTemplateBundleText}. */
  text: string;
  digest: string;
  contentDigest: string;
  signed: boolean;
  /** The signing key's id when signed. */
  keyId?: string;
}

/**
 * How far a share-import text can be trusted. `trusted-signer`: a valid
 * signature by a key on the trusted list. `untrusted-signer`: a valid
 * signature by any other key. `unsigned`: a bundle whose digests match but
 * which nobody signed. `no-digest`: a plain template, with nothing to check.
 * Refused texts (tampered, malformed) never get this far.
 */
export const GRAPH_SHARE_INTEGRITY_STATES = [
  "trusted-signer",
  "untrusted-signer",
  "unsigned",
  "no-digest",
] as const;
export type GraphShareIntegrity = (typeof GRAPH_SHARE_INTEGRITY_STATES)[number];

export interface GraphShareSigner {
  keyId: string;
  publicKey: string;
  /** The trusted key's label; absent for an unknown key. */
  label?: string;
  /** The key is this installation's own. */
  own?: boolean;
}

/** What an import would save; nothing is saved until the user confirms the digest. */
export interface GraphTemplateSharePreview {
  kind: "bundle" | "template";
  integrity: GraphShareIntegrity;
  /** Set for signed bundles (`trusted-signer`, `untrusted-signer`). */
  signer?: GraphShareSigner;
  /** {@link graphTemplateDigest} of the template as shared: confirm with this. */
  digest: string;
  contentDigest: string;
  templateId: string;
  name: string;
  description?: string;
  author?: string;
  exportedAt?: string;
  /** Number of custom types the template carries. */
  customTypes: number;
  /** Set when the id is taken: the id the import would use. */
  renameTo?: string;
  /** The template had `engine` (a built-in's export); the copy runs on the graph runtime. */
  engineDropped: boolean;
  /** Compiled under the project's ceiling (or the default ceiling without a project). */
  compile: GraphTemplateCompileSummary;
  capabilities: GraphTemplateCapabilitySummary;
}

/** `graph_template_share_import {text, projectId?, confirmDigest?}`. */
export type GraphTemplateShareImportResult =
  | {
      status: "refused";
      refused: GraphShareRefusalCode;
      errors: FieldError[];
      omittedErrors: number;
    }
  | { status: "preview"; preview: GraphTemplateSharePreview }
  | {
      status: "imported";
      preview: GraphTemplateSharePreview;
      detail: GraphTemplateDetail;
      renamedFrom?: string;
    };

export interface GraphSharingInstallationKey {
  keyId: string;
  publicKey: string;
  createdAt: string;
}

export interface GraphTrustedSigningKey {
  keyId: string;
  publicKey: string;
  label: string;
  addedAt: string;
}

/** `graph_sharing_keys {create?}` and `graph_sharing_key_trust {action, publicKey, label?}`. */
export interface GraphSharingKeys {
  /** This installation's signing key; null until the first signed export (or `create`). */
  installation: GraphSharingInstallationKey | null;
  /** Keys whose signatures import as `trusted-signer`, by label. */
  trusted: GraphTrustedSigningKey[];
}

/** Why a review item has no diff. */
export type GraphTemplateReviewDiffUnavailable =
  "never-approved" | "not-kept" | "too-large" | "edit-distance" | "cpu-budget";

export interface GraphTemplateReviewDiff {
  /** The approved digest the diff starts from. */
  fromDigest: string;
  additions: number;
  deletions: number;
  hunks: ChangeDiffHunk[];
  /** Rendering stopped at {@link GRAPH_SHARING_BOUNDS.maxDiffOutputLines}; counts are complete. */
  truncated: boolean;
}

export interface GraphProjectTemplateReviewItem {
  ref: Extract<GraphTemplateRef, { scope: "project" }>;
  path: string;
  templateId: string;
  name: string;
  description?: string;
  /** `untrusted` or `changed`. */
  trust: Exclude<GraphTemplateTrustState, "trusted">;
  /** The file's current digest: approve or reject with this. */
  digest: string;
  /** The digest of the earlier approval (`changed` only). */
  approvedDigest?: string;
  approvedAt?: string;
  /** The user rejected this exact digest. */
  rejectedAt?: string;
  compile: GraphTemplateCompileSummary;
  capabilities: GraphTemplateCapabilitySummary;
  /** Changed templates whose approved copy was kept. */
  diff: GraphTemplateReviewDiff | null;
  diffUnavailable?: GraphTemplateReviewDiffUnavailable;
}

/** `graph_project_template_review {projectId, path?}`: untrusted and changed templates. */
export interface GraphProjectTemplateReview {
  projectId: string;
  source: GraphProjectTemplateSource;
  /** Needing review first, rejected after; by path within each. */
  items: GraphProjectTemplateReviewItem[];
}

/** `graph_project_template_review_decide {projectId, path, digest, decision}`. */
export interface GraphProjectTemplateReviewDecision {
  projectId: string;
  path: string;
  digest: string;
  decision: "approve" | "reject";
  trust: GraphTemplateTrustState;
  decidedAt: string;
}
