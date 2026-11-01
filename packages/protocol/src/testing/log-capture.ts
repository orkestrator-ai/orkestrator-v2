import { configureLogger, resetLogger, type LogOutput, type LogRecord } from "../logger.js";

export interface LogCapture {
  /** Everything written, in order, as it would have been printed. */
  readonly lines: string[];
  readonly outputs: LogOutput[];
  /** Logger entries only; process output has no record. */
  records(): LogRecord[];
  /** Puts the default sink, level and format back. */
  restore(): void;
}

/** Sends this test file's log output to an array instead of the console. */
export function captureLogs(): LogCapture {
  const lines: string[] = [];
  const outputs: LogOutput[] = [];
  configureLogger({
    sink: (output) => {
      outputs.push(output);
      lines.push(output.line);
    },
  });
  return {
    lines,
    outputs,
    records: () => outputs.flatMap((output) => (output.record ? [output.record] : [])),
    restore: resetLogger,
  };
}
