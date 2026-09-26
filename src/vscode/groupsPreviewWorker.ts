// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Worker thread of the repository groups editor (bundle dist/groupsPreviewWorker.js): runs the regular expressions of
// the draft for the preview and the test field, so a slow one cannot stop the extension host. groupsPreviewRunner.ts
// stops the worker after the time limit. No `vscode` import.
import { parentPort } from 'worker_threads';
import { runPreviewJob, type PreviewJob } from './repositoryGroupsEditorModel';

parentPort?.on('message', (job: PreviewJob) => {
  runPreviewJob(job, (message) => parentPort?.postMessage(message));
});
