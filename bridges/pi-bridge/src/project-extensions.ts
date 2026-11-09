/**
 * When a session's project extensions stay out of this bridge's process.
 *
 * Pi runs a discovered extension (arbitrary TypeScript under `.pi/`, or a
 * package a project's settings name) inside the process that serves this
 * bridge's routes, during session creation and before any model call. Code
 * there sees every later `Authorization` header and holds the in-process
 * approval gate, so it could resolve a parked call itself, without the
 * signature the approval routes require. Being non-dumpable does not isolate
 * code that is already inside the process.
 *
 * An `auto-approve` or `deny` session has no approval for such code to forge,
 * so it keeps loading extensions when its policy turns project resources on.
 * An `ask` session's approvals are the user's only check on what runs, so its
 * extensions stay off. Skills and prompt templates are text the model reads,
 * not code the bridge runs, and still load. The reported policy says so
 * (`PROJECT_EXTENSIONS_REFUSED_NOTE`), so Agent Info explains why a
 * repository's extensions did not load.
 */
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";

export const PROJECT_EXTENSIONS_REFUSED_NOTE =
  "Pi runs extensions inside the bridge process, where they could answer approvals themselves, so extensions do not load while approvals are on request; project skills and prompt templates still do.";

/** Whether a policy turns project resources on but keeps extensions out. */
export function projectExtensionsRefusedForApprovals(
  policy: Partial<Pick<NativeAgentExecutionPolicy, "approvals" | "projectResources">> | undefined,
  readOnly = false,
): boolean {
  // A read-only session already loads no project resources at all.
  return policy?.projectResources === true && !readOnly && policy.approvals === "ask";
}
