/**
 * Runtime validation for transcript artifact inputs and references.
 *
 * The backend tools validate every draft here before any work is admitted;
 * the renderer reads published references through `readTranscriptArtifactRef`
 * so an unknown kind or version becomes an honest unsupported placeholder
 * rather than a crash or a guess.
 */
import { validateChartSpec } from "./chart-spec.js";
import {
  FieldErrorCollector,
  checkArray,
  checkEnum,
  checkFiniteNumber,
  checkObject,
  checkString,
  joinPath,
  type FieldValidation,
} from "./field-validation.js";
import {
  ARTIFACT_TOOL_POLICY,
  CHART_POLICY,
  INTERACTIVE_HTML_POLICY,
  MERMAID_POLICY,
  PREVIEW_CAPTURE_POLICY,
  STATIC_HTML_POLICY,
  utf8ByteLength,
} from "./rich-content-policy.js";
import {
  ARTIFACT_ASSET_NAME_PATTERN,
  ARTIFACT_KINDS,
  isArtifactKind,
  type ArtifactDraft,
  type ArtifactDraftPayload,
  type ArtifactPreviewProfile,
  type ArtifactProbeV1,
  type TranscriptArtifactRef,
} from "./transcript-artifacts.js";

const TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function validateArtifactProbes(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): value is ArtifactProbeV1[] {
  if (!checkArray(value, path, errors, { max: INTERACTIVE_HTML_POLICY.maxProbeSteps }))
    return false;
  value.forEach((probe, index) => {
    const probePath = joinPath(path, index);
    if (typeof probe !== "object" || probe === null) {
      errors.add(probePath, "type", "Expected a probe object");
      return;
    }
    const op = (probe as { op?: unknown }).op;
    const fields: Record<string, readonly string[]> = {
      click: ["op", "target"],
      "set-number": ["op", "target", "value"],
      fill: ["op", "target", "text"],
      "expect-text": ["op", "target", "equals"],
      "expect-number": ["op", "target", "equals", "tolerance"],
      "wait-visible": ["op", "target", "timeoutMs"],
    };
    if (!checkEnum(op, joinPath(probePath, "op"), errors, Object.keys(fields))) return;
    if (!checkObject(probe, probePath, fields[op]!, errors)) return;
    checkString(probe.target, joinPath(probePath, "target"), errors, {
      min: 1,
      max: 64,
      pattern: INTERACTIVE_HTML_POLICY.probeTargetPattern,
    });
    const max = INTERACTIVE_HTML_POLICY.maxProbeTextCharacters;
    switch (op) {
      case "set-number":
        checkFiniteNumber(probe.value, joinPath(probePath, "value"), errors);
        break;
      case "fill":
        checkString(probe.text, joinPath(probePath, "text"), errors, { max });
        break;
      case "expect-text":
        checkString(probe.equals, joinPath(probePath, "equals"), errors, { max });
        break;
      case "expect-number":
        checkFiniteNumber(probe.equals, joinPath(probePath, "equals"), errors);
        if (probe.tolerance !== undefined) {
          checkFiniteNumber(probe.tolerance, joinPath(probePath, "tolerance"), errors, { min: 0 });
        }
        break;
      case "wait-visible":
        if (probe.timeoutMs !== undefined) {
          checkFiniteNumber(probe.timeoutMs, joinPath(probePath, "timeoutMs"), errors, {
            integer: true,
            min: 1,
            max: INTERACTIVE_HTML_POLICY.maxProbeStepMs,
          });
        }
        break;
    }
  });
  return true;
}

function checkBytes(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  maxBytes: number,
  label: string,
): value is string {
  if (typeof value !== "string") {
    errors.add(path, "type", "Expected a string");
    return false;
  }
  if (value.length === 0) {
    errors.add(path, "empty", `${label} must not be empty`);
    return false;
  }
  // A string's UTF-8 size is at most 3 bytes per UTF-16 unit; skip encoding
  // obviously small strings and reject obviously huge ones before encoding.
  if (
    value.length > maxBytes ||
    (value.length * 3 > maxBytes && utf8ByteLength(value) > maxBytes)
  ) {
    errors.add(path, "too_large", `${label} exceeds ${maxBytes} bytes of UTF-8`);
    return false;
  }
  return true;
}

