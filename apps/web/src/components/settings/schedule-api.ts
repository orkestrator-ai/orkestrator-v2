import { useMemo } from "react";
import * as backend from "@/lib/backend";
import { createAgentMailApi } from "@/lib/backend/agent-mail";
import { backendApiForScope } from "@/lib/backend/client";
import { createScheduledJobsApi } from "@/lib/backend/scheduled-jobs";
import { useNodeScope } from "@/lib/node-scope/providers";

/**
 * The commands a schedule list and its dialog use. Settings → Schedules
 * passes the `@/lib/backend` named exports (the window's own machine); a
 * project's Scheduling tab uses {@link useScheduleApi}, the project's node.
 */
export type ScheduleApi = Pick<
  typeof backend,
  | "listScheduledJobs"
  | "getScheduledJob"
  | "createScheduledJob"
  | "updateScheduledJob"
  | "pauseScheduledJob"
  | "resumeScheduledJob"
  | "runScheduledJob"
  | "deleteScheduledJob"
  | "listAgentMailboxes"
>;

/**
 * The nearest node scope's schedule commands: the `@/lib/backend` named
 * exports (which suites mock) on the app's command scope, otherwise that
 * scope's own node.
 */
export function useScheduleApi(): ScheduleApi {
  const scope = useNodeScope();
  // Stable per scope: the list and dialog re-read when it changes.
  return useMemo(() => scheduleApiForScope(scope), [scope]);
}

function scheduleApiForScope(scope: ReturnType<typeof useNodeScope>): ScheduleApi {
  const schedules = backendApiForScope(scope, createScheduledJobsApi, backend);
  const mail = backendApiForScope(scope, createAgentMailApi, backend);
  return {
    listScheduledJobs: schedules.listScheduledJobs,
    getScheduledJob: schedules.getScheduledJob,
    createScheduledJob: schedules.createScheduledJob,
    updateScheduledJob: schedules.updateScheduledJob,
    pauseScheduledJob: schedules.pauseScheduledJob,
    resumeScheduledJob: schedules.resumeScheduledJob,
    runScheduledJob: schedules.runScheduledJob,
    deleteScheduledJob: schedules.deleteScheduledJob,
    listAgentMailboxes: mail.listAgentMailboxes,
  };
}
