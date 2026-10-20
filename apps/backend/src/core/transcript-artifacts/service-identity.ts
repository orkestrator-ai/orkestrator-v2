/**
 * Verification identities: what a receipt binds, and what publication
 * re-derives from current code to decide whether that receipt still proves
 * the exact presentation being published.
 *
 * Every field is explicit; `"not-applicable"` marks renderer/browser fields a
 * kind does not use. Runtime facts that only the renderer can report (browser
 * build, bundle hash, sanitized/prepared digests) come from the job result;
 * version labels, policy ids, theme tokens and profile versions come from
 * this module, so a bump here makes every older receipt stale.
 */
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import { CHART_RENDERER_VERSION } from "@orkestrator/protocol/chart-scene";
import { CHART_PALETTE } from "@orkestrator/protocol/chart-svg";
import { RICH_CONTENT_POLICY_VERSION } from "@orkestrator/protocol/rich-content-policy";
import {
  ARTIFACT_VERSIONS,
  NOT_APPLICABLE,
  type ArtifactKind,
  type ArtifactPreviewProfile,
  type ArtifactVerificationIdentity,
} from "@orkestrator/protocol/transcript-artifacts";
import { probesHash, sha256Hex, themeTokensHash, verificationInputHash } from "./hashing.js";
import type { StoredRevision } from "./store-records.js";

export const ARTIFACT_LOCALE = "en-US";
/**
 * Renderer bundle identity of the in-process chart renderer. Charts render
 * without a browser, so their bundle is the versioned chart renderer itself;
 * bumping CHART_RENDERER_VERSION makes older chart receipts stale.
 */
export const CHART_RENDERER_BUNDLE_HASH = sha256Hex(`chart-renderer:${CHART_RENDERER_VERSION}`);
// v2 embeds staged assets before verification; v1 receipts must be previewed again.
export const HTML_STATIC_RENDERER_VERSION = "html-static-preview:v2";
const FONT_MANIFEST = sha256Hex("artifact-fonts:v1\0system-ui,-apple-system,Segoe UI,sans-serif");

/** Per-kind version fields; tests override them to simulate a renderer/policy bump. */
export interface KindVersions {
  validatorVersion: string;
  rendererVersion: string;
  sanitizerVersion: string;
  policyId: string;
  policyVersion: string;
  previewProfileVersion: string;
  fontManifestHash: string;
  locale: string;
  /** Theme tokens the renderer resolves, by theme. */
  themeTokens: (theme: "light" | "dark") => unknown;
}

export type ArtifactIdentityOverrides = Partial<Record<ArtifactKind, Partial<KindVersions>>>;

function baseVersions(kind: ArtifactKind): KindVersions {
  const common = {
    validatorVersion: ARTIFACT_VERSIONS.validator,
    previewProfileVersion: ARTIFACT_VERSIONS.previewProfile,
    fontManifestHash: FONT_MANIFEST,
    locale: ARTIFACT_LOCALE,
  };
  switch (kind) {
    case "html-static":
      return {
        ...common,
        rendererVersion: HTML_STATIC_RENDERER_VERSION,
        sanitizerVersion: ARTIFACT_VERSIONS.staticSanitizer,
        policyId: ARTIFACT_VERSIONS.staticPolicyId,
        policyVersion: ARTIFACT_VERSIONS.staticPolicyVersion,
        themeTokens: (theme) => ({ colorScheme: theme }),
      };
    case "html-interactive":
      return {
        ...common,
        rendererVersion: ARTIFACT_VERSIONS.interactiveRuntime,
        sanitizerVersion: NOT_APPLICABLE,
        policyId: ARTIFACT_VERSIONS.interactivePolicyId,
        policyVersion: ARTIFACT_VERSIONS.interactivePolicyVersion,
        themeTokens: (theme) => ({ colorScheme: theme, channel: ARTIFACT_VERSIONS.frameChannel }),
      };
    case "mermaid":
      return {
        ...common,
        rendererVersion: ARTIFACT_VERSIONS.mermaidRenderer,
        sanitizerVersion: ARTIFACT_VERSIONS.mermaidSanitizer,
        policyId: "mermaid",
        policyVersion: RICH_CONTENT_POLICY_VERSION,
        previewProfileVersion: NOT_APPLICABLE,
        themeTokens: (theme) => ({ mermaidTheme: theme === "dark" ? "dark" : "default" }),
      };
    case "chart":
      return {
        ...common,
        rendererVersion: CHART_RENDERER_VERSION,
        sanitizerVersion: NOT_APPLICABLE,
        policyId: "chart",
        policyVersion: RICH_CONTENT_POLICY_VERSION,
        themeTokens: (theme) => ({ palette: CHART_PALETTE[theme] }),
      };
    case "workflow-snapshot":
      return {
        ...common,
        rendererVersion: NOT_APPLICABLE,
        sanitizerVersion: NOT_APPLICABLE,
        policyId: "workflow-snapshot",
        policyVersion: RICH_CONTENT_POLICY_VERSION,
        previewProfileVersion: NOT_APPLICABLE,
        fontManifestHash: NOT_APPLICABLE,
        locale: NOT_APPLICABLE,
        themeTokens: () => null,
      };
  }
}