export function validateArtifactDraftPayload(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): value is ArtifactDraftPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.add(path, "type", "Expected a payload object");
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  if (!checkEnum(kind, joinPath(path, "kind"), errors, ARTIFACT_KINDS)) return false;
  switch (kind) {
    case "html-static":
      if (!checkObject(value, path, ["kind", "html"], errors)) return false;
      checkBytes(
        value.html,
        joinPath(path, "html"),
        errors,
        STATIC_HTML_POLICY.maxSourceBytes,
        "HTML",
      );
      break;
    case "html-interactive":
      if (!checkObject(value, path, ["kind", "html", "dependencyIds", "probes"], errors))
        return false;
      checkBytes(
        value.html,
        joinPath(path, "html"),
        errors,
        INTERACTIVE_HTML_POLICY.maxAuthoredBytes,
        "HTML",
      );
      if (value.dependencyIds !== undefined) {
        const depPath = joinPath(path, "dependencyIds");
        if (
          checkArray(value.dependencyIds, depPath, errors, {
            max: INTERACTIVE_HTML_POLICY.maxDependencies,
          })
        ) {
          const seen = new Set<string>();
          value.dependencyIds.forEach((id, index) => {
            if (
              checkString(id, joinPath(depPath, index), errors, {
                min: 1,
                max: 64,
                pattern: /^[a-z0-9][a-z0-9.@_-]*$/,
              })
            ) {
              if (seen.has(id))
                errors.add(joinPath(depPath, index), "duplicate", "Duplicate dependency id");
              seen.add(id);
            }
          });
        }
      }
      if (value.probes !== undefined)
        validateArtifactProbes(value.probes, joinPath(path, "probes"), errors);
      break;
    case "mermaid":
      if (!checkObject(value, path, ["kind", "source"], errors)) return false;
      checkBytes(
        value.source,
        joinPath(path, "source"),
        errors,
        MERMAID_POLICY.maxSourceBytes,
        "Mermaid source",
      );
      break;
    case "chart": {
      if (!checkObject(value, path, ["kind", "spec"], errors)) return false;
      const result = validateChartSpec(value.spec);
      if (!result.ok) {
        for (const error of result.errors) {
          errors.add(
            `${joinPath(path, "spec")}${error.path === "$" ? "" : `.${error.path}`}`,
            error.code,
            error.message,
          );
        }
      } else {
        const bytes = utf8ByteLength(JSON.stringify(value.spec));
        if (bytes > CHART_POLICY.maxPayloadBytes) {
          errors.add(
            joinPath(path, "spec"),
            "too_large",
            `Chart exceeds ${CHART_POLICY.maxPayloadBytes} bytes`,
          );
        }
      }
      break;
    }
    case "workflow-snapshot":
      if ("snapshot" in value) {
        errors.add(
          joinPath(path, "snapshot"),
          "authoritative_source_required",
          "Workflow snapshots are captured by the backend; pass workflowId and runId instead",
        );
        return false;
      }
      if (
        !checkObject(
          value,
          path,
          ["kind", "workflowId", "runId", "expectedWorkflowRevision"],
          errors,
        )
      )
        return false;
      checkString(value.workflowId, joinPath(path, "workflowId"), errors, {
        min: 1,
        max: 128,
        pattern: OPAQUE,
      });
      checkString(value.runId, joinPath(path, "runId"), errors, {
        min: 1,
        max: 128,
        pattern: OPAQUE,
      });
      checkString(
        value.expectedWorkflowRevision,
        joinPath(path, "expectedWorkflowRevision"),
        errors,
        {
          min: 1,
          max: 128,
          pattern: OPAQUE,
          optional: true,
        },
      );
      break;
  }
  return true;
}

export function validateArtifactDraft(value: unknown): FieldValidation<ArtifactDraft> {
  const errors = new FieldErrorCollector();
  if (checkObject(value, "draft", ["title", "summary", "payload", "assets"], errors)) {
    checkString(value.title, "draft.title", errors, {
      min: 1,
      max: ARTIFACT_TOOL_POLICY.maxTitleCharacters,
      pattern: TEXT,
    });
    checkString(value.summary, "draft.summary", errors, {
      max: ARTIFACT_TOOL_POLICY.maxSummaryCharacters,
      pattern: TEXT,
    });
    validateArtifactDraftPayload(value.payload, "draft.payload", errors);
    if (value.assets !== undefined) {
      if (
        checkArray(value.assets, "draft.assets", errors, { max: INTERACTIVE_HTML_POLICY.maxAssets })
      ) {
        const names = new Set<string>();
        value.assets.forEach((asset, index) => {
          const path = joinPath("draft.assets", index);
          if (!checkObject(asset, path, ["name", "assetRef"], errors)) return;
          if (
            checkString(asset.name, joinPath(path, "name"), errors, {
              min: 1,
              max: 100,
              pattern: ARTIFACT_ASSET_NAME_PATTERN,
            })
          ) {
            if (names.has(asset.name))
              errors.add(joinPath(path, "name"), "duplicate", "Duplicate asset name");
            names.add(asset.name);
          }
          checkString(asset.assetRef, joinPath(path, "assetRef"), errors, {
            min: 1,
            max: 128,
            pattern: OPAQUE,
          });
        });
        const kind = (value.payload as { kind?: unknown } | undefined)?.kind;
        if (value.assets.length > 0 && kind !== "html-static" && kind !== "html-interactive") {
          errors.add("draft.assets", "unsupported", "Only HTML artifacts accept assets");
        }
      }
    }
  }
  return errors.result(value as ArtifactDraft);
}

