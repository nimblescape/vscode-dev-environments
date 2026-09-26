// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Docker setup (concept 6.1 step 2, implementation notes 6 "Installation plan"): how Docker is installed on this
// computer, the confirmation before anything runs, and the context keys of the setup walkthrough. Pure functions; the
// VS Code side (terminal, download, walkthrough) is in src/vscode/dockerSetup.ts.

/** Context keys of the welcome view and the walkthrough steps (package.json). */
export const DockerContextKeys = {
  /** No Docker CLI was found. */
  missing: 'devEnvironments.dockerMissing',
  /** `dockerSetupRequired`: the sidebar shows the Docker setup instead of the repositories (welcome view). */
  setupRequired: 'devEnvironments.dockerSetupRequired',
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
/** An absolute path that the shell reads as one word, without quotes (otherwise: no Homebrew, the download instead). */
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9_./+-]+$/;
/** A user name that `usermod` accepts and that the shell reads as one word, without quotes. */
const USER_NAME_PATTERN = /^[a-z_][a-z0-9_.-]*\$?$/i;

/** The user joins the group docker; the name is written out, so the confirmation shows exactly what runs. */
export function dockerGroupCommand(userName: string): string {
  return `sudo usermod -aG docker ${userName}`;
}
/** Fedora 41 and later have DNF 5, whose `config-manager` has a new syntax. */
const FEDORA_DNF5_VERSION = 41;

// User-visible texts that messages.ts lacks; to be moved there.
export const DockerSetupTexts = {
  descriptionBrew: 'Docker Desktop is installed with Homebrew from its official cask docker-desktop.',
  descriptionWinget: 'Docker Desktop is installed with winget from its official package Docker.DockerDesktop.',
  descriptionEngine: (distribution: string) =>
    `Docker Engine is installed from the official package repository of Docker for ${distribution} (download.docker.com).`,
  linuxGroupNote:
    'Your user is added to the group docker, so that you can use Docker without sudo. Sign out and sign in again afterwards (or run newgrp docker in a terminal). ' +
    'If packages of your distribution for Docker, containerd, or runc are installed, the packages of Docker replace them; the package manager lists them and asks before it removes anything. Images and volumes are kept.',
  confirmInstall: 'Install Docker?',
  confirmCommands: 'These commands run in a terminal of VS Code, where you can follow them:',
  adminPassword: 'An administrator password may be requested in the terminal.',
  confirmDownload: 'Download and open the installer of Docker Desktop?',
  downloadFrom: (url: string, file: string) => `The installer is downloaded over HTTPS from Docker:\n${url}\n\nIt is saved as:\n${file}`,
  downloadMac:
    'Then it opens. Drag Docker to the Applications folder. The installer is signed and notarized by Docker; the file is marked as downloaded, so that macOS checks this when Docker starts the first time.',
  downloadWindows:
    'Then it starts. The installer is signed by Docker; the file is marked as downloaded, so that Windows checks it. Windows may ask for an administrator password or for your permission.',
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
  /**
   * macOS: the full path of the `brew` that `has('brew')` found. The command names it, so that the terminal (with its
   * fixed search path) runs this Homebrew, also one outside /opt/homebrew and /usr/local, and the confirmation shows it.
   */
  brewPath?: string;
  /** The login name of the user (Linux: joins the group docker). Missing or unusual: the documentation instead. */
  userName?: string;
  /**
   * Ubuntu and Debian: apt already has a source of download.docker.com (for example docker.list of an earlier
   * installation). A second source with another key would stop apt for every package: the documentation instead.
   */
  existingDockerSource?: boolean;
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
    const brew = input.brewPath === undefined ? 'brew' : SAFE_PATH_PATTERN.test(input.brewPath) ? input.brewPath : undefined;
    if (platform === 'darwin' && input.has('brew') && brew !== undefined) {
      // The cask links the CLI into /usr/local/bin with sudo, so Homebrew may ask for the password.
      const command = brew === 'brew' ? BREW_INSTALL_COMMAND : `${brew} install --cask docker-desktop`;
      return { kind: 'terminal', commands: [command], needsAdmin: true, description: DockerSetupTexts.descriptionBrew };
    }
    if (platform === 'win32' && input.has('winget')) {
      return { kind: 'terminal', commands: [WINGET_INSTALL_COMMAND], needsAdmin: true, description: DockerSetupTexts.descriptionWinget };
    }
    const url = dockerDesktopDownloadUrl(platform, arch);
    if (!url) return { kind: 'manual', url: DOCKER_DESKTOP_DOCS_URL };
    return { kind: 'download', url, fileName: fileNameOf(url), open: platform === 'darwin' ? 'dmg' : 'exe' };
  }
  if (platform === 'linux') return linuxPlan(arch, input.osRelease ?? {}, input.userName, input.existingDockerSource === true);
  return { kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL };
}

