import type {
  OpenCodeModelPreferences,
  OpenCodeModelRef,
} from "@/lib/backend";

export const EMPTY_OPENCODE_MODEL_PREFERENCES: OpenCodeModelPreferences = {
  recent: [],
  favorite: [],
  variant: {},
};

export function openCodeModelRefToId(
  modelRef?: OpenCodeModelRef,
): string | undefined {
  const normalizeId = (value: string): string | undefined => {
    const segments = value.split("/").map((segment) => segment.trim());
    return segments.length >= 2 && segments.every(Boolean)
      ? segments.join("/")
      : undefined;
  };

  if (typeof modelRef === "string") {
    return normalizeId(modelRef.trim());
  }
  if (!modelRef) return undefined;
  if (
    typeof modelRef.providerID !== "string" ||
    typeof modelRef.modelID !== "string"
  ) {
    return undefined;
  }
  return normalizeId(`${modelRef.providerID}/${modelRef.modelID}`);
}

/**
 * Collapse a list of mixed-format model references to unique `provider/model`
 * ids, dropping anything unparseable.
 */
export function normalizeOpenCodeModelReferences(input: unknown): string[] {
  if (!Array.isArray(input)) return [];

  const references: string[] = [];
  const seen = new Set<string>();
  for (const candidate of input) {
    let modelId: string | undefined;
    if (typeof candidate === "string") {
      modelId = openCodeModelRefToId(candidate);
    } else if (
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as { providerID?: unknown }).providerID === "string" &&
      typeof (candidate as { modelID?: unknown }).modelID === "string"
    ) {
      modelId = openCodeModelRefToId(candidate as {
        providerID: string;
        modelID: string;
      });
    }

    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    references.push(modelId);
  }
  return references;
}

/**
 * Normalize the preferences file written by the OpenCode TUI.
 *
 * It is user-editable JSON on disk, so every field is treated as untrusted:
 * the reference lists have used both `provider/model` strings and
 * `{providerID, modelID}` objects across versions, and a malformed file must
 * degrade to "no preferences" rather than propagate junk into model selection.
 */
export function normalizeOpenCodeModelPreferences(
  input: unknown,
): OpenCodeModelPreferences {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return EMPTY_OPENCODE_MODEL_PREFERENCES;
  }

  const raw = input as {
    recent?: unknown;
    favorite?: unknown;
    variant?: unknown;
  };
  const variant: Record<string, string> = {};
  if (raw.variant && typeof raw.variant === "object" && !Array.isArray(raw.variant)) {
    for (const [rawModelId, rawVariant] of Object.entries(raw.variant)) {
      const modelId = rawModelId.trim();
      const value = typeof rawVariant === "string" ? rawVariant.trim() : "";
      if (modelId && value) variant[modelId] = value;
    }
  }

  return {
    recent: normalizeOpenCodeModelReferences(raw.recent),
    favorite: normalizeOpenCodeModelReferences(raw.favorite),
    variant,
  };
}
