import type {
  AgentInteractionOption,
  AgentInteractionQuestion,
} from "@orkestrator/protocol/agent-interactions";

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
