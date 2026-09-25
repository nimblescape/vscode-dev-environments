// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Logger on the output channel "Dev Environments" (NFR-02: technical logs only on request, implementation notes 13).
import * as vscode from 'vscode';
import { CommandError, isUserFacingError } from '../core/errors';
import type { Logger } from '../core/ports';

/** Name of the output channel. */
export const OUTPUT_CHANNEL_NAME = 'Dev Environments';

// Security (concept section 9): a GitHub token must never reach the log, also not through the output of a tool.
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/** Replaces GitHub tokens in a text. */
export function redactSecrets(text: string): string {
  return text.replace(TOKEN_PATTERN, '***');
}

/**
 * Lines have the form `[HH:MM:SS] info|warn|error message`. `output(text)` appends the raw output of a tool as it is.
 */
export class OutputChannelLogger implements Logger, vscode.Disposable {
  readonly channel: vscode.OutputChannel;
  private disposed = false;
  /** False while the last raw output did not end with a line break. */
  private atLineStart = true;

  constructor(name: string = OUTPUT_CHANNEL_NAME) {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string): void {
    this.line('info', message);
  }

  warn(message: string): void {
    this.line('warn', message);
  }

  error(message: string, error?: unknown): void {
    const details = error === undefined ? '' : describeError(error);
    let text = message;
    if (details !== '' && details !== message) text = details.startsWith(`${message}\n`) ? details : `${message}\n${details}`;
    this.line('error', text);
  }

  output(text: string): void {
    if (this.disposed || text === '') return;
    this.channel.append(redactSecrets(text));
    this.atLineStart = /[\r\n]$/.test(text);
  }

  show(): void {
    if (!this.disposed) this.channel.show(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.channel.dispose();
  }

  private line(level: 'info' | 'warn' | 'error', message: string): void {
    if (this.disposed) return;
    // A log line never continues a line of tool output that has no line break at its end.
    const prefix = this.atLineStart ? '' : '\n';
    this.channel.appendLine(`${prefix}[${clockTime(new Date())}] ${level} ${redactSecrets(message)}`);
    this.atLineStart = true;
  }
}

function clockTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Technical details of an error for the log: the detail of a UserFacingError, the output of a command, or the stack. */
function describeError(error: unknown): string {
  if (isUserFacingError(error)) {
    return error.detail ? `${error.message}\n${error.detail}` : error.message;
  }
  if (error instanceof CommandError) {
    const output = (error.stderr || error.stdout).trim();
    return output ? `${error.command} failed with exit code ${error.exitCode}:\n${output.slice(-8000)}` : error.message;
  }
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}
