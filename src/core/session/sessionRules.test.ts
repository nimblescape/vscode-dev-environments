// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 8, PR A: the session helpers that moved from src/monitor to src/core/session.
import { describe, expect, it } from 'vitest';
import { isProcessAlive as monitorIsProcessAlive } from '../../monitor/lock';
import { keptWhenClosed as monitorKeptWhenClosed, remoteStopAfterSeconds } from '../../monitor/rules';
import { isProcessAlive, keepFlagsOf, keptWhenClosed, stopAfterSeconds } from './sessionRules';

describe('sessionRules (plan step 8, PR A)', () => {
  it('stopAfterSeconds clamps to one minute..one day and gives 10 minutes for a value that is no number', () => {
    expect(stopAfterSeconds(10)).toBe(600);
    expect(stopAfterSeconds(1.5)).toBe(90);
    expect(stopAfterSeconds(0)).toBe(60);
    expect(stopAfterSeconds(5000)).toBe(86_400);
    expect(stopAfterSeconds(undefined)).toBe(600);
    expect(stopAfterSeconds(Number.NaN)).toBe(600);
    // The monitor keeps the old name until it is removed (PR C).
    expect(remoteStopAfterSeconds).toBe(stopAfterSeconds);
  });

  it('keptWhenClosed follows Keep Running, Close and Keep Running, stopOnClose and a respected shutdownAction none', () => {
    const settings = { stopOnClose: true, respectShutdownActionNone: false };
    expect(keptWhenClosed(keepFlagsOf({}), settings)).toBe(false);
    expect(keptWhenClosed(keepFlagsOf({ keepRunning: true }), settings)).toBe(true);
    expect(keptWhenClosed(keepFlagsOf({ keepRunningOnce: true }), settings)).toBe(true);
    expect(keptWhenClosed(keepFlagsOf({ shutdownActionNone: true }), settings)).toBe(false);
    expect(keptWhenClosed(keepFlagsOf({ shutdownActionNone: true }), { ...settings, respectShutdownActionNone: true })).toBe(true);
    expect(keptWhenClosed(keepFlagsOf({}), { ...settings, stopOnClose: false })).toBe(true);
    // Anything but an explicit false keeps the default (stop).
    expect(keptWhenClosed(keepFlagsOf({}), {})).toBe(false);
    // The monitor's rule is the same.
    const monitorSettings = { waitingTimeSeconds: 30, stopOnClose: true, respectShutdownActionNone: true, updatedAt: '' };
    expect(monitorKeptWhenClosed({ id: 'x', busy: false, keepRunning: false, shutdownActionNone: true }, monitorSettings)).toBe(true);
  });

  it('isProcessAlive: this process lives, invalid IDs do not; the monitor re-exports it', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
    expect(isProcessAlive(0x80000000)).toBe(false);
    expect(monitorIsProcessAlive).toBe(isProcessAlive);
  });
});
