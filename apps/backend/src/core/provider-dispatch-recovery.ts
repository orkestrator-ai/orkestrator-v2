import type { ProviderDispatchStatus } from "./agent-provider-contract.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";

/** An exact-request result proves delivery even when the journal lost the id. */
export async function recoveredDispatchAcceptance(
  provider: BuildPipelineProvider,
  sessionId: string,
  requestId: string,
  readToolResult?: () => unknown | Promise<unknown>,
): Promise<ProviderDispatchStatus> {
  const status = await provider
    .dispatchStatus?.(sessionId, requestId)
    .catch(() => "unknown" as const);
  if (status === "dispatched" || status === "pending") return "dispatched";
  try {
    const proven = readToolResult
      ? Boolean(await readToolResult())
      : (await provider.structured<unknown>(sessionId, requestId))?.requestId === requestId;
    if (proven) return "dispatched";
  } catch {
    // Failed reads provide no proof of delivery or non-delivery.
  }
  return status ?? "unknown";
}
