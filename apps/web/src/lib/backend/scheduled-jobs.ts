import type {
  ScheduleAction,
  ScheduleFire,
  ScheduledJob,
  ScheduledJobSummary,
  SchedulerStatus,
} from "@orkestrator/protocol/scheduled-jobs";
import { clientInvoke, commandBackendClient, type BackendClient } from "./client";

/**
 * Scheduled jobs on the connected backend. The app acts as the operator: it
 * sees every schedule and may pause, resume, run, retime or delete any of
 * them, but only changes the action of schedules it created itself.
 */

export interface ScheduledJobTimingInput {
  name?: string;
  at?: string;
  cron?: string;
  everySeconds?: number;
  startAt?: string;
  timeZone?: string;
  catchUpMinutes?: number;
}

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createScheduledJobsApi(client: BackendClient) {
  const invoke = clientInvoke(client);

  /** `scheduler` is absent from a backend that predates it. */
  function listScheduledJobs(
    filter: { projectId?: string; state?: string } = {},
  ): Promise<{ schedules: ScheduledJobSummary[]; scheduler?: SchedulerStatus }> {
    return invoke("list_scheduled_jobs", filter);
  }

  function getScheduledJob(scheduleId: string): Promise<ScheduledJob> {
    return invoke("get_scheduled_job", { scheduleId });
  }

  function createScheduledJob(
    input: ScheduledJobTimingInput & {
      action: ScheduleAction;
      paused?: boolean;
      requestId?: string;
    },
  ): Promise<{ schedule: ScheduledJob; replayed: boolean }> {
    return invoke("create_scheduled_job", { ...input });
  }

  function updateScheduledJob(
    scheduleId: string,
    input: ScheduledJobTimingInput & { action?: ScheduleAction; expectedRevision?: number },
  ): Promise<ScheduledJob> {
    return invoke("update_scheduled_job", { scheduleId, ...input });
  }

  function pauseScheduledJob(scheduleId: string): Promise<ScheduledJob> {
    return invoke("pause_scheduled_job", { scheduleId });
  }

  function resumeScheduledJob(scheduleId: string): Promise<ScheduledJob> {
    return invoke("resume_scheduled_job", { scheduleId });
  }

  function runScheduledJob(scheduleId: string): Promise<{ job: ScheduledJob; fire: ScheduleFire }> {
    return invoke("run_scheduled_job", { scheduleId });
  }

  function deleteScheduledJob(
    scheduleId: string,
  ): Promise<{ scheduleId: string; deleted: boolean }> {
    return invoke("delete_scheduled_job", { scheduleId });
  }

  return {
    listScheduledJobs,
    getScheduledJob,
    createScheduledJob,
    updateScheduledJob,
    pauseScheduledJob,
    resumeScheduledJob,
    runScheduledJob,
    deleteScheduledJob,
  };
}

export type ScheduledJobsApi = ReturnType<typeof createScheduledJobsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  listScheduledJobs,
  getScheduledJob,
  createScheduledJob,
  updateScheduledJob,
  pauseScheduledJob,
  resumeScheduledJob,
  runScheduledJob,
  deleteScheduledJob,
} = createScheduledJobsApi(commandBackendClient);
