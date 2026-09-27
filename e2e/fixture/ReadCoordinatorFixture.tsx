import { useCoordinatedRead } from "../../apps/web/src/hooks/useCoordinatedRead";
import type { ReadContext, ReadPriority } from "../../apps/web/src/lib/read-coordinator";

interface ReadRecord {
  name: string;
  reason: ReadContext["reason"];
  at: number;
}

declare global {
  interface Window {
    readCoordinatorProbe?: { reads: ReadRecord[] };
  }
}

const probe = (window.readCoordinatorProbe ??= { reads: [] });

/**
 * One consumer of the shared, real-environment read coordinator. Each read
 * records its reason and start time so the browser spec can assert cadence,
 * hidden-document silence and resume ordering against real timers and events.
 */
function CoordinatedCounter({
  name,
  priority,
  intervalMs,
}: {
  name: string;
  priority: ReadPriority;
  intervalMs: number;
}) {
  const { state } = useCoordinatedRead<number>({
    key: { resource: "fixture-counter", target: name },
    demand: { intervalMs, priority },
    trackState: true,
    read: async (context) => {
      probe.reads.push({ name, reason: context.reason, at: performance.now() });
      return probe.reads.filter((read) => read.name === name).length;
    },
  });
  return (
    <p data-testid={`${name}-reads`}>
      {name}: {state?.value ?? 0} ({state?.status ?? "idle"})
    </p>
  );
}

export function ReadCoordinatorFixture() {
  return (
    <main className="p-4 text-sm text-foreground">
      <CoordinatedCounter name="session" priority="critical" intervalMs={500} />
      <CoordinatedCounter name="files" priority="standard" intervalMs={1_000} />
    </main>
  );
}
