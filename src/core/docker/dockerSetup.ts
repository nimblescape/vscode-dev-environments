// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Docker setup (concept 6.1 step 2, implementation notes 6 "Installation plan"): how Docker is installed on this
// computer, the confirmation before anything runs, and the context keys of the setup walkthrough. Pure functions; the
// VS Code side (terminal, download, walkthrough) is in src/vscode/dockerSetup.ts.

/** Context keys of the welcome view, the sidebar row, and the walkthrough steps (package.json). */
export const DockerContextKeys = {
  /** No Docker CLI was found. */
  missing: 'devEnvironments.dockerMissing',
  /** A Docker CLI was found (the opposite of `missing`; walkthrough step "Install Docker"). */
  installed: 'devEnvironments.dockerInstalled',
  /** The last `docker info` succeeded (walkthrough step "Start Docker"). */
  ready: 'devEnvironments.dockerReady',
  /** Windows: `wsl --status` succeeded (walkthrough step "WSL 2"). */
  wslReady: 'devEnvironments.wslReady',
} as const;

export type DockerContextKey = (typeof DockerContextKeys)[keyof typeof DockerContextKeys];

/** While the CLI is missing, it is looked up this often. */
export const MISSING_CLI_CHECK_MS = 10_000;
/** After an installation was started, the CLI is looked up this often… */
export const INSTALL_WATCH_INTERVAL_MS = 5_000;
/** …for at most this long. */
export const INSTALL_WATCH_TIMEOUT_MS = 30 * 60_000;

/** Official download links of Docker Desktop (desktop.docker.com, over HTTPS). */
export const DOCKER_DESKTOP_DOWNLOADS = {
  macArm64: 'https://desktop.docker.com/mac/main/arm64/Docker.dmg',
  macAmd64: 'https://desktop.docker.com/mac/main/amd64/Docker.dmg',
  windowsAmd64: 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
  windowsArm64: 'https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe',
} as const;

/** The only host that installers are downloaded from. */
export const DOCKER_DOWNLOAD_HOST = 'desktop.docker.com';
/** Docker Engine installation, all distributions. */
export const DOCKER_ENGINE_INSTALL_URL = 'https://docs.docker.com/engine/install/';
/** Docker Desktop, for a platform or architecture without a download link. */
export const DOCKER_DESKTOP_DOCS_URL = 'https://docs.docker.com/desktop/';
/** Docker Desktop for Linux, which the extension does not install itself. */
export const DOCKER_DESKTOP_LINUX_URL = 'https://docs.docker.com/desktop/setup/install/linux/';
/** Docker Desktop on Windows needs WSL 2. */
export const WSL_INSTALL_COMMAND = 'wsl --install';
/** Docker Engine on Linux: starts the service now and with the computer. */
export const LINUX_ENGINE_START_COMMAND = 'sudo systemctl enable --now docker';
/** Homebrew cask of Docker Desktop (the former cask `docker` was renamed to `docker-desktop`). */
export const BREW_INSTALL_COMMAND = 'brew install --cask docker-desktop';
export const WINGET_INSTALL_COMMAND =
  'winget install --exact --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements';

const DOCKER_ENGINE_PACKAGES = 'docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin';
const DOCKER_GROUP_COMMAND = 'sudo usermod -aG docker $USER';
/** Fedora 41 and later have DNF 5, whose `config-manager` has a new syntax. */
const FEDORA_DNF5_VERSION = 41;

// User-visible texts that messages.ts lacks; to be moved there.
export const DockerSetupTexts = {
  descriptionBrew: 'Docker Desktop is installed with Homebrew from its official cask docker-desktop.',
  descriptionWinget: 'Docker Desktop is installed with winget from its official package Docker.DockerDesktop.',
  descriptionEngine: (distribution: string) =>
    `Docker Engine is installed from the official package repository of Docker for ${distribution} (download.docker.com).`,
  linuxGroupNote:
    'Your user is added to the group docker, so that you can use Docker without sudo. Sign out and sign in again afterwards (or run newgrp docker in a terminal).',
  confirmInstall: 'Install Docker?',
  confirmCommands: 'These commands run in a terminal of VS Code, where you can follow them:',
  adminPassword: 'An administrator password may be requested in the terminal.',
  confirmDownload: 'Download and open the installer of Docker Desktop?',
  downloadFrom: (url: string, file: string) => `The installer is downloaded over HTTPS from Docker:\n${url}\n\nIt is saved as:\n${file}`,
  downloadMac: 'Then it opens. Drag Docker to the Applications folder. The installer is signed and notarized by Docker.',
  downloadWindows:
    'Then it starts. The installer is signed by Docker. Windows may ask for an administrator password or for your permission.',
  confirmWsl: 'Install WSL 2?',
  wslRestart: 'Windows asks for administrator permission. Restart the computer afterwards.',
  confirmStartEngine: 'Start the Docker service?',
  install: 'Install',
  download: 'Download',
  start: 'Start',
} as const;

