import { configureLogger, resetLogger, type LogOutput, type LogRecord } from "../logger.js";

export interface LogCapture {
  /** Everything written, in order, as it would have been printed. */
  readonly lines: string[];
  readonly outputs: LogOutput[];
  /** Logger entries only; process output has no record. */
  records(): LogRecord[];
  /**
   * Resolves with the first record, already written or still to come, that
   * satisfies `predicate`. Waits for the log write itself rather than polling
   * for it, so a slow host only delays the wait; bound it with the caller's
   * test timeout.
   */
  waitForRecord(predicate: (record: LogRecord) => boolean): Promise<LogRecord>;
  /** Puts the default sink, level and format back. */
  restore(): void;
}

/** Sends this test file's log output to an array instead of the console. */
export function captureLogs(): LogCapture {
  const lines: string[] = [];
  const outputs: LogOutput[] = [];
  const waiters: Array<{
    predicate: (record: LogRecord) => boolean;
    resolve: (record: LogRecord) => void;
  }> = [];
  const records = () => outputs.flatMap((output) => (output.record ? [output.record] : []));
  configureLogger({
    sink: (output) => {
      outputs.push(output);
      lines.push(output.line);
      const record = output.record;
      if (!record) return;
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index]!;
        if (!waiter.predicate(record)) continue;
        waiters.splice(index, 1);
        waiter.resolve(record);
      }
    },
  });
  return {
    lines,
    outputs,
    records,
    waitForRecord: (predicate) => {
      const existing = records().find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<LogRecord>((resolve) => waiters.push({ predicate, resolve }));
    },
    restore: resetLogger,
  };
}
