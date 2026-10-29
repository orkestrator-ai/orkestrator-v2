import { egressGatewayName } from "../src/core/egress-gateway";

const COMPOUND_VERBS = new Set(["container", "context", "image", "network", "system", "volume"]);

export function dockerVerb(args: readonly string[]): string {
  const at = args.findIndex((arg) => !arg.startsWith("-"));
  if (at < 0) return "none";
  const verb = args[at]!;
  return COMPOUND_VERBS.has(verb) && args[at + 1] ? `${verb} ${args[at + 1]}` : verb;
}

export function createdName(args: readonly string[]): string | null {
  if (!["create", "container create", "run"].includes(dockerVerb(args))) return null;
  const at = args.indexOf("--name");
  return at >= 0 ? (args[at + 1] ?? null) : null;
}

export interface CallIdentities {
  runtime: string[];
  gateway: string[];
}

/**
 * A fresh runtime's identities, from its own calls: the creates' names and the
 * runtime's `container:<gateway>` network. Finding them costs no Docker call.
 */
export function freshIdentities(
  calls: ReadonlyArray<{ args: readonly string[] }>,
  runtimeId: string,
): CallIdentities {
  const names = calls.map((call) => createdName(call.args)).filter((name) => name !== null);
  const runtimeName =
    names.find((name) => names.includes(egressGatewayName(name))) ?? names.at(-1) ?? "";
  const gatewayName = names.includes(egressGatewayName(runtimeName))
    ? egressGatewayName(runtimeName)
    : "";
  const gatewayId =
    calls
      .find((call) => createdName(call.args) === runtimeName)
      ?.args.find((arg) => arg.startsWith("container:"))
      ?.slice("container:".length) ?? "";
  return {
    runtime: [runtimeId, runtimeName].filter(Boolean),
    gateway: [gatewayId, gatewayName].filter(Boolean),
  };
}

/**
 * Counts calls by `<step> <target> <verb>`, where the target is the runtime,
 * its egress gateway, or neither (volumes, the network, storage helpers).
 */
export function attributeCalls(
  calls: ReadonlyArray<{ step: string; args: readonly string[] }>,
  ids: CallIdentities,
): Record<string, number> {
  const mentions = (names: string[], args: readonly string[]) =>
    args.some((arg) =>
      names.some(
        (name) => arg === name || arg.startsWith(`${name}:`) || arg === `container:${name}`,
      ),
    );
  const counts: Record<string, number> = {};
  for (const call of calls) {
    const created = createdName(call.args);
    const target =
      created !== null
        ? ids.runtime.includes(created)
          ? "runtime"
          : ids.gateway.includes(created)
            ? "gateway"
            : "other"
        : mentions(ids.runtime, call.args)
          ? "runtime"
          : mentions(ids.gateway, call.args)
            ? "gateway"
            : "other";
    const key = `${call.step} ${target} ${dockerVerb(call.args)}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Per key, the count in each sample (0 where a sample had none). */
export function collectBreakdowns(
  samples: Array<Record<string, number>>,
): Record<string, number[]> {
  const keys = [...new Set(samples.flatMap((sample) => Object.keys(sample)))].sort();
  return Object.fromEntries(keys.map((key) => [key, samples.map((sample) => sample[key] ?? 0)]));
}

/** Totals by step (field 0) or by target (field 1) of `<step> <target> <verb>` keys. */
export function totalsBy(breakdown: Record<string, number>, field: 0 | 1): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const [key, count] of Object.entries(breakdown)) {
    const name = key.split(" ")[field]!;
    totals[name] = (totals[name] ?? 0) + count;
  }
  return totals;
}
