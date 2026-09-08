import type { TrustedUserPromptPresentation } from "@orkestrator/protocol/review-evidence-frames";

const coordinatorDelegationPresentationAuthority = Symbol(
  "coordinatorDelegationPresentationAuthority",
);

export function withCoordinatorDelegationPresentation(
  args: Record<string, unknown>,
  presentation: TrustedUserPromptPresentation,
): Record<string, unknown> {
  return {
    ...args,
    [coordinatorDelegationPresentationAuthority]: presentation,
  };
}

export function coordinatorDelegationPresentationFrom(args: Record<string, unknown>): unknown {
  return (args as Record<PropertyKey, unknown>)[coordinatorDelegationPresentationAuthority];
}
