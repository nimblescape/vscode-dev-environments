// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Log file of the Session Monitor process (monitor.log). The process has no output channel and no console (it runs
// detached with stdio 'ignore'), so this file is the only trace of its decisions. Writes are synchronous: they are short,
// keep their order, and are not lost when the process ends.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from '../core/errors';
import { systemClock, type Clock, type Logger } from '../core/ports';

/** When the file grows above this size, it is cut to its newer half. */
export const MONITOR_LOG_MAX_BYTES = 1_000_000;
const STAT_EVERY_APPENDS = 64;

export interface FileLoggerOptions {
  /** Default: MONITOR_LOG_MAX_BYTES. */
  maxBytes?: number;
  clock?: Clock;
  /** Process ID in each line. Default: `process.pid`. */
  pid?: number;
}

/** Appends lines `<ISO time> [<pid>] <LEVEL> <message>` to a file. Never throws. */
export class FileLogger implements Logger {
  private readonly maxBytes: number;
  private readonly clock: Clock;
  private readonly pid: number;
  /** Size of the file as far as this process knows it (other processes may append too). */
  private size: number;
  private appendsSinceStat = 0;

  constructor(
    readonly file: string,
    options: FileLoggerOptions = {},
  ) {
    this.maxBytes = Math.max(1024, options.maxBytes ?? MONITOR_LOG_MAX_BYTES);
    this.clock = options.clock ?? systemClock;
    this.pid = options.pid ?? process.pid;
    this.size = fileSize(file) ?? 0;
  }

  info(message: string): void {
    this.line('INFO', message);
  }

  warn(message: string): void {
    this.line('WARN', message);
  }

  error(message: string, error?: unknown): void {
    this.line('ERROR', error === undefined ? message : `${message} ${describeError(error)}`);
  }

  output(text: string): void {
    this.append(text.endsWith('\n') ? text : `${text}\n`);
  }

  private line(level: string, message: string): void {
    const time = new Date(this.clock.now()).toISOString();
    // One entry per line, so that the file stays readable when a message contains line breaks (tool output).
    this.append(`${time} [${this.pid}] ${level} ${message.replace(/\r?\n/g, '\n    ')}\n`);
  }

  private append(text: string): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, text, 'utf8');
      this.size += Buffer.byteLength(text, 'utf8');
      // Now and then measure the file: a second monitor process (rare) may append too.
      if (++this.appendsSinceStat >= STAT_EVERY_APPENDS) {
        this.appendsSinceStat = 0;
        this.size = fileSize(this.file) ?? this.size;
      }
      if (this.size > this.maxBytes) this.truncate();
    } catch {
      // A log that cannot be written must not stop the monitor.
    }
  }

  /** Keeps the newer half of the file, starting at a line start. Atomic: temporary file, then rename. */
  private truncate(): void {
    const actual = fileSize(this.file);
    if (actual === undefined) {
      this.size = 0;
      return;
    }
    this.size = actual;
    if (actual <= this.maxBytes) return;
    const content = fs.readFileSync(this.file);
    let start = content.length - Math.floor(this.maxBytes / 2);
    const lineEnd = content.indexOf(0x0a, start);
    start = lineEnd >= 0 ? lineEnd + 1 : start;
    const kept = content.subarray(start);
    const temp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, kept);
      fs.renameSync(temp, this.file);
      this.size = kept.length;
    } catch {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Ignore.
      }
    }
  }
}

function fileSize(file: string): number | undefined {
  try {
    return fs.statSync(file).size;
  } catch {
    return undefined;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.stack) return error.stack;
  return errorMessage(error);
}
