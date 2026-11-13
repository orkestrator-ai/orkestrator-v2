import type {
  AgentInteractionOption,
  AgentInteractionQuestion,
} from "@orkestrator/protocol/agent-interactions";

/**
 * Every kind an approval card can arrive as. A case waits for any of them, so
 * a card of the wrong kind is found and then refused by
 * {@link approvalKindProblem} with its actual kind, rather than timing out as
 * "never asked".
 */
export const APPROVAL_KINDS: ReadonlySet<string> = new Set([
  "command-approval",
  "file-approval",
  "permission",
]);

/**
 * The approval kind a case's prompt must raise, where the live run is what
 * proves the provider's mapping. Grok's shell tool is an ACP `execute` call,
 * which the ACP bridge maps to a command approval (todo 0001 item 2); before
 * that mapping it arrived as a generic `permission`, which the generic set
 * above would still have accepted.
 */
export const EXPECTED_APPROVAL_KINDS: Readonly<Record<string, string>> = {
  "grok-approval": "command-approval",
};

/** Why a raised approval has the wrong kind for its case, or `undefined` when it is right. */
export function approvalKindProblem(caseId: string, kind: string): string | undefined {
  if (!APPROVAL_KINDS.has(kind)) return `${caseId}: ${kind} is not an approval`;
  const expected = EXPECTED_APPROVAL_KINDS[caseId];
  if (expected && kind !== expected) return `${caseId}: raised ${kind}, expected ${expected}`;
  return undefined;
}

/** A qualification may grant this request only, never a durable or session policy. */
export function approvalOption(
  question: AgentInteractionQuestion | undefined,
): AgentInteractionOption | undefined {
  if (!question?.required) return undefined;
  const options = question.options.filter(
    (item) =>
      item.amendment === undefined &&
      /^(allow|approve|yes|accept|run)\b/i.test(item.label) &&
      !/always|session|remember|policy|deny|reject|never|\bno\b/i.test(item.label),
  );
  const option = options.find((item) => /\bonce\b/i.test(item.label)) ?? options[0];
  if (!option) throw new Error("No safe allow-once option in required approval question");
  return option;
}

/** Register immediately after creation, before any fallible environment setup. */
export async function withEnvironmentCleanup<T>(
  invoke: (command: string, args: { environmentId: string }) => Promise<unknown>,
  run: (register: (environmentId: string) => void) => Promise<T>,
): Promise<T> {
  const ids = new Set<string>();
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    result = await run((id) => ids.add(id));
  } catch (error) {
    failures.push(error);
  } finally {
    for (const environmentId of Array.from(ids).reverse()) {
      for (const command of ["stop_environment", "delete_environment"]) {
        try {
          await invoke(command, { environmentId });
        } catch (error) {
          failures.push(error);
        }
      }
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Paused interaction qualification failed");
  return result as T;
}

/** Hold a raised request before starting its sibling; other providers may be slow. */
export async function raiseAndProtect<T>(
  groups: readonly (readonly T[])[],
  raise: (item: T) => Promise<void>,
  protect: (item: T) => Promise<void>,
): Promise<void> {
  const results = await Promise.allSettled(
    groups.map(async (group) => {
      for (const item of group) {
        await raise(item);
        await protect(item);
      }
    }),
  );
  // Cleanup must not race a still-dispatching sibling after an early failure.
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason));
}
