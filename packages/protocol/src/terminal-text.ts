/**
 * Raw terminal output as plain display text.
 *
 * A PTY stream is not text: spinners and progress bars redraw in place with a
 * carriage return, a backspace, or cursor and erase sequences (`ESC[1G`,
 * `ESC[0K`, `ESC[2A`…). Deleting those sequences without applying them leaves
 * every frame on the page (`⠙⠹⠸⠼npm notice…`). This interpreter keeps a small
 * line buffer and a cursor and applies the moves that matter for line-oriented
 * output, so the text shows what a terminal would show:
 *
 * - `\r` (column 0), `\b` (one column back), `\n` (next line, column 0);
 * - CSI `G` (column), `C`/`D` (forward/back), `K` (erase in line),
 *   `A`/`F` (up) and `B`/`E` (down), `J` (erase below, above, or everything),
 *   `H`/`f` (its column only), `s`/`u` and `ESC 7`/`ESC 8` (save/restore);
 * - SGR (`m`), private modes (`ESC[?25l`), every other CSI, OSC, DCS, APC, PM,
 *   SOS and other escapes are removed without effect.
 *
 * It is not a terminal emulator: there is no screen size, no wrapping and no
 * scroll region, every code point is one column, and full-screen TUIs are out
 * of scope. Cursor-up stops at the first line held, cursor-down at the last.
 *
 * Work is linear in the input: each character costs O(1) amortised, and the
 * only operations that can touch more cells than they consume (padding after a
 * forward move, erasing to the start of a line, clearing earlier rows) draw on a budget proportional
 * to the input. An escape sequence split across `write` calls is held until
 * it completes, so feeding chunks gives the same text as feeding their
 * concatenation.
 *
 * Browser-safe: no Node imports. Output may contain secrets; never log it.
 */

const ESC = 0x1b;
/** Longest CSI (parameters and intermediates) before it is abandoned. */
const MAX_CSI_LENGTH = 64;
/** Longest OSC/DCS/APC/PM/SOS body before it is abandoned. */
const MAX_STRING_LENGTH = 8 * 1024;
/** Padding/erase cells allowed per input character, plus a fixed floor. */
const BUDGET_PER_CHAR = 4;
const BUDGET_FLOOR = 4 * 1024;
/** Largest single cursor move honoured; bigger values are clamped. */
const MAX_MOVE = 4 * 1024;

type Mode =
  | { kind: "text" }
  | { kind: "escape" }
  /** `ESC` followed by intermediates (`ESC ( B`): ends at a final byte. */
  | { kind: "nf" }
  | { kind: "csi"; buffer: string }
  /** OSC, DCS, APC, PM, SOS: ends at BEL (OSC) or ST (`ESC \`). */
  | { kind: "string"; length: number; sawEscape: boolean };

export class TerminalTextBuffer {
  private lines: string[][] = [[]];
  /** Rows before this index are known empty; writes invalidate the prefix. */
  private clearedAbove = 0;
  private row = 0;
  private col = 0;
  private saved: { row: number; col: number } | null = null;
  private mode: Mode = { kind: "text" };
  private budget = BUDGET_FLOOR;
  /** A high surrogate waiting for its pair across a chunk boundary. */
  private pendingHigh = "";

  /** Apply one chunk of terminal output. */
  write(chunk: string): void {
    for (let index = 0; index < chunk.length; index += 1) {
      // Future input must not fund earlier work, even within the same chunk.
      this.budget += BUDGET_PER_CHAR;
      const code = chunk.charCodeAt(index);
      switch (this.mode.kind) {
        case "text":
          this.text(chunk, index, code);
          break;
        case "escape":
          this.escape(code);
          break;
        case "nf":
          // Intermediates continue the sequence; anything else ends it.
          if (code < 0x20 || code > 0x2f) this.mode = { kind: "text" };
          break;
        case "csi":
          this.csiByte(code);
          break;
        case "string":
          this.stringByte(code);
          break;
      }
    }
  }