function linuxPlan(
  arch: string,
  osRelease: Readonly<Record<string, string>>,
  userName: string | undefined,
  existingDockerSource: boolean,
): InstallPlan {
  const id = (osRelease.ID ?? '').toLowerCase();
  const manual: InstallPlan = { kind: 'manual', url: DOCKER_ENGINE_INSTALL_URL };
  if (!userName || !USER_NAME_PATTERN.test(userName)) return manual;
  let setup: string[];
  let distribution: string;
  switch (id) {
    case 'ubuntu':
    case 'debian': {
      if (existingDockerSource) return manual;
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
    commands: [...setup, dockerGroupCommand(userName)],
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

/** True if a file of /etc/apt/sources.list(.d) names the package repository of Docker. */
export function namesDockerSource(content: string): boolean {
  return /download\.docker\.com/i.test(content);
}

/**
 * The value of the extended attribute com.apple.quarantine of a downloaded file (flags 0081: downloaded, not yet
 * approved), so that Gatekeeper checks the signature and notarization of Docker when it starts the first time.
 */
export function quarantineAttribute(nowMs: number): string {
  return `0081;${Math.floor(nowMs / 1000).toString(16)};Dev Environments;`;
}

/** The stream Zone.Identifier of a file downloaded from the internet (zone 3), so that Windows checks it (SmartScreen). */
export function zoneIdentifier(url: string): string {
  return `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${url}\r\n`;
}

/** The terminal in which the commands run (vscode.TerminalOptions without the name). */
export interface InstallTerminalOptions {
  shellPath: string;
  cwd: string;
  env: Record<string, string>;
  strictEnv: true;
}

/** Search path of the install terminal on macOS (Homebrew on Apple silicon and Intel first) and on Linux. */
const MAC_INSTALL_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const LINUX_INSTALL_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** Variables of the extension host that the install terminal keeps on macOS and Linux (a proxy of the computer). */
const KEPT_VARIABLES = [
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  // Certificates of a company network.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
];
/** Settings of Homebrew (for example HOMEBREW_CASK_OPTS, a mirror), kept on macOS. */
const KEPT_PREFIX_MAC = 'HOMEBREW_';
/** Variables of Windows that the install terminal keeps; everything else (also PATH) is fixed. */
const KEPT_WINDOWS_VARIABLES = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'USERNAME',
  'USERDOMAIN',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'COMPUTERNAME',
  'PUBLIC',
  'ALLUSERSPROFILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
];

/**
 * The install terminal: a fixed shell of the system, the home folder, and a fixed environment (`strictEnv`), so that
 * neither the terminal settings of a workspace (profiles, `terminal.integrated.env.*`) nor files of the opened folder
 * change what the listed commands run. The search path is fixed on every platform (on Windows the folders of the system
 * and the WindowsApps folder of the user, where winget lives); a few variables of the computer are kept (language,
 * proxy, certificates, on macOS the settings of Homebrew, on Windows the folders of the user).
 */
export function installTerminalOptions(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  userName: string | undefined,
): InstallTerminalOptions {
  if (platform === 'win32') {
    // Names of variables are not case-sensitive on Windows.
    const byName = new Map(Object.entries(env).map(([name, value]) => [name.toLowerCase(), value]));
    const systemRoot = byName.get('systemroot') ?? 'C:\\Windows';
    const kept: Record<string, string> = {};
    for (const name of KEPT_WINDOWS_VARIABLES) {
      const value = byName.get(name.toLowerCase());
      if (value !== undefined) kept[name] = value;
    }
    kept.SystemRoot = systemRoot;
    // wsl.exe is in System32; winget in the WindowsApps folder of the user.
    const folders = [`${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\Wbem`, `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`];
    const localAppData = byName.get('localappdata');
    if (localAppData) folders.push(`${localAppData}\\Microsoft\\WindowsApps`);
    kept.PATH = folders.join(';');
    return { shellPath: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, cwd: home, env: kept, strictEnv: true };
  }
  const fixed: Record<string, string> = { PATH: platform === 'darwin' ? MAC_INSTALL_PATH : LINUX_INSTALL_PATH, HOME: home };
  if (userName) {
    fixed.USER = userName;
    fixed.LOGNAME = userName;
  }
  for (const name of KEPT_VARIABLES) {
    const value = env[name];
    if (value !== undefined) fixed[name] = value;
  }
  if (platform === 'darwin') {
    for (const [name, value] of Object.entries(env)) if (name.startsWith(KEPT_PREFIX_MAC) && value !== undefined) fixed[name] = value;
  }
  return { shellPath: '/bin/sh', cwd: home, env: fixed, strictEnv: true };
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

/**
 * True while the sidebar shows the Docker setup instead of the repositories. User decision 2026-09-26: "when no remote
 * docker is configured and local docker is not available, the repositories shall not be shown, instead, the side view
 * shall show the install docker wizard". Local Docker is not available when no Docker CLI is found (`dockerMissing`).
 * Docker that is installed but does not run is available: the extension starts it when it is needed (FR-14).
 */
export function dockerSetupRequired(dockerMissing: boolean, remoteDockerHostConfigured: boolean): boolean {
  return dockerMissing && !remoteDockerHostConfigured;
}

/** Values of the context keys of a state. */
export function dockerContextValues(state: DockerSetupState, remoteDockerHostConfigured: boolean): Record<DockerContextKey, boolean> {
  return {
    [DockerContextKeys.missing]: !state.cliFound,
    [DockerContextKeys.installed]: state.cliFound,
    [DockerContextKeys.ready]: state.cliFound && state.engineRunning,
    [DockerContextKeys.wslReady]: state.wslReady,
    [DockerContextKeys.setupRequired]: dockerSetupRequired(!state.cliFound, remoteDockerHostConfigured),
  };
}

/** The context keys that change from `before` to `after` (all keys when `before` is undefined: nothing was set yet). */
export function changedContextValues(
  before: Readonly<Record<DockerContextKey, boolean>> | undefined,
  after: Readonly<Record<DockerContextKey, boolean>>,
): Array<[DockerContextKey, boolean]> {
  return (Object.keys(after) as DockerContextKey[]).filter((key) => before?.[key] !== after[key]).map((key) => [key, after[key]]);
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