export const DEFAULT_PREVIEW_PROFILE: ArtifactPreviewProfile = {
  theme: "light",
  viewport: { ...PREVIEW_CAPTURE_POLICY.defaultViewport },
};

export function validatePreviewProfile(value: unknown): FieldValidation<ArtifactPreviewProfile> {
  const errors = new FieldErrorCollector();
  if (value === undefined) return { ok: true, value: DEFAULT_PREVIEW_PROFILE };
  if (checkObject(value, "profile", ["theme", "viewport"], errors)) {
    checkEnum(value.theme, "profile.theme", errors, ["light", "dark"] as const);
    if (
      checkObject(
        value.viewport,
        "profile.viewport",
        ["width", "height", "deviceScaleFactor"],
        errors,
      )
    ) {
      const v = value.viewport;
      const p = PREVIEW_CAPTURE_POLICY;
      checkFiniteNumber(v.width, "profile.viewport.width", errors, {
        integer: true,
        min: p.minDimension,
        max: p.maxDimension,
      });
      checkFiniteNumber(v.height, "profile.viewport.height", errors, {
        integer: true,
        min: p.minDimension,
        max: p.maxDimension,
      });
      if (v.deviceScaleFactor !== 1)
        errors.add(
          "profile.viewport.deviceScaleFactor",
          "unsupported",
          "Only deviceScaleFactor 1 is supported",
        );
      if (
        typeof v.width === "number" &&
        typeof v.height === "number" &&
        v.width * v.height > p.maxPixels
      ) {
        errors.add("profile.viewport", "too_large", `Viewport exceeds ${p.maxPixels} pixels`);
      }
    }
  }
  return errors.result(value as ArtifactPreviewProfile);
}

export type ArtifactRefRead =
  | { status: "supported"; ref: TranscriptArtifactRef }
  | { status: "unsupported"; reason: string; title: string; summary: string }
  | { status: "invalid"; reason: string };

/**
 * Read a published reference from a transcript part. Unknown versions or kinds
 * are reported as unsupported with whatever bounded text is safe to show.
 */
export function readTranscriptArtifactRef(value: unknown): ArtifactRefRead {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { status: "invalid", reason: "Artifact reference is not an object" };
  }
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.slice(0, 200) : "Artifact";
  const summary = typeof record.summary === "string" ? record.summary.slice(0, 400) : "";
  if (record.schemaVersion !== 1) {
    return { status: "unsupported", reason: "This artifact uses a newer format.", title, summary };
  }
  if (!isArtifactKind(record.kind)) {
    return {
      status: "unsupported",
      reason: "This artifact kind is not supported by this client.",
      title,
      summary,
    };
  }
  const errors = new FieldErrorCollector();
  if (
    !checkObject(
      record,
      "ref",
      [
        "schemaVersion",
        "artifactId",
        "revision",
        "publicationId",
        "kind",
        "title",
        "summary",
        "provenance",
      ],
      errors,
    )
  ) {
    return { status: "invalid", reason: "Artifact reference has an invalid shape" };
  }
  checkString(record.artifactId, "artifactId", errors, {
    min: 1,
    max: 80,
    pattern: /^art_[A-Za-z0-9_-]{8,64}$/,
  });
  checkString(record.publicationId, "publicationId", errors, {
    min: 1,
    max: 80,
    pattern: /^pub_[A-Za-z0-9_-]{8,64}$/,
  });
  checkFiniteNumber(record.revision, "revision", errors, { integer: true, min: 1 });
  checkString(record.title, "title", errors, { max: 200, pattern: TEXT });
  checkString(record.summary, "summary", errors, { max: 400, pattern: TEXT });
  if (checkObject(record.provenance, "provenance", ["backendId", "origin"], errors)) {
    checkString(record.provenance.backendId, "provenance.backendId", errors, { min: 1, max: 128 });
    checkEnum(record.provenance.origin, "provenance.origin", errors, [
      "agent",
      "user",
      "workflow",
    ] as const);
  }
  if (errors.failed)
    return { status: "invalid", reason: errors.errors[0]?.message ?? "Invalid artifact reference" };
  return { status: "supported", ref: record as unknown as TranscriptArtifactRef };
}