/** Tools that change the installation plan. */
export type SetupTool = 'brew' | 'winget';

export interface InstallPlanInput {
  platform: NodeJS.Platform;
  /** `process.arch` of the computer (on a Mac with Apple silicon also when VS Code runs under Rosetta: `arm64`). */
  arch: string;
  /** Fields of /etc/os-release (see `parseOsRelease`); Linux only. */
  osRelease?: Readonly<Record<string, string>>;
  /** True if the tool is installed (`brew` in PATH, /opt/homebrew/bin, or /usr/local/bin; `winget` in PATH). */
  has: (tool: SetupTool) => boolean;
}

export type InstallPlan =
  | {
      kind: 'terminal';
      /** Run in this order in a visible terminal; each one only when the one before succeeded. */
      commands: string[];
      needsAdmin: boolean;
      /** What gets installed and from where. */
      description: string;
      /** Shown after the installation (Linux: the group docker needs a new login). */
      note?: string;
    }
  | { kind: 'download'; url: string; fileName: string; open: 'dmg' | 'exe' }
  | { kind: 'manual'; url: string };

/** Parses /etc/os-release (`KEY=value`, values optionally quoted). */
export function parseOsRelease(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(["\\$`])/g, '$1');
    }
    fields[match[1]] = value;
  }
  return fields;
}

/** Download link of Docker Desktop for macOS or Windows, or `undefined` for other platforms and architectures. */
export function dockerDesktopDownloadUrl(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'darwin') {
    if (arch === 'arm64') return DOCKER_DESKTOP_DOWNLOADS.macArm64;
    if (arch === 'x64') return DOCKER_DESKTOP_DOWNLOADS.macAmd64;
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return DOCKER_DESKTOP_DOWNLOADS.windowsArm64;
    if (arch === 'x64') return DOCKER_DESKTOP_DOWNLOADS.windowsAmd64;
  }
  return undefined;
}

/** True for an HTTPS URL of the Docker download host (also the target of a redirect is checked with it). */
export function isOfficialDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === DOCKER_DOWNLOAD_HOST;
  } catch {
    return false;
  }
}

/** File name of a download URL, for example `Docker Desktop Installer.exe`. */
function fileNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
}

/** Debian architecture name of a Node.js architecture, as `dpkg --print-architecture` gives it. */
const DEBIAN_ARCHITECTURES: Record<string, string> = {
  x64: 'amd64',
  arm64: 'arm64',
  arm: 'armhf',
  ppc64: 'ppc64el',
  s390x: 's390x',
};

/**
 * How Docker is installed on this computer:
 * - macOS: Homebrew → `brew install --cask docker-desktop`; otherwise the .dmg of Docker Desktop (Apple silicon or Intel).
 * - Windows: winget → `winget install … Docker.DockerDesktop`; otherwise the installer .exe (x64 or Arm).
 * - Linux: Docker Engine from the repository of Docker for Ubuntu, Debian, Fedora, RHEL, and CentOS (the commands of
 *   https://docs.docker.com/engine/install/), then the user joins the group docker. Other distributions: the documentation.
 * - Anything else: the documentation.
 */
export function installPlan(input: InstallPlanInput): InstallPlan {
  const { platform, arch } = input;
  if (platform === 'darwin' || platform === 'win32') {
    if (platform === 'darwin' && input.has('brew')) {
      // The cask links the CLI into /usr/local/bin with sudo, so Homebrew may ask for the password.
      return { kind: 'terminal', commands: [BREW_INSTALL_COMMAND], needsAdmin: true, description: DockerSetupTexts.descriptionBrew };
    }
    if (platform === 'win32' && input.has('winget')) {
      return { kind: 'terminal', commands: [WINGET_INSTALL_COMMAND], needsAdmin: true, description: DockerSetupTexts.descriptionWinget };
    }
    const url = dockerDesktopDownloadUrl(platform, arch);
    if (!url) return { kind: 'manual', url: DOCKER_DESKTOP_DOCS_URL };
    return { kind: 'download', url, fileName: fileNameOf(url), open: platform === 'darwin' ? 'dmg' : 'exe' };
  }
  if (platform === 'linux') return linuxPlan(arch, input.osRelease ?? {});
  return { kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL };
}

