import { Gem } from "lucide-react";
import type { NativeAgentSelectionPricing } from "@orkestrator/protocol/native-agent";

/**
 * A quiet marker that the composer's current selection bills at a premium
 * rate. The text comes from the provider's bridge, so this stays provider
 * neutral: it renders whatever premium selection the composer carries.
 */
export function SelectionPricingBadge({
  pricing,
}: {
  pricing: NativeAgentSelectionPricing | undefined;
}) {
  if (pricing?.tier !== "premium") return null;
  const description = pricing.description ?? `${pricing.label} bills at premium rates`;
  return (
    <span
      data-testid="composer-selection-pricing"
      role="status"
      title={description}
      aria-label={`${pricing.label}: ${description}`}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-amber-500 dark:text-amber-400"
    >
      <Gem className="h-3 w-3" aria-hidden />
      {pricing.label}
    </span>
  );
}
