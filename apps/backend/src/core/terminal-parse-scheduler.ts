/**
 * Meters how much terminal output the backend's headless xterm parsers
 * (`terminal-history.ts`) take on in one event-loop turn.
 *
 * Every terminal keeps a headless xterm so a reconnecting client can be given
 * its exact screen. xterm parses each `write` synchronously once its own
 * timer fires, carries on through its queue for up to 12 ms, and never splits
 * a chunk, so a single coalesced 256 KB chunk is one uninterrupted parse.
 * Every busy terminal's timer fires in the same timers phase, so N terminals
 * held the loop for up to N × 12 ms at a time, and a keystroke's echo waited
 * behind all of it (measured with `apps/backend/scripts/terminal-latency.ts`,
 * docs/development/terminal-latency.md).
 *
 * Output now reaches the parsers in slices of at most
 * {@link HEADLESS_PARSE_SLICE_CHARS}, one slice in flight per terminal and at
 * most {@link HEADLESS_PARSE_TURN_CHARS} in flight across all of them, taken
 * round-robin so one flooding terminal cannot starve another. The next slices
 * are issued from `setImmediate`, after the event loop has polled for I/O, so
 * a keystroke, its echo and every request get in between.
 *
 * Nothing is dropped and order per terminal is kept: a write's promise
 * resolves once all of its slices are parsed, exactly as the direct write's
 * callback did. Total parsing work is unchanged; only when it runs moves.
 * Idle, it schedules nothing.
 */

/** The slice of a headless terminal this needs. */
export type HeadlessParseTarget = {
  write(data: string, callback?: () => void): void;
};

/** Largest piece of output one parser is handed at a time (about 1 ms of parsing). */
export const HEADLESS_PARSE_SLICE_CHARS = 8 * 1024;
/** Output in flight across all parsers before the scheduler yields to the event loop. */
export const HEADLESS_PARSE_TURN_CHARS = 32 * 1024;

type ParseJob = {
  text: string;
  offset: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/** Cuts at most `size` code units from `offset`, never between a surrogate pair. */
export function nextParseSlice(text: string, offset: number, size: number): number {
  let end = Math.min(text.length, offset + size);
  if (end < text.length && end - offset > 1) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return end;
}

export class HeadlessParseScheduler {
  /** Pending writes per parser, oldest first; insertion order is the round-robin order. */
  private readonly queues = new Map<HeadlessParseTarget, ParseJob[]>();
  private readonly inFlight = new Set<HeadlessParseTarget>();
  private inFlightChars = 0;
  private pumpScheduled = false;

  constructor(
    private readonly sliceChars = HEADLESS_PARSE_SLICE_CHARS,
    private readonly turnChars = HEADLESS_PARSE_TURN_CHARS,
    private readonly defer: (run: () => void) => void = (run) => setImmediate(run),
  ) {}

  /** Parses `text` into `target`; resolves once every slice of it is parsed. */
  write(target: HeadlessParseTarget, text: string): Promise<void> {
    if (!text) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let jobs = this.queues.get(target);
      if (!jobs) {
        jobs = [];
        this.queues.set(target, jobs);
      }
      jobs.push({ text, offset: 0, resolve, reject });
      // A parser with nothing in flight starts at once, within this turn's
      // budget: an idle terminal's output is parsed as promptly as before.
      this.pump();
    });
  }

  /** Writes waiting or in flight; for diagnostics and tests. */
  stats(): { queuedTargets: number; inFlightTargets: number; inFlightChars: number } {
    return {
      queuedTargets: this.queues.size,
      inFlightTargets: this.inFlight.size,
      inFlightChars: this.inFlightChars,
    };
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    this.defer(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.inFlightChars >= this.turnChars) return;
    for (const target of Array.from(this.queues.keys())) {
      if (this.inFlightChars >= this.turnChars) break;
      if (this.inFlight.has(target)) continue;
      this.issue(target);
    }
  }

  private issue(target: HeadlessParseTarget): void {
    const jobs = this.queues.get(target);
    const job = jobs?.[0];
    if (!jobs || !job) {
      this.queues.delete(target);
      return;
    }
    const end = nextParseSlice(job.text, job.offset, this.sliceChars);
    const slice =
      job.offset === 0 && end === job.text.length ? job.text : job.text.slice(job.offset, end);
    job.offset = end;
    this.inFlight.add(target);
    this.inFlightChars += slice.length;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      this.inFlight.delete(target);
      this.inFlightChars -= slice.length;
      if (job.offset >= job.text.length) {
        jobs.shift();
        job.resolve();
      }
      if (this.queues.get(target) === jobs) {
        // Rotate: a parser just served goes behind every parser still waiting,
        // including one that started waiting while this slice was parsed.
        this.queues.delete(target);
        if (jobs.length > 0) this.queues.set(target, jobs);
      }
      // Never hand this parser more from inside its own callback: xterm would
      // parse it in the same run. The next slices wait for the next turn.
      if (this.queues.size > 0) this.schedulePump();
    };
    try {
      target.write(slice, done);
    } catch (error) {
      // A parser that refuses a write (disposed) fails this write, as the
      // direct write did; its later writes still get their own attempt.
      settled = true;
      this.inFlight.delete(target);
      this.inFlightChars -= slice.length;
      jobs.shift();
      if (jobs.length === 0 && this.queues.get(target) === jobs) this.queues.delete(target);
      job.reject(error);
      if (this.queues.size > 0) this.schedulePump();
    }
  }
}