function linuxPlan(arch: string, osRelease: Readonly<Record<string, string>>): InstallPlan {
  const id = (osRelease.ID ?? '').toLowerCase();
  const manual: InstallPlan = { kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL };
  let setup: string[];
  let distribution: string;
  switch (id) {
    case 'ubuntu':
    case 'debian': {
      const codename = id === 'ubuntu' ? osRelease.UBUNTU_CODENAME || osRelease.VERSION_CODENAME : osRelease.VERSION_CODENAME;
      const architecture = DEBIAN_ARCHITECTURES[arch];
      if (!codename || !/^[a-z0-9-]+$/.test(codename) || !architecture) return manual;
      distribution = id === 'ubuntu' ? 'Ubuntu' : 'Debian';
      setup = aptSetup(`https://download.docker.com/linux/${id}`, codename, architecture);
      break;
    }
    case 'fedora': {
      const version = Number.parseInt(osRelease.VERSION_ID ?? '', 10);
      if (!Number.isFinite(version)) return manual;
      distribution = 'Fedora';
      const repo = 'https://download.docker.com/linux/fedora/docker-ce.repo';
      setup =
        version >= FEDORA_DNF5_VERSION
          ? [`sudo dnf config-manager addrepo --from-repofile ${repo}`]
          : ['sudo dnf -y install dnf-plugins-core', `sudo dnf config-manager --add-repo ${repo}`];
      setup.push(`sudo dnf install ${DOCKER_ENGINE_PACKAGES}`);
      break;
    }
    case 'rhel':
    case 'centos':
      distribution = id === 'rhel' ? 'RHEL' : 'CentOS';
      setup = [
        'sudo dnf -y install dnf-plugins-core',
        `sudo dnf config-manager --add-repo https://download.docker.com/linux/${id}/docker-ce.repo`,
        `sudo dnf install ${DOCKER_ENGINE_PACKAGES}`,
      ];
      break;
    default:
      return manual;
  }
  return {
    kind: 'terminal',
    commands: [...setup, DOCKER_GROUP_COMMAND],
    needsAdmin: true,
    description: DockerSetupTexts.descriptionEngine(distribution),
    note: DockerSetupTexts.linuxGroupNote,
  };
}

/**
 * The apt steps of the Docker documentation. The values that the documentation reads in the shell (codename,
 * architecture) are written out, so that the commands work in every shell (bash, zsh, fish) and the confirmation shows
 * exactly what runs; `printf | sudo tee` replaces the here-document, which a single command line cannot hold.
 */
function aptSetup(base: string, codename: string, architecture: string): string[] {
  const sources = [
    'Types: deb',
    `URIs: ${base}`,
    `Suites: ${codename}`,
    'Components: stable',
    `Architectures: ${architecture}`,
    'Signed-By: /etc/apt/keyrings/docker.asc',
  ];
  return [
    'sudo apt update',
    'sudo apt install ca-certificates curl',
    'sudo install -m 0755 -d /etc/apt/keyrings',
    `sudo curl -fsSL ${base}/gpg -o /etc/apt/keyrings/docker.asc`,
    'sudo chmod a+r /etc/apt/keyrings/docker.asc',
    `printf '${sources.join('\\n')}\\n' | sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null`,
    'sudo apt update',
    `sudo apt install ${DOCKER_ENGINE_PACKAGES}`,
  ];
}

/** The lines that the terminal gets: one line with `&&` (stops at the first error), on Windows one line per command. */
export function terminalLines(commands: readonly string[], platform: NodeJS.Platform): string[] {
  // Windows PowerShell before version 7 has no `&&`, and the default shell of the terminal is not known.
  if (platform === 'win32') return [...commands];
  return commands.length === 0 ? [] : [commands.join(' && ')];
}

/** Text of the modal confirmation before anything runs or is downloaded. */
export interface Confirmation {
  message: string;
  detail: string;
  /** The button that confirms. */
  button: string;
}

