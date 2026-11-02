import type { BuildPipelineKeyInformation } from "@orkestrator/protocol/build-pipeline-key-information";

/** A brief with every section filled, for the key information panel and tab. */
export const keyInformation: BuildPipelineKeyInformation = {
  framing: "objective",
  statement: "Show the pipeline's status at a glance.",
  context: "The build tab only showed a temporary banner.",
  solution: "A key information panel in the header.",
  workDone: ["Added the panel", "Added the agent tools"],
  decisions: [
    {
      decision: "Where to store the brief",
      options: [
        {
          option: "On the pipeline record",
          pros: ["One source of truth"],
          cons: ["Bigger record"],
        },
        { option: "In a separate file", pros: ["Small record"], cons: ["Second store"] },
      ],
      chosen: "On the pipeline record",
      rationale: "Every client already syncs the record.",
    },
  ],
  notDone: ["Rich text formatting"],
  tests: [
    { name: "bun test key-information", result: "passed" },
    { name: "mise run test:browser", result: "not-run", details: "Not needed here." },
  ],
  issues: [
    {
      round: 0,
      issue: "Missing bound on decisions",
      severity: "P1",
      resolution: "Bounded to twelve decisions.",
      status: "resolved",
    },
  ],
  verifications: [
    {
      round: 0,
      passed: false,
      summary: "One criterion failed.",
      checks: [
        { check: "Header shows the timer", passed: true },
        { check: "Panel lists decisions", passed: false, details: "Pros were missing." },
      ],
    },
  ],
  updatedAt: "2026-11-01T10:00:00.000Z",
  updates: [
    {
      at: "2026-11-01T10:00:00.000Z",
      author: "verify",
      round: 0,
      sections: ["verification"],
    },
  ],
};