  /** The text so far: lines joined with `\n`. An incomplete escape is not shown. */
  toString(): string {
    let out = "";
    for (let index = 0; index < this.lines.length; index += 1) {
      if (index > 0) out += "\n";
      out += this.lines[index]!.join("");
    }
    return out;
  }

  private text(chunk: string, index: number, code: number): void {
    if (this.pendingHigh) {
      const high = this.pendingHigh;
      this.pendingHigh = "";
      if (code >= 0xdc00 && code <= 0xdfff) {
        this.put(high + chunk[index]!);
        return;
      }
      this.put(high);
    }
    if (code === ESC) {
      this.mode = { kind: "escape" };
      return;
    }
    if (code < 0x20 || code === 0x7f) {
      this.control(code);
      return;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      this.pendingHigh = chunk[index]!;
      return;
    }
    this.put(chunk[index]!);
  }

  private control(code: number): void {
    switch (code) {
      case 0x0a: // \n (a PTY sends \r\n; a bare \n is treated the same)
      case 0x0b: // VT
      case 0x0c: // FF
        this.row += 1;
        this.col = 0;
        if (this.row >= this.lines.length) this.lines.push([]);
        return;
      case 0x0d: // \r
        this.col = 0;
        return;
      case 0x08: // \b
        if (this.col > 0) this.col -= 1;
        return;
      case 0x09: // \t is kept as a character, as before
        this.put("\t");
        return;
      default:
        // BEL, NUL, DEL and other controls have no visible effect.
        return;
    }
  }

  private escape(code: number): void {
    switch (code) {
      case 0x5b: // [
        this.mode = { kind: "csi", buffer: "" };
        return;
      case 0x5d: // ] OSC
      case 0x50: // P DCS
      case 0x58: // X SOS
      case 0x5e: // ^ PM
      case 0x5f: // _ APC
        this.mode = { kind: "string", length: 0, sawEscape: false };
        return;
      case 0x37: // 7 DECSC
        this.saved = { row: this.row, col: this.col };
        break;
      case 0x38: // 8 DECRC
        this.restore();
        break;
      case 0x4d: // M reverse index: up one line
        this.up(1);
        break;
      case ESC:
        // A doubled ESC: the first is dropped, the second starts a sequence.
        return;
      default:
        if (code >= 0x20 && code <= 0x2f) {
          this.mode = { kind: "nf" };
          return;
        }
        // Any other two-byte escape is removed. A control character here
        // abandons the escape and still takes effect.
        if (code < 0x20) {
          this.mode = { kind: "text" };
          this.control(code);
          return;
        }
        break;
    }
    this.mode = { kind: "text" };
  }

  private csiByte(code: number): void {
    const mode = this.mode as { kind: "csi"; buffer: string };
    if (code >= 0x40 && code <= 0x7e) {
      this.mode = { kind: "text" };
      this.csi(mode.buffer, code);
      return;
    }
    if (code >= 0x20 && code <= 0x3f && mode.buffer.length < MAX_CSI_LENGTH) {
      mode.buffer += String.fromCharCode(code);
      return;
    }
    // Malformed or overlong: drop what was collected. A control or escape
    // that interrupted it still takes effect, as in a terminal.
    this.mode = { kind: "text" };
    if (code === ESC) this.mode = { kind: "escape" };
    else if (code < 0x20) this.control(code);
  }

  private stringByte(code: number): void {
    const mode = this.mode as { kind: "string"; length: number; sawEscape: boolean };
    if (code === 0x07) {
      this.mode = { kind: "text" };
      return;
    }
    if (mode.sawEscape) {
      // `ESC \` is ST. Any other escape ends the string and starts anew.
      if (code === 0x5c) {
        this.mode = { kind: "text" };
        return;
      }
      this.mode = { kind: "escape" };
      this.escape(code);
      return;
    }
    if (code === ESC) {
      mode.sawEscape = true;
      return;
    }
    mode.length += 1;
    // An unterminated string cannot swallow the rest of the output.
    if (mode.length > MAX_STRING_LENGTH) this.mode = { kind: "text" };
  }

