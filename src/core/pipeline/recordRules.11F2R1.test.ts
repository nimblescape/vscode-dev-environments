// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Review 11F2 R1 (mutation testing): composeRecordOf rejects an empty service also when every other field is valid (the
// case "an empty service" of pipelineRules.test.ts lacks other fields too, so it held without the check of the service).
import { describe, expect, it } from 'vitest';
import { composeRecordOf } from './recordRules';

const record = { builtAt: '', environmentImage: 'devenv-3f2a9c1e:1', buildNumber: 1, configPath: 'c', configHash: 'h', images: {}, features: {} };
const valid = { service: 'app', images: ['devenv-3f2a9c1e-app'], serviceImages: ['postgres:16'], version: '2.40.3', inputsHash: 'sha256:x' };

describe('composeRecordOf (review 11F2 R1)', () => {
  it('rejects an empty service in an otherwise valid record', () => {
    expect(composeRecordOf({ ...record, compose: valid } as never)).toEqual(valid);
    expect(composeRecordOf({ ...record, compose: { ...valid, service: '' } } as never)).toBeUndefined();
  });
});
