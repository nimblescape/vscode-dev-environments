// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.
// Review round 2 of PR #126 (reviewer B), mutation probes of the `never` fields of ScriptEntry
// (src/core/worker/containerScripts.ts, review round 1 of PR #126, F3): the test of F3 gives object literals only, which
// the check of excess properties refuses with either `never` field alone (the union is then discriminated), so removing
// one of the two fields keeps tsc green (mutants T2: the script kind without `plainInput?: never`; T3: the command kind
// without `secretInputName?: never`). A value that is not a fresh literal (an entry built first and then put in the
// registry or typed as an entry) has no check of excess properties: only the field of its own kind refuses it. Such an
// entry with both would make runScript pass both, and the exec of the port writes the secret in place of the plain input
// (execInContainer of src/helperChannel/engineClient.ts: the secret wins). The checks are made by tsc (`npm run
// typecheck`, before the unit tests in CI): each `@ts-expect-error` fails tsc when the type accepts the value.
import { describe, expect, it } from 'vitest';
import { SECRET_TOKEN } from '../helperChannel/protocol';
import { CONTAINER_SCRIPTS, type ScriptEntry } from './containerScripts';

describe('ScriptEntry keeps a plain input and a secret apart also for a value that is no fresh literal (review round 2 of PR #126, B)', () => {
  // Kills T3 (the command kind without `secretInputName?: never`): a program of the container with the secret.
  it('refuses a command entry with the secret, built before it is typed (T3)', () => {
    const built = { command: ['cat'], plainInput: true, secretInputName: SECRET_TOKEN } as const;
    // @ts-expect-error: a program of the container takes no secret, also when the entry is not a fresh literal
    const entry: ScriptEntry = built;
    expect('command' in entry && 'secretInputName' in entry).toBe(true);
  });

  // Kills T2 (the script kind without `plainInput?: never`): a script with a plain input.
  it('refuses a script entry with a plain input, built before it is typed (T2)', () => {
    const built = { program: 'sh', script: 'cat', secretInputName: SECRET_TOKEN, plainInput: true } as const;
    // @ts-expect-error: a script takes no plain input, also when the entry is not a fresh literal
    const entry: ScriptEntry = built;
    expect('script' in entry && 'plainInput' in entry).toBe(true);
  });

  // The same for a registry whose entries are built before it (as `CONTAINER_SCRIPTS` is checked: `satisfies`); each kind
  // alone stays an entry.
  it('refuses such entries in a registry checked as CONTAINER_SCRIPTS is (T2, T3)', () => {
    const commandWithSecret = { command: ['cat'], plainInput: true, secretInputName: SECRET_TOKEN } as const;
    // Cleanup after plan step 11 (PR C1): `program: 'sh'` (the unused kind 'node' is removed), so the only error is the input.
    const scriptWithInput = { program: 'sh', script: 'x', plainInput: true } as const;
    const plain = { command: ['cat'], plainInput: true } as const;
    const secret = { program: 'sh', script: 'cat', secretInputName: SECRET_TOKEN } as const;
    // @ts-expect-error: the command entry with a secret
    const withSecret = { commandWithSecret } as const satisfies Record<string, ScriptEntry>;
    // @ts-expect-error: the script entry with a plain input
    const withInput = { scriptWithInput } as const satisfies Record<string, ScriptEntry>;
    const valid = { plain, secret } as const satisfies Record<string, ScriptEntry>;
    expect(Object.keys({ ...withSecret, ...withInput, ...valid })).toEqual(['commandWithSecret', 'scriptWithInput', 'plain', 'secret']);
    // The registry itself: no entry has both.
    for (const entry of Object.values(CONTAINER_SCRIPTS) as ScriptEntry[]) expect('plainInput' in entry && 'secretInputName' in entry).toBe(false);
  });
});
