import { defineLogAreas } from "./define.js";

export const AGENT_BRANCH_LOG_AREAS = defineLogAreas({
  "agent-branch": {
    description:
      "Agent branches shared by review fan-outs, graph agents and goal verifiers; `owner` names which.",
    events: {
      "observation.checkpoint-failed":
        "Checkpointing reviewer observations failed; the next pass retries.",
      "transcript.mirror-failed": "Mirroring a reviewer transcript failed.",
      "usage.read-failed": "Reading a reviewer's token usage failed.",
      "result.nudge-failed": "An agent with an uncommitted result could not be nudged.",
      "dispatch.prepare-failed":
        "Attaching the agent before dispatch failed; the prompt request answers authoritatively.",
      "result.consume-deferred":
        "Consuming a branch's workflow result failed; it stays staged and is retried.",
    },
  },
});
