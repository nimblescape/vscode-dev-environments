// The Docker configuration of the test run (implementation notes 2): the tests never use credentials of the user. A
// configuration without auths, credsStore, and credHelpers is not enough: the Docker CLI and buildx then use the default
// credential helper of the platform, if it is on PATH. This test puts fake helpers first on PATH that record each call.
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { DockerCli } from './dockerRun';
import { dockerTestContext } from './harness';

/** The default credential helpers of the Docker CLI on macOS and Linux (`pass` when the `pass` program exists). */
const DEFAULT_HELPERS = ['osxkeychain', 'pass', 'secretservice'];

describe('Docker configuration of the tests', () => {
  const { run, env, log } = dockerTestContext('dockerConfig');

  // The fake helpers are shell scripts: the check covers macOS and Linux (on Windows, wincred would need a program).
  it('never asks a credential helper of the user, not even the default one of the platform', () => {
    const bin = path.join(run.runDir, 'credential-probe');
    const calls = path.join(bin, 'calls.log');
    fs.mkdirSync(bin, { recursive: true });
    for (const name of DEFAULT_HELPERS) {
      const script = `#!/bin/sh\necho "${name} $*" >> '${calls}'\ncat > /dev/null\necho 'credentials not found in native keychain'\nexit 1\n`;
      fs.writeFileSync(path.join(bin, `docker-credential-${name}`), script, { mode: 0o755 });
    }
    const probe = new DockerCli(run.dockerPath, { ...env, PATH: `${bin}${path.delimiter}${env.PATH ?? ''}` });
    // A registry that does not exist: the CLI looks up the credentials for it, then the pull fails at the name resolution.
    const result = probe.run(['pull', 'devenv-credential-probe.invalid/probe:1']);
    log.info(`docker pull of the probe: exit code ${result.code}: ${result.err}`);
    expect(result.code).not.toBe(0);
    expect(fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '').toBe('');
  });
});
