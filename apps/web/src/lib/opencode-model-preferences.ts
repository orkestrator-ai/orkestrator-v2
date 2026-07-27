import type { OpenCodeModelRef } from "@/lib/backend";

export function openCodeModelRefToId(
  modelRef?: OpenCodeModelRef,
): string | undefined {
  if (typeof modelRef === "string") {
    const normalized = modelRef.trim();
    return normalized.includes("/") ? normalized : undefined;
  }
  if (!modelRef?.providerID || !modelRef.modelID) return undefined;
  return `${modelRef.providerID}/${modelRef.modelID}`;
}
