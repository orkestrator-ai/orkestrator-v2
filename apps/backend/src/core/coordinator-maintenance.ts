/**
 * PR polling owns its overlap guard and must not hold coordinator recovery.
 * In particular a hung external read cannot coalesce subsequent repair passes.
 */
export function runCoordinatorMaintenance(
  repair: () => void,
  poll: () => Promise<void>,
  onPollError: (error: unknown) => void,
): void {
  void poll().catch(onPollError);
  repair();
}
