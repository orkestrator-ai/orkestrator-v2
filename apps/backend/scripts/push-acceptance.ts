/**
 * Push event layer acceptance measurement (to-do 8102 task 7):
 *
 *   mise exec -- bun apps/backend/scripts/push-acceptance.ts \
 *     [--quiet-minutes 10] [--streaming-seconds 20] [--announced 20] [--out result.json]
 *
 * Runs the deterministic fixture in `tests/push-acceptance-fixture.ts` for the old
 * cadence (`before`: a backend whose streams offer no push, so the view polls
 * at 500 ms running / 1.5 s idle) and push (`after`) against a bridge without
 * revisions (`cadence`: the observer reads at the old cadence) and one with
 * them (`revisions`: the observer reads on the bridge's hints), with one and
 * two viewers of one running Claude session, and prints a Markdown table: reads
 * a minute per viewer, wire bytes a minute per viewer (HTTP requests and
 * answers at the socket, plus event-stream bytes), bridge calls a minute by
 * route, and observation latency (virtual scheduling delay plus this host's
 * wall-clock processing). No provider runs, no port but loopback is bound,
 * and the data directory is temporary.
 */
import { parseArgs } from "node:util";
import {
  DEFAULT_SCENARIO,
  formatTable,
  runScenario,
  type ScenarioResult,
} from "../tests/push-acceptance-fixture.js";

const { values: args } = parseArgs({
  options: {
    "quiet-minutes": { type: "string", default: String(DEFAULT_SCENARIO.quietMinutes) },
    "streaming-seconds": { type: "string", default: String(DEFAULT_SCENARIO.streamingSeconds) },
    announced: { type: "string", default: String(DEFAULT_SCENARIO.announcedChanges) },
    out: { type: "string" },
  },
});

const common = {
  quietMinutes: Number(args["quiet-minutes"]),
  streamingSeconds: Number(args["streaming-seconds"]),
  announcedChanges: Number(args.announced),
  announcedEveryMs: DEFAULT_SCENARIO.announcedEveryMs,
};
const runs = [
  // The old cadence against an old bridge (the baseline).
  { mode: "before", bridge: "cadence" },
  // Push against a bridge without revisions: the observer reads at the old cadence.
  { mode: "after", bridge: "cadence" },
  // Push against a revisions-capable bridge: the observer reads on its hints.
  { mode: "after", bridge: "revisions" },
] as const;
const results: ScenarioResult[] = [];
for (const run of runs) {
  for (const viewers of [1, 2]) {
    const startedAt = performance.now();
    results.push(await runScenario({ ...common, ...run, viewers }));
    process.stderr.write(
      `${run.mode} (${run.bridge}), ${viewers} viewer(s): ${Math.round(performance.now() - startedAt)} ms\n`,
    );
  }
}
process.stdout.write(`${formatTable(results)}\n`);
if (args.out) await Bun.write(args.out, JSON.stringify(results, null, 2));
