// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { describe, expect, it } from 'vitest';
import {
  BREW_INSTALL_COMMAND,
  DOCKER_DESKTOP_DOCS_URL,
  DOCKER_DESKTOP_DOWNLOADS,
  DOCKER_ENGINE_INSTALL_URL,
  DockerContextKeys,
  DockerSetupTexts,
  INITIAL_DOCKER_SETUP_STATE,
  INSTALL_WATCH_TIMEOUT_MS,
  WINGET_INSTALL_COMMAND,
  changedContextValues,
  dockerContextValues,
  dockerDesktopDownloadUrl,
  hardwareArch,
  installConfirmation,
  installPlan,
  isOfficialDownloadUrl,
  keepWatchingInstall,
  needsMissingCliCheck,
  nextDockerSetupState,
  parseOsRelease,
  terminalConfirmation,
  terminalLines,
  type DockerSetupEvent,
  type DockerSetupState,
  type InstallPlan,
  type SetupTool,
} from './dockerSetup';

const tools =
  (...present: SetupTool[]) =>
  (tool: SetupTool) =>
    present.includes(tool);

const PACKAGES = 'docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin';
const GROUP = 'sudo usermod -aG docker $USER';

function aptCommands(id: 'ubuntu' | 'debian', codename: string, architecture: string): string[] {
  const base = `https://download.docker.com/linux/${id}`;
  return [
    'sudo apt update',
    'sudo apt install ca-certificates curl',
    'sudo install -m 0755 -d /etc/apt/keyrings',
    `sudo curl -fsSL ${base}/gpg -o /etc/apt/keyrings/docker.asc`,
    'sudo chmod a+r /etc/apt/keyrings/docker.asc',
    `printf 'Types: deb\\nURIs: ${base}\\nSuites: ${codename}\\nComponents: stable\\nArchitectures: ${architecture}\\nSigned-By: /etc/apt/keyrings/docker.asc\\n' | sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null`,
    'sudo apt update',
    `sudo apt install ${PACKAGES}`,
    GROUP,
  ];
}

describe('installPlan on macOS and Windows', () => {
  it.each<[string, NodeJS.Platform, string, SetupTool[], InstallPlan]>([
    [
      'macOS with Homebrew (Apple silicon)',
      'darwin',
      'arm64',
      ['brew'],
      { kind: 'terminal', commands: [BREW_INSTALL_COMMAND], needsAdmin: true, description: DockerSetupTexts.descriptionBrew },
    ],
    [
      'macOS with Homebrew (Intel)',
      'darwin',
      'x64',
      ['brew'],
      { kind: 'terminal', commands: [BREW_INSTALL_COMMAND], needsAdmin: true, description: DockerSetupTexts.descriptionBrew },
    ],
    [
      'macOS without Homebrew (Apple silicon)',
      'darwin',
      'arm64',
      [],
      { kind: 'download', url: DOCKER_DESKTOP_DOWNLOADS.macArm64, fileName: 'Docker.dmg', open: 'dmg' },
    ],
    [
      'macOS without Homebrew (Intel)',
      'darwin',
      'x64',
      [],
      { kind: 'download', url: DOCKER_DESKTOP_DOWNLOADS.macAmd64, fileName: 'Docker.dmg', open: 'dmg' },
    ],
    ['macOS: winget does not count', 'darwin', 'arm64', ['winget'], { kind: 'download', url: DOCKER_DESKTOP_DOWNLOADS.macArm64, fileName: 'Docker.dmg', open: 'dmg' }],
    ['macOS without Homebrew, unknown architecture', 'darwin', 'ia32', [], { kind: 'manual', url: DOCKER_DESKTOP_DOCS_URL }],
    [
      'Windows with winget (x64)',
      'win32',
      'x64',
      ['winget'],
      { kind: 'terminal', commands: [WINGET_INSTALL_COMMAND], needsAdmin: true, description: DockerSetupTexts.descriptionWinget },
    ],
    [
      'Windows with winget (Arm)',
      'win32',
      'arm64',
      ['winget'],
      { kind: 'terminal', commands: [WINGET_INSTALL_COMMAND], needsAdmin: true, description: DockerSetupTexts.descriptionWinget },
    ],
    [
      'Windows without winget (x64)',
      'win32',
      'x64',
      [],
      { kind: 'download', url: DOCKER_DESKTOP_DOWNLOADS.windowsAmd64, fileName: 'Docker Desktop Installer.exe', open: 'exe' },
    ],
    [
      'Windows without winget (Arm)',
      'win32',
      'arm64',
      [],
      { kind: 'download', url: DOCKER_DESKTOP_DOWNLOADS.windowsArm64, fileName: 'Docker Desktop Installer.exe', open: 'exe' },
    ],
    [
      'Windows: Homebrew does not count',
      'win32',
      'x64',
      ['brew'],
      { kind: 'download', url: DOCKER_DESKTOP_DOWNLOADS.windowsAmd64, fileName: 'Docker Desktop Installer.exe', open: 'exe' },
    ],
    ['Windows without winget, 32-bit', 'win32', 'ia32', [], { kind: 'manual', url: DOCKER_DESKTOP_DOCS_URL }],
    ['another platform', 'freebsd', 'x64', ['brew', 'winget'], { kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL }],
  ])('%s', (_name, platform, arch, present, expected) => {
    expect(installPlan({ platform, arch, has: tools(...present) })).toEqual(expected);
  });

  it('uses the renamed cask docker-desktop and the exact winget package', () => {
    expect(BREW_INSTALL_COMMAND).toBe('brew install --cask docker-desktop');
    expect(WINGET_INSTALL_COMMAND).toBe(
      'winget install --exact --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements',
    );
  });
});

