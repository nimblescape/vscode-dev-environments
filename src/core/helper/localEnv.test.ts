import { describe, expect, it } from 'vitest';
import { HELPER_ENV_NAMES, findLocalEnvNames, helperEnvNames } from './localEnv';

describe('findLocalEnvNames', () => {
  it('finds names with and without default, in order, without duplicates', () => {
    const text = `{
  "containerEnv": {
    "A": "\${localEnv:HOME}/x",
    "B": "\${localEnv:GITHUB_USER:nobody}",
    "C": "\${localEnv:HOME}",
    "D": "\${env:PROXY}",
    "E": "\${localEnv:WITH_EMPTY_DEFAULT:}"
  },
  "mounts": ["source=\${localEnv:HOME}\${localEnv:USERPROFILE}/.ssh,target=/root/.ssh,type=bind"]
}`;
    expect(findLocalEnvNames(text)).toEqual(['HOME', 'GITHUB_USER', 'PROXY', 'WITH_EMPTY_DEFAULT', 'USERPROFILE']);
  });

  it('ignores other variables and variables in comments', () => {
    const text = `{
  // "x": "\${localEnv:SECRET_IN_COMMENT}",
  /* \${localEnv:BLOCK_COMMENT} */
  "workspaceFolder": "/workspaces/\${localWorkspaceFolderBasename}",
  "y": "\${containerEnv:PATH}:\${devcontainerId}",
  "z": "https://example.com/a//b \${localEnv:KEPT}"
}`;
    expect(findLocalEnvNames(text)).toEqual(['KEPT']);
  });

  it('returns an empty list for text without variables', () => {
    expect(findLocalEnvNames('{ "image": "node:22" }')).toEqual([]);
    expect(findLocalEnvNames('${localEnv:}')).toEqual([]);
  });
});

describe('helperEnvNames', () => {
  it('returns the names that the workspace helper sets itself, in their order', () => {
    expect(helperEnvNames(['GITHUB_USER', 'PATH', 'HOME', 'USERPROFILE'])).toEqual(['PATH', 'HOME']);
    expect(helperEnvNames(['GITHUB_USER'])).toEqual([]);
    expect(HELPER_ENV_NAMES).toContain('HOME');
  });
});
