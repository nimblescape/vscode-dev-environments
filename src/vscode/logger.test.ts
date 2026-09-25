import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { CommandError, UserFacingError } from '../core/errors';
import { OUTPUT_CHANNEL_NAME, OutputChannelLogger, redactSecrets } from './logger';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

describe('OutputChannelLogger', () => {
  beforeEach(() => resetFakeVscode());

  it('writes timestamped lines to the output channel "Dev Environments"', () => {
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    expect(channel.name).toBe(OUTPUT_CHANNEL_NAME);
    expect(OUTPUT_CHANNEL_NAME).toBe('Dev Environments');
    logger.info('Step: Starting Docker');
    logger.warn('careful');
    expect(channel.text).toMatch(/^\[\d\d:\d\d:\d\d\] info Step: Starting Docker\n\[\d\d:\d\d:\d\d\] warn careful\n$/);
  });

  it('appends tool output as it is, and starts a log line on a new line', () => {
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    logger.output('Step 1/3 : FROM ubuntu');
    logger.info('next');
    logger.output('done\n');
    logger.info('after');
    expect(channel.text).toMatch(/^Step 1\/3 : FROM ubuntu\n\[[\d:]+\] info next\ndone\n\[[\d:]+\] info after\n$/);
  });

  it('logs the technical details of an error', () => {
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    logger.error('The environment could not be prepared.', new UserFacingError('buildFailed', 'The environment could not be prepared.', 'exit 1'));
    logger.error('failed', new CommandError('docker build', 1, '', 'no space left on device'));
    expect(channel.text).toContain('error The environment could not be prepared.\nexit 1\n');
    expect(channel.text).toContain('error failed\ndocker build failed with exit code 1:\nno space left on device\n');
  });

  it('never writes a GitHub token', () => {
    const token = `gho_${'a1B2'.repeat(9)}`;
    const pat = `github_pat_${'x'.repeat(30)}`;
    expect(redactSecrets(`Authorization: bearer ${token} and ${pat}`)).toBe('Authorization: bearer *** and ***');
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    logger.output(`remote: ${token}\n`);
    logger.info(`token ${token}`);
    expect(channel.text).not.toContain(token);
  });

  it('shows the channel for Show details and stops writing after dispose', () => {
    const logger = new OutputChannelLogger();
    const channel = fakeVscode.outputChannels[0];
    logger.show();
    expect(channel.shown).toBe(1);
    logger.dispose();
    logger.info('late');
    logger.show();
    expect(channel.disposed).toBe(true);
    expect(channel.text).toBe('');
    expect(channel.shown).toBe(1);
  });
});
