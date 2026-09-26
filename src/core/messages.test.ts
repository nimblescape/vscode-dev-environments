// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import { Messages } from './messages';

describe('Messages.localEnvNotPassed', () => {
  // The CLI resolves ${localEnv:NAME} in the workspace helper: HOME is /root there, not empty.
  it('does not say that every variable is empty', () => {
    const text = Messages.localEnvNotPassed('HOME, FOO');
    expect(text).toContain('HOME, FOO');
    expect(text).toContain('HOME is /root');
    expect(text).not.toMatch(/so they are empty/);
  });

  it('names the variables that get the values of the workspace helper', () => {
    const text = Messages.localEnvNotPassed('HOME, FOO', 'HOME');
    expect(text).toContain('The workspace helper sets HOME to its own values');
    expect(text).toContain('The others are empty or have their default value');
  });
});

describe('Messages.olderEnvironmentNotAssigned', () => {
  // Concept 7.5: nobody owns such an entry yet, so the text must not say "another account".
  it('does not name another account', () => {
    const text = Messages.olderEnvironmentNotAssigned('acme/api');
    expect(text).toContain('acme/api');
    expect(text).not.toMatch(/another/i);
  });
});

describe('Messages.containerComposeReplaced (review round 1 of unit 6, P-1)', () => {
  // The containers of the other services are removed: their volumes without a name are left behind, not kept in use.
  it('does not claim that all data of the services is kept', () => {
    const text = Messages.containerComposeReplaced;
    expect(text).not.toMatch(/data of the services are kept/);
    expect(text).toContain('named volumes are kept');
    expect(text).toContain('volumes without a name is no longer used');
  });

  it('says that files outside the repository are removed when a single container becomes Docker Compose', () => {
    expect(Messages.containerComposeCreated).toContain('Files in other folders of the container');
  });
});