/** Confirmation of commands that run in the terminal: they are listed exactly as they run. */
export function terminalConfirmation(
  message: string,
  commands: readonly string[],
  options: { description?: string; needsAdmin: boolean; note?: string; button?: string },
): Confirmation {
  const parts = [
    options.description,
    `${DockerSetupTexts.confirmCommands}\n\n${commands.join('\n')}`,
    options.needsAdmin ? DockerSetupTexts.adminPassword : undefined,
    options.note,
  ];
  return {
    message,
    detail: parts.filter((part): part is string => part !== undefined && part !== '').join('\n\n'),
    button: options.button ?? DockerSetupTexts.install,
  };
}

/** Confirmation before a plan runs. `targetFile`: where a download is saved. A `manual` plan needs none. */
export function installConfirmation(plan: InstallPlan, targetFile?: string): Confirmation | undefined {
  switch (plan.kind) {
    case 'terminal':
      return terminalConfirmation(DockerSetupTexts.confirmInstall, plan.commands, plan);
    case 'download':
      return {
        message: DockerSetupTexts.confirmDownload,
        detail: [
          DockerSetupTexts.downloadFrom(plan.url, targetFile ?? plan.fileName),
          plan.open === 'dmg' ? DockerSetupTexts.downloadMac : DockerSetupTexts.downloadWindows,
        ].join('\n\n'),
        button: DockerSetupTexts.download,
      };
    case 'manual':
      return undefined;
  }
}

/** What the extension knows about Docker on this computer. */
export interface DockerSetupState {
  cliFound: boolean;
  /** The last `docker info` succeeded. Unknown counts as false: Docker is not asked in the background. */
  engineRunning: boolean;
  /** Windows: `wsl --status` succeeded. */
  wslReady: boolean;
}

export type DockerSetupEvent =
  | { kind: 'cli'; found: boolean }
  | { kind: 'engine'; running: boolean }
  | { kind: 'wsl'; ready: boolean };

export const INITIAL_DOCKER_SETUP_STATE: DockerSetupState = { cliFound: false, engineRunning: false, wslReady: false };

/** The next state after a check. Without a CLI, Docker cannot run; an engine that answers implies a CLI. */
export function nextDockerSetupState(state: DockerSetupState, event: DockerSetupEvent): DockerSetupState {
  switch (event.kind) {
    case 'cli':
      return { ...state, cliFound: event.found, engineRunning: event.found && state.engineRunning };
    case 'engine':
      return { ...state, engineRunning: event.running, cliFound: state.cliFound || event.running };
    case 'wsl':
      return { ...state, wslReady: event.ready };
  }
}

/** Values of the context keys of a state. */
export function dockerContextValues(state: DockerSetupState): Record<DockerContextKey, boolean> {
  return {
    [DockerContextKeys.missing]: !state.cliFound,
    [DockerContextKeys.installed]: state.cliFound,
    [DockerContextKeys.ready]: state.cliFound && state.engineRunning,
    [DockerContextKeys.wslReady]: state.wslReady,
  };
}

/** The context keys that change from `before` to `after` (all keys when `before` is undefined: nothing was set yet). */
export function changedContextValues(
  before: DockerSetupState | undefined,
  after: DockerSetupState,
): Array<[DockerContextKey, boolean]> {
  const next = dockerContextValues(after);
  const previous = before ? dockerContextValues(before) : undefined;
  return (Object.keys(next) as DockerContextKey[]).filter((key) => previous?.[key] !== next[key]).map((key) => [key, next[key]]);
}

/** True while the CLI is looked up every 10 s: only while it is missing. */
export function needsMissingCliCheck(state: DockerSetupState): boolean {
  return !state.cliFound;
}

/** True while the CLI is looked up every 5 s after an installation started: until found, for at most 30 minutes. */
export function keepWatchingInstall(state: DockerSetupState, startedAt: number, now: number): boolean {
  return !state.cliFound && now - startedAt < INSTALL_WATCH_TIMEOUT_MS;
}

/** The architecture of the computer: VS Code for Intel under Rosetta on a Mac with Apple silicon reports `x64`. */
export function hardwareArch(platform: NodeJS.Platform, processArch: string, translated: boolean): string {
  return platform === 'darwin' && processArch === 'x64' && translated ? 'arm64' : processArch;
}
