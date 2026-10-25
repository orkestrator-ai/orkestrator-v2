import type {
  ScheduleAction,
  ScheduleFire,
  ScheduledJob,
  ScheduledJobSummary,
} from "@orkestrator/protocol/scheduled-jobs";
import { invoke } from "@/lib/native/backend";

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

export function listScheduledJobs(
  filter: { projectId?: string; state?: string } = {},
): Promise<{ schedules: ScheduledJobSummary[] }> {
  return invoke("list_scheduled_jobs", filter);
}

export function getScheduledJob(scheduleId: string): Promise<ScheduledJob> {
  return invoke("get_scheduled_job", { scheduleId });
}

export function createScheduledJob(
  input: ScheduledJobTimingInput & { action: ScheduleAction; paused?: boolean; requestId?: string },
): Promise<{ schedule: ScheduledJob; replayed: boolean }> {
  return invoke("create_scheduled_job", { ...input });
}

export function updateScheduledJob(
  scheduleId: string,
  input: ScheduledJobTimingInput & { action?: ScheduleAction; expectedRevision?: number },
): Promise<ScheduledJob> {
  return invoke("update_scheduled_job", { scheduleId, ...input });
}

export function pauseScheduledJob(scheduleId: string): Promise<ScheduledJob> {
  return invoke("pause_scheduled_job", { scheduleId });
}

export function resumeScheduledJob(scheduleId: string): Promise<ScheduledJob> {
  return invoke("resume_scheduled_job", { scheduleId });
}

export function runScheduledJob(
  scheduleId: string,
): Promise<{ job: ScheduledJob; fire: ScheduleFire }> {
  return invoke("run_scheduled_job", { scheduleId });
}

export function deleteScheduledJob(
  scheduleId: string,
): Promise<{ scheduleId: string; deleted: boolean }> {
  return invoke("delete_scheduled_job", { scheduleId });
}
