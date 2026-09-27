/**
 * Functional check for the fixture's expected source change.
 *
 *   bun annotation-app/verify-change.ts                   # expects the change
 *   bun annotation-app/verify-change.ts --expect=original # expects the baseline
 *
 * Proves a repository implementation, not a DOM mutation: it reads the
 * source file, imports it fresh in this process, starts the real fixture
 * server, and checks the label the server renders. Prints one JSON line and
 * exits 0 only when every check passes.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PLANS } from "./content";
import { EXPECTED_SOURCE_CHANGE } from "./fixture-data";
import { startAnnotationFixture } from "./server";

type Check = { name: string; ok: boolean; detail?: string };

function renderedLabel(html: string): string | null {
  const match = /data-testid="plan-cta-team">([^<]*)<\/button>/.exec(html);
  return match ? match[1]! : null;
}

export async function verifyExpectedChange(expect: "changed" | "original"): Promise<{
  ok: boolean;
  expect: string;
  checks: Check[];
}> {
  const change = EXPECTED_SOURCE_CHANGE;
  const wanted = expect === "changed" ? change.after : change.before;
  const unwanted = expect === "changed" ? change.before : change.after;
  const checks: Check[] = [];
  const source = await readFile(path.join(import.meta.dirname, "content.ts"), "utf8");
  checks.push({
    name: "source-contains-expected-label",
    ok: source.includes(`"${wanted}"`),
  });
  checks.push({ name: "source-drops-other-label", ok: !source.includes(`"${unwanted}"`) });
  const team = PLANS.find((plan) => plan.id === change.planId);
  checks.push({ name: "module-team-cta", ok: team?.cta === wanted, detail: team?.cta });
  for (const [id, label] of Object.entries(change.unchanged)) {
    const plan = PLANS.find((candidate) => candidate.id === id);
    checks.push({ name: `module-${id}-unchanged`, ok: plan?.cta === label, detail: plan?.cta });
  }
  checks.push({ name: "plan-count-unchanged", ok: PLANS.length === 3 });
  const fixture = startAnnotationFixture({ port: 0 });
  try {
    const page = await fetch(`${fixture.url}${change.route}`).then((response) => response.text());
    const label = renderedLabel(page);
    checks.push({ name: "rendered-team-cta", ok: label === wanted, detail: label ?? "missing" });
    const health = (await fetch(`${fixture.url}/health`).then((response) => response.json())) as {
      teamCta?: string;
    };
    checks.push({ name: "health-team-cta", ok: health.teamCta === wanted });
  } finally {
    await fixture.close();
  }
  return { ok: checks.every((check) => check.ok), expect, checks };
}

if (import.meta.main) {
  const flag = process.argv.find((argument) => argument.startsWith("--expect="));
  const expect = flag?.slice("--expect=".length) === "original" ? "original" : "changed";
  const result = await verifyExpectedChange(expect);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
