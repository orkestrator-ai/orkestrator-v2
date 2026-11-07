import type { TrustedUserPromptPresentation } from "@orkestrator/protocol/review-evidence-frames";
import type { CommandHandler, CommandInvocation } from "./commands-context.js";

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

/**
 * The `beforeDecode` option of a defined command that reads the
 * presentation (plan item 7009). Decoding builds a new arguments object with
 * the declared string keys only, so the in-process symbol would be dropped:
 * it moves to a copy of the invocation instead, which reaches the handler
 * unchanged. A call from another process never carries it.
 */
export function carryCoordinatorDelegationPresentation(run: CommandHandler): CommandHandler {
  return (args, context, invocation) => {
    const presentation = coordinatorDelegationPresentationFrom(args);
    if (presentation === undefined) return run(args, context, invocation);
    const carried = { ...invocation, [coordinatorDelegationPresentationAuthority]: presentation };
    return run(args, context, carried as CommandInvocation);
  };
}

/** The decoded arguments with the presentation {@link carryCoordinatorDelegationPresentation} carried. */
export function restoreCoordinatorDelegationPresentation(
  args: Record<string, unknown>,
  invocation: CommandInvocation | undefined,
): Record<string, unknown> {
  const presentation = (invocation as Record<PropertyKey, unknown> | undefined)?.[
    coordinatorDelegationPresentationAuthority
  ];
  return presentation === undefined
    ? args
    : { ...args, [coordinatorDelegationPresentationAuthority]: presentation };
}
