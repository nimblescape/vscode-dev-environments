import { describe, expect, it } from 'vitest';
import { findLocalEnvNames, localEnvValues } from './localEnv';

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

describe('localEnvValues', () => {
  it('returns only defined values, also empty strings', () => {
    expect(localEnvValues(['HOME', 'MISSING', 'EMPTY'], { HOME: '/Users/me', EMPTY: '' }, 'darwin')).toEqual({
      HOME: '/Users/me',
      EMPTY: '',
    });
  });

  it('looks names up case-insensitively on Windows only', () => {
    const env = { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' };
    expect(localEnvValues(['PATH', 'userprofile'], env, 'win32')).toEqual({ PATH: 'C:\\Windows', userprofile: 'C:\\Users\\me' });
    expect(localEnvValues(['PATH', 'userprofile'], env, 'linux')).toEqual({});
  });
});
