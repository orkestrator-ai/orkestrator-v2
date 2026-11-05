import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const HOST_LOG_AREAS = defineLogAreas({
  host: {
    description: "The host machine: its executables, load, suspends and maintenance.",
    events: {
      "path.discovered":
        "Executable discovery finished. Counts and booleans only: PATH entries can hold private directory names.",
      "tool.available": "A host tool's availability was read.",
      "tool.missing": "A host tool was not found.",
      "maintenance.listener-failed": "A host maintenance listener threw; the others still run.",
      "suspend.reconcile-failed": "Reconciling due work after a host suspension failed.",
      "load.sample-failed": "Sampling machine load failed; the next sample retries.",
      "usage.source-stalled":
        "A usage source (scope: disk or gpu-sysfs) did not answer in time; its figure is missing from the sample until it does.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});
