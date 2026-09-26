# Dev Environments

Open your GitHub repositories in local dev containers with one action.

Dev Environments lists the GitHub repositories that you can access and that contain a Dev Container configuration. **Start** opens a repository in a container on your computer, in the current window. **Start in New Window** opens it in a new window instead, so you can work in several environments at the same time. The extension does the rest for you:

- It starts Docker when Docker is not running.
- It downloads the repository into a Docker volume. Your work stays in this volume when the container is created again.
- Before each connection, it checks for a newer container image and updates the environment if one exists. Without internet access, it skips this check and uses the local image.
- When you close the window, it stops the container after a short waiting time.
- When VS Code starts again, it opens the last environment.

## Requirements

- Visual Studio Code 1.90 or later.
- Docker: Docker Desktop on macOS, Windows (with WSL 2), or Linux, or Docker Engine on Linux. Without Docker, the extension offers to install it (see below).
- A GitHub account.
- The Dev Containers extension. You do not need to install it yourself: VS Code installs it together with this extension.

Git on your computer is not needed.

## How to use it

1. Select the **Dev Environments** icon in the activity bar. If Docker is not installed, the view shows the steps to set it up instead of the repositories (see [Installing Docker](#installing-docker)).
2. Select **Sign in with GitHub**. The list shows your repositories with a Dev Container configuration, grouped by owner.
3. Use the actions of a repository:
   - **Start**: creates the environment on the first use (this can take several minutes), starts the container, and connects the current window.
   - **Start in New Window** (context menu of a repository, and **⋯**): the same, but a new window connects. The current window keeps its environment. If another window has the environment open already, that window comes to the front; an environment is never open in two windows.
   - **Stop**: stops the container at once. Your files are kept.
   - **Delete**: removes the container and the volume with the repository, after you confirm it. If the volume has uncommitted changes, unpushed commits, or stashes, the confirmation shows them.
   - **⋯**: Switch Branch…, Select Configuration… (only for repositories with several configurations), Rebuild, and Show on GitHub.
4. To go to another environment, use **Dev Environments: Switch Environment…** (`Ctrl+Alt+E`, on macOS `Cmd+Alt+E`), or select the status bar item. The same window connects to the other environment. **Dev Environments: Switch Environment in New Window…** opens the selected environment in a new window.

**Select Organizations…**, **Search**, and **Refresh** are at the top of the view. **Select Organizations…** limits the list to the organizations and accounts that you select: only their repositories are scanned, which is faster when you can access many repositories. Select none to see all repositories again. **Dev Environments: Show Log** opens the complete log.

The first load of the list can take some time with many repositories; the view shows the repositories as they arrive. Later updates read only the repositories that changed.

## Installing Docker

When Docker is not installed, the view shows no repositories, but the steps to set Docker up, each with its button: on Windows **Install WSL 2**, then **Install Docker**. After the installation, your repositories appear in the view, and Docker is started when it is needed. **Open the Setup Guide** opens the walkthrough **Set up Docker for Dev Environments**, which guides you step by step and checks each step off by itself:

1. On Windows: **Install WSL 2** (`wsl --install`; restart the computer afterwards).
2. **Install Docker**:
   - macOS: with Homebrew, `brew install --cask docker-desktop`; without Homebrew, the installer `Docker.dmg` is downloaded from Docker and opens (drag Docker to Applications).
   - Windows: with winget, `winget install --exact --id Docker.DockerDesktop …`; without winget, `Docker Desktop Installer.exe` is downloaded from Docker and starts.
   - Linux (Ubuntu, Debian, Fedora, RHEL, CentOS): Docker Engine from the package repository of Docker, and your user joins the group `docker` (sign in again afterwards). Other distributions: the installation guide of Docker opens.
3. **Start Docker**. At its first start, Docker Desktop shows its own dialogs once. On Linux, `sudo systemctl enable --now docker` starts the Docker service.
4. **Sign in with GitHub**.

Nothing runs without your confirmation: a dialog first lists the exact commands, or the download address and the file. Commands run visibly in a terminal of VS Code, where you enter your password if one is needed. Downloads come only from Docker over HTTPS, and the installers are signed by Docker; your system checks the signature when the installer opens. Settings of the opened workspace do not change what runs in the terminal. If Docker is installed already, nothing is installed. Docker Desktop is free for personal use, education, non-commercial open source projects, and small businesses; larger companies need a paid subscription (Docker Subscription Service Agreement). The installation works only in a local window, not in a remote window.

## Settings

| Setting | Default | Description |
|---|---|---|
| `devEnvLauncher.reopenLastOnStartup` | `true` | Open the last used environment when VS Code starts. |
| `devEnvLauncher.openInNewWindow` | `false` | If `true`, **Start** and **Switch Environment…** open the environment in a new window, and the current window keeps its environment. The context menu then offers **Start in Current Window**, and the Command Palette **Switch Environment in Current Window…**. From an empty window, **Start** uses that window. Only the user settings count. |
| `devEnvLauncher.stopOnClose` | `true` | Stop the environment when no window uses it. If `false`, the container keeps running. |
| `devEnvLauncher.waitingTimeSeconds` | `30` | Waiting time in seconds before a stop. It prevents a stop during a window reload. |
| `devEnvLauncher.updateImagesOnConnect` | `true` | Check for newer images at each connection. |
| `devEnvLauncher.respectShutdownActionNone` | `false` | If `true`, a repository with `"shutdownAction": "none"` keeps its container running after close. |
| `devEnvLauncher.owners` | `[]` | Scan only the repositories of these organizations or accounts. An empty list scans all repositories that you can access. **Select Organizations…** changes it. |
| `devEnvLauncher.includeArchived` | `false` | Show archived repositories. |
| `devEnvLauncher.includeForks` | `true` | Show forked repositories. |
| `devEnvLauncher.refreshIntervalMinutes` | `60` | Interval in minutes of the background update of the repository list. |
| `devEnvLauncher.hostAccessChecksOff` | `[]` | Repositories (`owner/name`) whose host access checks are off (see below). Only the user settings count: a workspace or folder setting cannot turn a check off. **Turn Off Host Access Checks…** and **Turn On Host Access Checks** in the context menu of a repository change it. Turning the checks off applies when the container is created next (for example with **Rebuild**); an existing container keeps its current settings, such as ports bound to this computer only. |
| `devEnvLauncher.repositoryGroups` | `[]` | Regular expressions that filter and group the repositories in the sidebar by name. The capturing groups become the levels of the tree: the first group is the top level under the owner, the last group is the label of the repository. An entry with a `name` gets its own node. The nodes are in the order of the entries. In an owner where a repository matches, the repositories that match none are hidden, except those with an environment; an owner without a match keeps its plain list. Example: `["^(\\d{4}-[^-]+-[^-]+)-([^-]+-[^-]+)-(.+)$"]`. Only the user settings can set it. Avoid nested repetitions such as `(a+)+`: they can make VS Code stop responding (the view names the setting when grouping is slow). **Dev Environments: Edit Repository Groups…** edits it (see below). |

**Edit Repository Groups.** The Settings editor of VS Code can only open `settings.json` for `devEnvLauncher.repositoryGroups`. **Dev Environments: Edit Repository Groups…** (Command Palette, or the **…** menu at the top of the view) opens an editor for it:

- Each entry has an optional name, the regular expression, and the flags `i` (ignore case), `u` (Unicode), and `s` (dot matches line breaks). Add, remove, and move entries with the buttons; an entry that is not valid shows its error at once.
- The preview shows, for the repositories that the view has loaded, how many repositories each entry takes, the resulting tree of each owner, and which repositories would be hidden. Repositories with an environment are always shown.
- Type a repository name in **Test a Repository Name** to see which entry matches it and where its row goes.
- **Save** writes the user settings and changes only this setting in `settings.json`; your other settings and comments stay. If you changed the setting in `settings.json` while the editor was open, Save keeps that change and adds yours; it asks only about an entry that both changed differently. **Cancel**, or closing the tab, discards your changes.

## Known limits

- The first open of a repository needs internet access: for the download of the repository and of the images.
- The repository is in a Docker volume, not in a folder on your computer. Other programs on your computer cannot open the files directly.
- Configurations that mount files of the repository from your computer (variable `${localWorkspaceFolder}`) do not work, because the repository is not in a folder on your computer.
- Configurations that need access to your computer are refused, with a message that names each setting: bind mounts (also of the Docker socket), volumes of other programs and environments (for example of the Dev Containers extension, of Docker Compose, or of another GitHub account), privileged mode, devices, other capabilities and security options, the namespaces of the computer, the network of another container (`--network container:…`), the variables that keep the Git configuration and the credentials of your computer out of the environment (for example `GIT_CONFIG_GLOBAL` or `DOCKER_CONFIG`), the token and host variables of the GitHub CLI (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST`: `gh` in the environment is signed in only as the account that owns it), forwarding of ports on all addresses (`remote.localPortHost`), and `initializeCommand`. Options of `runArgs` and `build.options` that the extension does not know are refused too, with a message of their own, and so are labels of Dev Environments and of the Dev Container CLI (`devenv.*`, `devcontainer.*`). Options that give no access to your computer are allowed, for example `--platform`, `--tmpfs`, `--cap-drop`, and `--read-only`; `--rm`, `-it`, and `-d` are removed, because Dev Environments runs the container itself; its log names them. The container can use the network, also a VPN of your computer; its ports reach your computer only on localhost (VS Code port forwarding, and published ports on `127.0.0.1`), and URLs open in your browser. Exception: with `--network host`, the container uses the network of your computer, and a server in the container that listens on all addresses (`0.0.0.0`) can also be reached from your network, as a server on your computer itself; on Linux with Docker Engine, the container can then also connect to local programs of your computer through their abstract Unix sockets (for example the X11 display and D-Bus).
- The host access checks are on for every repository by default. For a repository that you trust, **Turn Off Host Access Checks…** in its context menu turns them off after a warning: its configuration, Features, and base image may then use the files of your computer (bind mounts), the Docker socket (which gives full control of Docker and of every other environment, also of other GitHub accounts), privileged mode, capabilities and security options, devices and GPUs, published ports on all network addresses (they are no longer bound to `127.0.0.1`), and the volumes of other programs. The volumes of your other environments and of other GitHub accounts, the variables of Git and of the GitHub CLI, `initializeCommand`, the labels of Dev Environments, and the options that Dev Environments does not support stay refused. The row shows `host access unrestricted`, and the log says so at every start. **Turn On Host Access Checks** turns them on again: at the next start, a container that was made without them is made again, if the configuration passes the checks; otherwise the start stops with the usual message.
- Values of `${localEnv:…}` variables of your computer are not passed to the environment. They are empty or have their default value; `HOME`, `PATH`, `HOSTNAME`, `NODE_VERSION`, and `YARN_VERSION` get the values of the workspace helper (for example, `HOME` is `/root`).
- Git in the container older than version 2.32 reads the Git configuration of the environment only through `~/.gitconfig`, which the image must not bring with content of its own. Git older than version 2.9 may use the Git credentials of your computer; the extension warns about it.
- The Dev Containers extension and VS Code keep some channels to your computer open, for example the SSH and GPG agent sockets, a socket of the Dev Containers extension that answers requests for the Git and Docker credentials of your computer, the opening of URLs, and the clipboard. Git in the environment does not use these sockets, but a program that looks for them can. For full isolation, use a separate user account on your computer or a virtual machine.
- Every container can reach the ports on localhost of your computer through `host.docker.internal`, also the ports that VS Code forwards for other environments. Ports on `127.0.0.1` are protected against your network, not against other containers.
- Only data in the repository volume survives a rebuild, and also when an update of the extension sets the container up again (the progress says so). Data in other folders of the container, for example the home folder, is lost, unless the configuration stores it in an additional named volume (property `mounts`).
- Each GitHub account has its own environment of a repository, with its own clone: two accounts that work on the same repository need the disk space for two clones. A configuration whose named volumes have a fixed name (or `${localWorkspaceFolderBasename}-…`) works for one account's environment only; use `${devcontainerId}` in the name to give each environment its own volume.
- Work that runs in the container after its window has closed, for example a long build in a terminal, ends when the container stops.
- On Linux with Docker Engine, the extension cannot start the Docker service by itself, because this needs administrator rights. **Start Docker** in the walkthrough runs `sudo systemctl enable --now docker` in a terminal, where you enter your password.
- Docker Compose configurations are not supported yet.
- With **Select Organizations…**, GitHub is asked only about the selected owners. Your environments of repositories of other owners stay in the list, but without the check whether the repository is still on GitHub. An environment created with an older version of Dev Environments that is not assigned to a GitHub account yet stays hidden while its owner is not selected.

## Privacy

- The extension uses the GitHub sign-in of VS Code. VS Code stores the session. The extension keeps your token out of its settings and stored lists. It writes the token only into the Docker volume of each environment of your account (see below).
- An environment belongs to the GitHub account that created it. Another account that signs in to VS Code cannot open it and does not see it (its first Start of the repository creates its own environment), and the repository list of one account is never shown to another. All environments are Docker volumes of the same user of your computer, so this protects against using the wrong account, not against another person who can use your user account.
- Git in the environment uses only its own configuration, and the token of the account that owns the environment, like a codespace: the extension writes the token into the environment (`/workspaces/.devenv+/github-token`, readable only by the user of the container) at each start. The GitHub CLI (`gh`) in the environment is signed in with the same account and token (`/workspaces/.devenv+/gh/hosts.yml`, written at each start), so you never sign in to GitHub inside the environment. When a window leaves an environment because you signed out or another account signed in, the extension removes the token file and the sign-in of the GitHub CLI from the environment, also when its container is stopped. Otherwise the token stays in the volume, also after you sign out of GitHub in VS Code, until the next open replaces it or **Delete** removes the volume. Docker keeps volumes on the disk of your computer: with Docker Desktop in its disk image, which stays after Docker Desktop is uninstalled unless its data is removed, and on Linux under `/var/lib/docker/volumes`, readable by root. A sign-out in VS Code may not make the token invalid on GitHub. To make a stored token invalid, revoke the access of VS Code in the GitHub settings (Applications). The Git configuration, the Git credentials, the Docker credentials, and the SSH agent of your computer are not used by Git in the environment, and the Dev Containers extension does not copy your Git configuration into it or sign in its GitHub CLI with your token (settings for this container only). Credential helpers for other Git servers, for example a server of your company, go into `/workspaces/.devenv+/credentials.gitconfig` in the environment. Your other dev containers are not changed.
- The token is used in the helper container for the download of the repository, as a temporary file in memory, and to write the token file of the environment. It is never on a command line, in an environment variable, or in a log.
- For a private image on ghcr.io that Docker has no sign-in for, the extension gives Docker the GitHub session (scope `read:packages`) for the download of the image, in a temporary file that it removes after the download. It does this only when the connection to Docker is local or encrypted (a local socket, SSH, or TCP with TLS verification); otherwise it does not send the sign-in.
- The stored lists contain metadata only, for example repository names, branch names, image names, numbers of changes, and the GitHub account of each environment.
- The first open of a repository that does not belong to you or to one of your organizations asks for a confirmation, because it runs code from that repository.
- The extension collects no telemetry.

## Build

```sh
npm install
npm run build         # bundles dist/extension.js and dist/sessionMonitor.js
npm test              # unit tests, without VS Code and without Docker
npm run test:docker   # integration tests against the running Docker engine
npm run package       # creates the .vsix file
npm run install-local # creates the .vsix file and installs it into every VS Code profile
                      # (every window, also new ones of a debug run); -- --profile <name> installs into one profile
```

© 2026 Hannes Stauss (scalarion@nimblescape.com) · [MIT License](https://github.com/nimblescape/vscode-dev-environments/blob/main/LICENSE).