describe('installPlan on Linux', () => {
  const engine = (distribution: string, commands: string[]): InstallPlan => ({
    kind: 'terminal',
    commands,
    needsAdmin: true,
    description: DockerSetupTexts.descriptionEngine(distribution),
    note: DockerSetupTexts.linuxGroupNote,
  });
  const dnf = (id: 'rhel' | 'centos') => [
    'sudo dnf -y install dnf-plugins-core',
    `sudo dnf config-manager --add-repo https://download.docker.com/linux/${id}/docker-ce.repo`,
    `sudo dnf install ${PACKAGES}`,
    GROUP,
  ];
  const fedoraRepo = 'https://download.docker.com/linux/fedora/docker-ce.repo';

  it.each<[string, string, Record<string, string>, InstallPlan]>([
    [
      'Ubuntu (UBUNTU_CODENAME wins)',
      'x64',
      { ID: 'ubuntu', VERSION_CODENAME: 'other', UBUNTU_CODENAME: 'noble' },
      engine('Ubuntu', aptCommands('ubuntu', 'noble', 'amd64')),
    ],
    ['Ubuntu with VERSION_CODENAME only', 'arm64', { ID: 'ubuntu', VERSION_CODENAME: 'jammy' }, engine('Ubuntu', aptCommands('ubuntu', 'jammy', 'arm64'))],
    ['Ubuntu on armhf', 'arm', { ID: 'ubuntu', VERSION_CODENAME: 'noble' }, engine('Ubuntu', aptCommands('ubuntu', 'noble', 'armhf'))],
    ['Ubuntu on ppc64el', 'ppc64', { ID: 'ubuntu', VERSION_CODENAME: 'noble' }, engine('Ubuntu', aptCommands('ubuntu', 'noble', 'ppc64el'))],
    ['Ubuntu on s390x', 's390x', { ID: 'ubuntu', VERSION_CODENAME: 'noble' }, engine('Ubuntu', aptCommands('ubuntu', 'noble', 's390x'))],
    ['Ubuntu without codename', 'x64', { ID: 'ubuntu' }, { kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL }],
    ['Ubuntu on an unknown architecture', 'riscv64', { ID: 'ubuntu', VERSION_CODENAME: 'noble' }, { kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL }],
    ['Ubuntu with a codename that is not a plain word', 'x64', { ID: 'ubuntu', VERSION_CODENAME: 'x; rm -rf /' }, { kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL }],
    ['Debian', 'x64', { ID: 'debian', VERSION_CODENAME: 'bookworm' }, engine('Debian', aptCommands('debian', 'bookworm', 'amd64'))],
    ['Debian ignores UBUNTU_CODENAME', 'x64', { ID: 'debian', VERSION_CODENAME: 'trixie', UBUNTU_CODENAME: 'noble' }, engine('Debian', aptCommands('debian', 'trixie', 'amd64'))],
    ['Debian without codename (testing)', 'x64', { ID: 'debian' }, { kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL }],
    [
      'Fedora 41 and later (DNF 5)',
      'x64',
      { ID: 'fedora', VERSION_ID: '42' },
      engine('Fedora', [`sudo dnf config-manager addrepo --from-repofile ${fedoraRepo}`, `sudo dnf install ${PACKAGES}`, GROUP]),
    ],
    [
      'Fedora 41',
      'arm64',
      { ID: 'fedora', VERSION_ID: '41' },
      engine('Fedora', [`sudo dnf config-manager addrepo --from-repofile ${fedoraRepo}`, `sudo dnf install ${PACKAGES}`, GROUP]),
    ],
    [
      'Fedora 40 (DNF 4)',
      'x64',
      { ID: 'fedora', VERSION_ID: '40' },
      engine('Fedora', [
        'sudo dnf -y install dnf-plugins-core',
        `sudo dnf config-manager --add-repo ${fedoraRepo}`,
        `sudo dnf install ${PACKAGES}`,
        GROUP,
      ]),
    ],
    ['Fedora without version', 'x64', { ID: 'fedora' }, { kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL }],
    ['RHEL', 'x64', { ID: 'rhel', VERSION_ID: '9.4' }, engine('RHEL', dnf('rhel'))],
    ['CentOS Stream', 'x64', { ID: 'centos', VERSION_ID: '9' }, engine('CentOS', dnf('centos'))],
    ['ID in capitals', 'x64', { ID: 'Ubuntu', VERSION_CODENAME: 'noble' }, engine('Ubuntu', aptCommands('ubuntu', 'noble', 'amd64'))],
    ['Linux Mint (another distribution)', 'x64', { ID: 'linuxmint', ID_LIKE: 'ubuntu', UBUNTU_CODENAME: 'noble' }, { kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL }],
    ['Arch Linux', 'x64', { ID: 'arch' }, { kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL }],
    ['no /etc/os-release', 'x64', {}, { kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL }],
  ])('%s', (_name, arch, osRelease, expected) => {
    expect(installPlan({ platform: 'linux', arch, osRelease, has: tools('brew', 'winget') })).toEqual(expected);
  });

  it('does not depend on the tools', () => {
    const osRelease = { ID: 'ubuntu', VERSION_CODENAME: 'noble' };
    expect(installPlan({ platform: 'linux', arch: 'x64', osRelease, has: tools() })).toEqual(
      installPlan({ platform: 'linux', arch: 'x64', osRelease, has: tools('brew', 'winget') }),
    );
  });

  it('downloads only from download.docker.com, over HTTPS', () => {
    for (const osRelease of <Array<Record<string, string>>>[
      { ID: 'ubuntu', VERSION_CODENAME: 'noble' },
      { ID: 'debian', VERSION_CODENAME: 'bookworm' },
      { ID: 'fedora', VERSION_ID: '42' },
      { ID: 'rhel', VERSION_ID: '9' },
      { ID: 'centos', VERSION_ID: '9' },
    ]) {
      const plan = installPlan({ platform: 'linux', arch: 'x64', osRelease, has: tools() });
      if (plan.kind !== 'terminal') throw new Error('terminal plan expected');
      const urls = plan.commands.join(' ').match(/\w+:\/\/[^\s\\']+/g) ?? [];
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url).toMatch(/^https:\/\/download\.docker\.com\/linux\//);
    }
  });
});

describe('parseOsRelease', () => {
  it('reads plain, double-quoted, and single-quoted values, and skips comments and other lines', () => {
    const content = [
      '# comment',
      'NAME="Ubuntu"',
      'ID=ubuntu',
      "VERSION_CODENAME='noble'",
      'PRETTY_NAME="Ubuntu \\"24.04\\" LTS"',
      '',
      'not a field',
      'UBUNTU_CODENAME=noble\r',
    ].join('\n');
    expect(parseOsRelease(content)).toEqual({
      NAME: 'Ubuntu',
      ID: 'ubuntu',
      VERSION_CODENAME: 'noble',
      PRETTY_NAME: 'Ubuntu "24.04" LTS',
      UBUNTU_CODENAME: 'noble',
    });
  });

  it('gives an empty object for empty content', () => {
    expect(parseOsRelease('')).toEqual({});
  });
});

describe('download links', () => {
  it.each<[NodeJS.Platform, string, string | undefined]>([
    ['darwin', 'arm64', 'https://desktop.docker.com/mac/main/arm64/Docker.dmg'],
    ['darwin', 'x64', 'https://desktop.docker.com/mac/main/amd64/Docker.dmg'],
    ['win32', 'x64', 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'],
    ['win32', 'arm64', 'https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe'],
    ['win32', 'ia32', undefined],
    ['darwin', 'ppc64', undefined],
    ['linux', 'x64', undefined],
  ])('%s %s', (platform, arch, expected) => {
    expect(dockerDesktopDownloadUrl(platform, arch)).toBe(expected);
  });

  it.each<[string, boolean]>([
    ['https://desktop.docker.com/mac/main/arm64/Docker.dmg', true],
    ['http://desktop.docker.com/mac/main/arm64/Docker.dmg', false],
    ['https://desktop.docker.com.evil.example/Docker.dmg', false],
    ['https://evil.example/desktop.docker.com/Docker.dmg', false],
    ['https://user@desktop.docker.com/Docker.dmg', true],
    ['not a url', false],
  ])('%s is an official download URL: %s', (url, expected) => {
    expect(isOfficialDownloadUrl(url)).toBe(expected);
  });

  it('lists only official links', () => {
    for (const url of Object.values(DOCKER_DESKTOP_DOWNLOADS)) expect(isOfficialDownloadUrl(url)).toBe(true);
  });
});

describe('hardwareArch', () => {
  it.each<[NodeJS.Platform, string, boolean, string]>([
    ['darwin', 'x64', true, 'arm64'],
    ['darwin', 'x64', false, 'x64'],
    ['darwin', 'arm64', false, 'arm64'],
    ['win32', 'x64', true, 'x64'],
    ['linux', 'x64', true, 'x64'],
  ])('%s %s translated=%s → %s', (platform, arch, translated, expected) => {
    expect(hardwareArch(platform, arch, translated)).toBe(expected);
  });
});

describe('terminal lines', () => {
  it.each<[NodeJS.Platform, string[], string[]]>([
    ['darwin', ['a', 'b'], ['a && b']],
    ['linux', ['a', 'b', 'c'], ['a && b && c']],
    ['linux', ['a'], ['a']],
    ['linux', [], []],
    ['win32', ['a', 'b'], ['a', 'b']],
    ['win32', ['a'], ['a']],
  ])('%s %j', (platform, commands, expected) => {
    expect(terminalLines(commands, platform)).toEqual(expected);
  });
});

describe('confirmation', () => {
  it('lists exactly the commands of a terminal plan, in order, one per line, with the password note', () => {
    const plan = installPlan({ platform: 'linux', arch: 'x64', osRelease: { ID: 'ubuntu', VERSION_CODENAME: 'noble' }, has: tools() });
    if (plan.kind !== 'terminal') throw new Error('terminal plan expected');
    const confirmation = installConfirmation(plan);
    expect(confirmation).toEqual({
      message: DockerSetupTexts.confirmInstall,
      detail: [
        plan.description,
        `${DockerSetupTexts.confirmCommands}\n\n${plan.commands.join('\n')}`,
        DockerSetupTexts.adminPassword,
        DockerSetupTexts.linuxGroupNote,
      ].join('\n\n'),
      button: DockerSetupTexts.install,
    });
    const listed = confirmation!.detail.split('\n\n')[2].split('\n');
    expect(listed).toEqual(plan.commands);
  });

  it('lists the Homebrew command', () => {
    const plan = installPlan({ platform: 'darwin', arch: 'arm64', has: tools('brew') });
    expect(installConfirmation(plan)?.detail).toBe(
      `${DockerSetupTexts.descriptionBrew}\n\n${DockerSetupTexts.confirmCommands}\n\nbrew install --cask docker-desktop\n\n${DockerSetupTexts.adminPassword}`,
    );
  });

  it('names the download URL and the target file of a download', () => {
    const mac = installPlan({ platform: 'darwin', arch: 'arm64', has: tools() });
    expect(installConfirmation(mac, '/Users/me/Downloads/Docker.dmg')).toEqual({
      message: DockerSetupTexts.confirmDownload,
      detail: `${DockerSetupTexts.downloadFrom(DOCKER_DESKTOP_DOWNLOADS.macArm64, '/Users/me/Downloads/Docker.dmg')}\n\n${DockerSetupTexts.downloadMac}`,
      button: DockerSetupTexts.download,
    });
    const windows = installPlan({ platform: 'win32', arch: 'x64', has: tools() });
    const detail = installConfirmation(windows, 'C:\\Users\\me\\Downloads\\Docker Desktop Installer.exe')?.detail ?? '';
    expect(detail).toContain(DOCKER_DESKTOP_DOWNLOADS.windowsAmd64);
    expect(detail).toContain('C:\\Users\\me\\Downloads\\Docker Desktop Installer.exe');
    expect(detail).toContain(DockerSetupTexts.downloadWindows);
  });

  it('asks nothing for a manual plan', () => {
    expect(installConfirmation({ kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL })).toBeUndefined();
  });

  it('builds the confirmation of a single command without password note', () => {
    expect(terminalConfirmation('Start?', ['x'], { needsAdmin: false, button: 'Start' })).toEqual({
      message: 'Start?',
      detail: `${DockerSetupTexts.confirmCommands}\n\nx`,
      button: 'Start',
    });
  });
});

describe('context keys', () => {
  const state = (cliFound: boolean, engineRunning: boolean, wslReady = false): DockerSetupState => ({ cliFound, engineRunning, wslReady });

  it.each<[string, DockerSetupState, DockerSetupEvent, DockerSetupState]>([
    ['the CLI is found', state(false, false), { kind: 'cli', found: true }, state(true, false)],
    ['the CLI is still missing', state(false, false), { kind: 'cli', found: false }, state(false, false)],
    ['the CLI disappears: Docker cannot run', state(true, true), { kind: 'cli', found: false }, state(false, false)],
    ['the CLI is still there: the engine state stays', state(true, true), { kind: 'cli', found: true }, state(true, true)],
    ['docker info succeeds', state(true, false), { kind: 'engine', running: true }, state(true, true)],
    ['docker info fails', state(true, true), { kind: 'engine', running: false }, state(true, false)],
    ['docker info succeeds before the CLI check', state(false, false), { kind: 'engine', running: true }, state(true, true)],
    ['docker info fails without CLI', state(false, false), { kind: 'engine', running: false }, state(false, false)],
    ['WSL is ready', state(false, false), { kind: 'wsl', ready: true }, state(false, false, true)],
    ['WSL is not ready', state(true, true, true), { kind: 'wsl', ready: false }, state(true, true, false)],
  ])('%s', (_name, before, event, after) => {
    expect(nextDockerSetupState(before, event)).toEqual(after);
  });

  it.each<[DockerSetupState, Record<string, boolean>]>([
    [state(false, false), { missing: true, installed: false, ready: false, wslReady: false }],
    [state(true, false), { missing: false, installed: true, ready: false, wslReady: false }],
    [state(true, true, true), { missing: false, installed: true, ready: true, wslReady: true }],
    // Never ready without a CLI, also for an inconsistent state.
    [state(false, true), { missing: true, installed: false, ready: false, wslReady: false }],
  ])('values of %j', (value, expected) => {
    const values = dockerContextValues(value);
    expect({
      missing: values[DockerContextKeys.missing],
      installed: values[DockerContextKeys.installed],
      ready: values[DockerContextKeys.ready],
      wslReady: values[DockerContextKeys.wslReady],
    }).toEqual(expected);
  });

  it('sets every key the first time, then only the keys that change', () => {
    expect(changedContextValues(undefined, INITIAL_DOCKER_SETUP_STATE)).toEqual([
      [DockerContextKeys.missing, true],
      [DockerContextKeys.installed, false],
      [DockerContextKeys.ready, false],
      [DockerContextKeys.wslReady, false],
    ]);
    expect(changedContextValues(state(false, false), state(false, false))).toEqual([]);
    expect(changedContextValues(state(false, false), state(true, false))).toEqual([
      [DockerContextKeys.missing, false],
      [DockerContextKeys.installed, true],
    ]);
    expect(changedContextValues(state(true, false), state(true, true))).toEqual([[DockerContextKeys.ready, true]]);
  });

  it('uses the key names of package.json', () => {
    expect(DockerContextKeys).toEqual({
      missing: 'devEnvironments.dockerMissing',
      installed: 'devEnvironments.dockerInstalled',
      ready: 'devEnvironments.dockerReady',
      wslReady: 'devEnvironments.wslReady',
    });
  });
});

describe('checks of the CLI', () => {
  it('looks the CLI up every 10 s only while it is missing', () => {
    expect(needsMissingCliCheck({ ...INITIAL_DOCKER_SETUP_STATE, cliFound: false })).toBe(true);
    expect(needsMissingCliCheck({ ...INITIAL_DOCKER_SETUP_STATE, cliFound: true })).toBe(false);
  });

  it.each<[string, boolean, number, boolean]>([
    ['missing, just started', false, 0, true],
    ['missing, shortly before 30 minutes', false, INSTALL_WATCH_TIMEOUT_MS - 1, true],
    ['missing, after 30 minutes', false, INSTALL_WATCH_TIMEOUT_MS, false],
    ['found', true, 1000, false],
  ])('watches after an installation: %s', (_name, cliFound, elapsed, expected) => {
    expect(keepWatchingInstall({ ...INITIAL_DOCKER_SETUP_STATE, cliFound }, 1_000_000, 1_000_000 + elapsed)).toBe(expected);
  });

  it('watches 30 minutes at most', () => {
    expect(INSTALL_WATCH_TIMEOUT_MS).toBe(1_800_000);
  });
});