  private csi(buffer: string, final: number): void {
    // Private modes (`?25l`, `>c`…) and sequences with intermediates change
    // nothing this buffer models.
    if (/^[<=>?]/.test(buffer) || /[ -/]/.test(buffer)) return;
    const params = buffer.split(/[;:]/).map((part) => {
      const value = Number.parseInt(part, 10);
      return Number.isFinite(value) ? Math.min(value, MAX_MOVE) : 0;
    });
    const first = params[0] ?? 0;
    const count = Math.max(1, first);
    switch (String.fromCharCode(final)) {
      case "G": // CHA
      case "`": // HPA
        this.col = count - 1;
        return;
      case "H": // CUP: no screen origin here, so only the column applies.
      case "f":
        this.col = Math.max(1, params[1] ?? 0) - 1;
        return;
      case "C":
      case "a":
        this.col += count;
        return;
      case "D":
        this.col = Math.max(0, this.col - count);
        return;
      case "A":
        this.up(count);
        return;
      case "F":
        this.up(count);
        this.col = 0;
        return;
      case "B":
      case "e":
        this.down(count);
        return;
      case "E":
        this.down(count);
        this.col = 0;
        return;
      case "K":
        this.eraseInLine(first);
        return;
      case "J":
        this.eraseInDisplay(first);
        return;
      case "s":
        this.saved = { row: this.row, col: this.col };
        return;
      case "u":
        this.restore();
        return;
      default:
        // SGR (`m`) and everything else: no effect on the text.
        return;
    }
  }

  private up(count: number): void {
    this.row = Math.max(0, this.row - count);
  }

  private down(count: number): void {
    this.row = Math.min(this.lines.length - 1, this.row + count);
  }

  private restore(): void {
    if (!this.saved) return;
    this.row = Math.min(this.saved.row, this.lines.length - 1);
    this.col = this.saved.col;
  }

  private eraseInLine(mode: number): void {
    const line = this.lines[this.row]!;
    if (mode === 2) {
      this.lines[this.row] = [];
    } else if (mode === 1) {
      // Erase from the start through the cursor: those cells become blank.
      const end = Math.min(this.col + 1, line.length);
      if (end >= line.length) this.lines[this.row] = [];
      else this.blank(line, end);
    } else if (line.length > this.col) {
      line.length = this.col;
    }
  }

  private eraseInDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.lines = [[]];
      this.clearedAbove = 0;
      this.row = 0;
      this.saved = null;
      return;
    }
    if (mode === 1) {
      // Skip the already-cleared prefix. Rewrites can invalidate it, so also
      // charge traversal against the budget rather than repeatedly scanning
      // many empty rows after a write near the start of the buffer.
      const rows = Math.min(Math.max(0, this.row - this.clearedAbove), this.budget);
      const end = this.clearedAbove + rows;
      this.budget -= rows;
      for (; this.clearedAbove < end; this.clearedAbove += 1) {
        this.lines[this.clearedAbove] = [];
      }
      this.eraseInLine(1);
      return;
    }
    this.lines.length = this.row + 1;
    this.clearedAbove = Math.min(this.clearedAbove, this.lines.length);
    this.eraseInLine(0);
  }

  /** Blank `count` leading cells, within budget. */
  private blank(line: string[], count: number): void {
    const cells = Math.min(count, this.budget);
    this.budget -= cells;
    for (let index = 0; index < cells; index += 1) line[index] = " ";
  }

  /** Write one character at the cursor, overwriting, and advance. */
  private put(char: string): void {
    this.clearedAbove = Math.min(this.clearedAbove, this.row);
    const line = this.lines[this.row]!;
    if (this.col > line.length) {
      // A forward move past the end: pad with spaces, within budget.
      const gap = Math.min(this.col - line.length, this.budget);
      this.budget -= gap;
      for (let index = 0; index < gap; index += 1) line.push(" ");
      this.col = line.length;
    }
    if (this.col === line.length) line.push(char);
    else line[this.col] = char;
    this.col += 1;
  }
}

/** Apply `raw` terminal output to an empty buffer and return its text. */
export function normalizeTerminalText(raw: string): string {
  const buffer = new TerminalTextBuffer();
  buffer.write(raw);
  return buffer.toString();
}
