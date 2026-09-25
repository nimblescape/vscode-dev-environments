# Spec — Docker installation offer and setup wizard

Repository: /Users/hs/workspace/projects/vscode-dev-environments. Read docs/vscode-dev-environments.md (6.1, 6.5, 7.3, 7.6 Docker start, section 9) and docs/implementation-notes.md (sections 3, 6) first. Match the code style; src/core never imports vscode; pure logic in src/core with table-driven tests.

## User requirement
"When no Docker is installed, the plugin shall offer to install Docker, similar to the Sign in with GitHub button. It shall provide kind of a wizard for the installation." Decision of the user: **the wizard runs the installer** (not only links), visibly in a VS Code terminal.

## Offer
- Context keys, kept current while VS Code runs: `devEnvironments.dockerMissing` (no Docker CLI found), `devEnvironments.dockerReady` (`docker info` succeeds). While the CLI is missing, check again every 10 s (ContainerAdapter already looks the CLI up again when `isInstalled()` is called; do not call `docker info` in the background when Docker is installed but not running — Resource Saver).
- `viewsWelcome` entry for `devEnvironments.repositories`, FIRST in the list, `when: devEnvironments.dockerMissing`: "Dev Environments runs your environments in Docker, which is not installed on this computer.\n[Install Docker…](command:devEnvironments.installDocker)". The sign-in entry keeps showing below it when not signed in.
- When the tree has rows (welcome views hidden), a row at the top "Install Docker…" with a warning icon and the command (like the sign-in row).
- The message of concept 6.5 "Docker Desktop is not installed." gets the action **Install Docker…** (opens the wizard) instead of "Open download page".
- New command `devEnvironments.installDocker` "Install Docker…" (category Dev Environments). Update notes section 3 (command list) and concept 7.3.
- Only in a local window (`vscode.env.remoteName === undefined`): in a remote window a terminal would run on the remote machine. In a remote window the command shows "Open a local window to install Docker."

## Wizard (VS Code walkthrough)
- `contributes.walkthroughs`: id `dockerSetup`, title "Set up Docker for Dev Environments", with steps per platform (`when`: `isMac`, `isWindows`, `isLinux`). Step media: markdown files in `resources/walkthrough/` (shipped in the VSIX; check `npx vsce ls`). `devEnvironments.installDocker` opens it with `workbench.action.openWalkthrough` (`nimblescape.vscode-dev-environments#dockerSetup`) — mark it as a VS Code command that is not part of the extension API (it goes into the internals inventory).
- Steps (completion via context keys, so steps check themselves off):
  1. **Windows only: WSL 2.** Check `wsl --status` (exit code). Button runs `wsl --install` in the terminal (administrator prompt, restart needed); `completionEvents: onContext:devEnvironments.wslReady`.
  2. **Install Docker.** Text: what gets installed and from where; the Docker Desktop license note (Docker Subscription Service Agreement: free for personal use, education, non-commercial open source, and small businesses; paid for larger companies). Button `command:devEnvironments.dockerSetup.install`. `completionEvents: onContext:devEnvironments.dockerInstalled` (= not dockerMissing).
  3. **Start Docker.** Docker Desktop shows its own dialogs once (license, optional sign-in, settings). Button `command:devEnvironments.dockerSetup.start` (uses the existing `ensureDockerRunning`, with progress). Linux Docker Engine: `sudo systemctl enable --now docker` in the terminal. `completionEvents: onContext:devEnvironments.dockerReady`.
  4. **Sign in with GitHub.** `command:devEnvironments.signIn`; `completionEvents: onContext:devEnvironments.signedIn`.
- Installation plan — a pure function in src/core (e.g. `src/core/docker/dockerSetup.ts`): `installPlan({ platform, arch, osRelease, has: (tool) => boolean }) → { kind: 'terminal'; commands: string[]; needsAdmin: boolean; description } | { kind: 'download'; url; fileName; open: 'dmg' | 'exe' } | { kind: 'manual'; url }`:
  - macOS: Homebrew present (`brew` in PATH, /opt/homebrew/bin, /usr/local/bin) → terminal `brew install --cask docker-desktop` (verify the current cask name with `brew info --cask docker-desktop` on this machine; the old cask `docker` was renamed); otherwise download `https://desktop.docker.com/mac/main/arm64/Docker.dmg` (Apple silicon) or `…/amd64/Docker.dmg` (Intel) to ~/Downloads with a progress notification (cancellable), then `open` the .dmg (the user drags Docker to Applications — say so in the step text).
  - Windows: `winget` present → terminal `winget install --exact --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements`; otherwise download `https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe` (arm64: `…/win/main/arm64/…`) and start it.
  - Linux: Docker Engine from Docker's official apt/dnf repository (commands of https://docs.docker.com/engine/install/ for the distribution from /etc/os-release: ubuntu, debian, fedora, rhel/centos; others → `manual` with the docs link), then `sudo usermod -aG docker $USER` and the note that a new login is needed (or `newgrp docker`). Docker Desktop for Linux: `manual` link.
  - Downloads only over HTTPS from desktop.docker.com; the installers are signed by Docker (macOS notarization, Windows Authenticode) — the step text says so.
- Before anything runs: a MODAL confirmation that lists the exact commands (or the download URL and target file) and says that an administrator password may be requested in the terminal. Then `vscode.window.createTerminal({ name: 'Install Docker' })`, `show()`, `sendText(commands.join(' && '))` (Windows: the default shell — use separate `sendText` lines if needed; PowerShell has no `&&` before 7). Everything is visible; nothing runs hidden.
- After the terminal/installer: keep checking the CLI (every 5 s for up to 30 min while the walkthrough step is not complete; stop when found), then update the context keys and refresh the sidebar. When found: offer "Start Docker" (step 3).
- Tests: installPlan for every platform/arch/tool combination and the Linux distributions; URL selection; the confirmation text lists exactly the commands; context key transitions (pure state function).

## Docs
Concept: 6.1 step 2 (offer + wizard instead of the message with a link), 6.5 row "Docker is not installed" (action Install Docker…), 7.3 (walkthrough contribution, command), section 9 (the installer runs only after confirmation, visibly, from official sources). Notes: section 3 (command + walkthrough), section 6 (installation plan per platform). README: installation of Docker through the wizard.

## Verification
`npx tsc --noEmit`, `npx vitest run`, `node esbuild.mjs --production`, `npm run package` + `npx vsce ls` (walkthrough media included). Do not run any installer on this machine (Docker is installed here); test the plans as pure functions and the command wiring with the fake vscode module. Do not commit.
