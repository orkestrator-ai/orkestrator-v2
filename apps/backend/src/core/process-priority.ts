import { existsSync } from "node:fs";

/**
 * Agent and build work runs at this nice value so a saturated machine still
 * schedules the backend, which answers every terminal keystroke and composer
 * submit. Children inherit it, so lowering a bridge covers the agent CLI and
 * every build its tools start. The backend stays at the default priority, so
 * nothing here needs privileges.
 *
 * `nice` matters only under contention: an otherwise idle machine runs the work
 * at full speed. Ten is also the most macOS allows before the work changes
 * scheduler class. XNU maps nice onto base priority 31 - nice, and from nice 11
 * a thread falls out of the default bucket into the utility one
 * (`sched_convert_pri_to_bucket`). Background QoS (`taskpolicy -b`) would
 * throttle far harder, including I/O, even on an idle machine.
 *
 * On Linux, nice ranks tasks only inside one CPU cgroup, so this does not favour
 * the backend over work in another cgroup, such as a Docker container.
 */
export const WORKLOAD_NICE = 10;

/**
 * Lowers the shell it runs in. For commands that are already shell strings, this
 * is harmless when `renice` is missing or refuses: the command still runs.
 */
export const LOW_PRIORITY_SHELL_PREFIX = `renice -n ${WORKLOAD_NICE} -p $$ >/dev/null 2>&1; `;

// Absolute paths: the child's PATH can come from a project's own environment, and
// a checkout's `nice` must not run in place of the system's.
const NICE_BINARIES = ["/usr/bin/nice", "/bin/nice"];

export type LowPriorityOptions = {
  platform?: NodeJS.Platform;
  exists?: (candidate: string) => boolean;
};

/**
 * Argv that runs a command at `WORKLOAD_NICE`. `nice` execs the command, so the
 * spawned PID, process group and start time all stay the command's. A command
 * that cannot be found therefore exits 127 rather than failing to spawn. Where
 * there is no `nice` (Windows, unusual layouts) the argv comes back unchanged.
 */
export function lowPriorityCommand(
  command: string,
  args: string[] = [],
  options: LowPriorityOptions = {},
): { command: string; args: string[] } {
  if ((options.platform ?? process.platform) === "win32") return { command, args };
  const exists = options.exists ?? existsSync;
  const nice = NICE_BINARIES.find((candidate) => exists(candidate));
  if (!nice) return { command, args };
  return { command: nice, args: ["-n", String(WORKLOAD_NICE), command, ...args] };
}
