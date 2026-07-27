import type { OpenCodeModelRef } from "@/lib/backend";

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