export function kindVersions(
  kind: ArtifactKind,
  overrides: ArtifactIdentityOverrides,
): KindVersions {
  return { ...baseVersions(kind), ...overrides[kind] };
}

/** Facts the job reported for this run. */
export interface RuntimeFacts {
  browserBuild?: string;
  rendererBundleHash?: string;
  effectiveSourceHash?: string;
  dependencyManifestHash?: string;
}

export function buildIdentity(
  revision: StoredRevision,
  profile: ArtifactPreviewProfile | null,
  facts: RuntimeFacts,
  overrides: ArtifactIdentityOverrides,
): ArtifactVerificationIdentity {
  const kind = revision.payload.kind;
  const versions = kindVersions(kind, overrides);
  const html = kind === "html-static" || kind === "html-interactive";
  const themed = kind !== "workflow-snapshot" && profile !== null;
  const theme = themed ? profile!.theme : NOT_APPLICABLE;
  return {
    artifactId: revision.artifactId,
    revision: revision.revision,
    kind,
    sourceHash: revision.sourceHash,
    effectiveSourceHash: facts.effectiveSourceHash ?? revision.sourceHash,
    assetManifestHash: revision.assetManifestHash,
    validatorVersion: versions.validatorVersion,
    rendererVersion: versions.rendererVersion,
    rendererBundleHash: facts.rendererBundleHash ?? NOT_APPLICABLE,
    dependencyManifestHash:
      kind === "html-interactive"
        ? (facts.dependencyManifestHash ?? NOT_APPLICABLE)
        : NOT_APPLICABLE,
    sanitizerVersion: versions.sanitizerVersion,
    policyId: versions.policyId,
    policyVersion: versions.policyVersion,
    browserBuild:
      html || kind === "mermaid" ? (facts.browserBuild ?? NOT_APPLICABLE) : NOT_APPLICABLE,
    reducedMotion: html ? "reduce" : NOT_APPLICABLE,
    previewProfileVersion: versions.previewProfileVersion,
    probesHash:
      revision.payload.kind === "html-interactive"
        ? probesHash(revision.payload.probes ?? [])
        : NOT_APPLICABLE,
    theme: theme as ArtifactVerificationIdentity["theme"],
    themeTokensHash: themed
      ? themeTokensHash(versions.rendererVersion, versions.themeTokens(profile!.theme))
      : NOT_APPLICABLE,
    fontManifestHash: versions.fontManifestHash,
    locale: versions.locale,
    viewport: html || kind === "chart" ? (profile ? { ...profile.viewport } : null) : null,
  };
}

/**
 * Re-derives the identity a receipt must carry to be publishable now: the
 * receipt's runtime facts, with every version/policy/profile field taken from
 * current code and every source field from the immutable revision. Returns
 * the names of mismatching fields (empty when current).
 */
export function staleIdentityFields(
  receiptIdentity: ArtifactVerificationIdentity,
  revision: StoredRevision,
  profile: ArtifactPreviewProfile | null,
  current: { browserBuild?: string; dependencyManifestHash?: string; rendererBundleHash?: string },
  overrides: ArtifactIdentityOverrides,
): string[] {
  const kind = revision.payload.kind;
  const expected = buildIdentity(
    revision,
    profile,
    {
      browserBuild: current.browserBuild ?? receiptIdentity.browserBuild,
      // A kind without a renderer bundle must say so; one whose current
      // bundle is unknown here can only be compared with itself.
      rendererBundleHash:
        current.rendererBundleHash ??
        (kind === "workflow-snapshot" ? NOT_APPLICABLE : receiptIdentity.rendererBundleHash),
      effectiveSourceHash: receiptIdentity.effectiveSourceHash,
      dependencyManifestHash:
        current.dependencyManifestHash ?? receiptIdentity.dependencyManifestHash,
    },
    overrides,
  );
  const mismatched: string[] = [];
  for (const key of Object.keys(expected) as Array<keyof ArtifactVerificationIdentity>) {
    if (canonicalJson(expected[key] ?? null) !== canonicalJson(receiptIdentity[key] ?? null))
      mismatched.push(key);
  }
  return mismatched;
}

export function identityInputHash(identity: ArtifactVerificationIdentity): string {
  return verificationInputHash(identity);
}
