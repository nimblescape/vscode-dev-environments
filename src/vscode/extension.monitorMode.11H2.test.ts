// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11H2 (decision of 2026-10-09, D1 and D2): extension.ts gives the Session Monitor of an engine the schedule of
// its background run (cacheUpdateSchedule) and its mode: permanent on a remote engine (an open whose Docker host is not
// the local one, a repair of a remote target), on a local one only with stopLocalMonitorWhenIdle off.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

describe('the monitor settings of extension.ts (plan step 11H2)', () => {
  const source = fs.readFileSync(path.join(__dirname, 'extension.ts'), 'utf8');

  it('the schedule of cacheUpdateSchedule and the mode by the engine and stopLocalMonitorWhenIdle', () => {
    expect(source).toContain('schedule: getSettings().cacheUpdateSchedule ?? DEFAULT_CACHE_UPDATE_SCHEDULE,');
    expect(source).toContain('permanent: monitorRunsPermanently(remote, getSettings().stopLocalMonitorWhenIdle),');
    expect(source).not.toContain('imageUpdateSchedule ??');
  });

  it('an open of a remote Docker host and the repair of a remote target ask for a permanent monitor', () => {
    expect(source).toContain("openMonitor: (dockerHost) => ({ images: imageMaintenance(dockerHost !== ''), ...imageListFor(dockerHost) }),");
    expect(source).toContain("monitorCalls.monitorEnsure(target, imageMaintenance(target.kind === 'remote'), signal)");
  });
});
