// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it, vi } from 'vitest';
import { findDockerCli } from '../core/docker/dockerCli';
import { dockerAdapterOptions } from './dockerAdapterOptions';

/** A Docker setup with the methods that look the CLI up, so that a wiring that calls them fails the tests. */
function fakeSetup() {
  return {
    reportCliLost: vi.fn(),
    reportDaemonStatus: vi.fn(),
    checkCli: vi.fn(() => false),
    show: vi.fn(async () => {}),
    initialize: vi.fn(),
  };
}

describe('dockerAdapterOptions (the ContainerAdapter options of extension.ts, review round 3, W3-2)', () => {
  it('reports a lost CLI with reportCliLost and looks nothing up', () => {
    const setup = fakeSetup();
    const options = dockerAdapterOptions(() => setup);
    expect(options.onCliLost).toBeTypeOf('function');
    options.onCliLost?.();
    expect(setup.reportCliLost).toHaveBeenCalledTimes(1);
    expect(setup.checkCli).not.toHaveBeenCalled();
    expect(setup.show).not.toHaveBeenCalled();
    expect(setup.initialize).not.toHaveBeenCalled();
  });

  it('reports each docker info with reportDaemonStatus', () => {
    const setup = fakeSetup();
    const options = dockerAdapterOptions(() => setup);
    options.onDaemonStatus?.(true);
    options.onDaemonStatus?.(false);
    expect(setup.reportDaemonStatus.mock.calls).toEqual([[true], [false]]);
    expect(setup.checkCli).not.toHaveBeenCalled();
  });

  it('looks a missing CLI up again with findDockerCli', () => {
    expect(dockerAdapterOptions(() => undefined).findDocker).toBe(findDockerCli);
  });

  it('drops reports before the Docker setup exists, and reaches it once it does', () => {
    let setup: ReturnType<typeof fakeSetup> | undefined;
    const options = dockerAdapterOptions(() => setup);
    expect(() => options.onCliLost?.()).not.toThrow();
    expect(() => options.onDaemonStatus?.(true)).not.toThrow();
    setup = fakeSetup();
    options.onCliLost?.();
    expect(setup.reportCliLost).toHaveBeenCalledTimes(1);
  });
});
