# Dev Environments

Open your GitHub repositories in local dev containers with one action.

Dev Environments lists the GitHub repositories that you can access and that contain a Dev Container configuration. **Start** opens a repository in a container on your computer, in the current window. **Start in New Window** opens it in a new window instead, so you can work in several environments at the same time. The extension does the rest for you:

- It starts Docker Desktop when it is not running. Docker Engine on Linux needs administrator rights: the extension asks to start it.
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
   - **Keep Running When Closed** (context menu of a repository with an environment, and **⋯**): the environment keeps running when no window uses it, for example for a server or an AI agent that works on after you close the window or quit VS Code. The row then shows `Running · kept`. Only **Stop** or **Delete** stops it; after a **Stop** it is still kept. **Stop When Closed** switches back: the container stops again after the waiting time. The choice is stored with the environment and survives restarts. Both commands are also in the Command Palette, with a list of your environments.
   - **⋯**: Switch Branch…, Select Configuration… (only for repositories with several configurations), Rebuild, and Show on GitHub.
4. To go to another environment, use **Dev Environments: Switch Environment…** (`Ctrl+Alt+E`, on macOS `Cmd+Alt+E`), or select the status bar item. The same window connects to the other environment. **Dev Environments: Switch Environment in New Window…** opens the selected environment in a new window.

**Select Organizations…**, **Search**, and **Refresh** are at the top of the view. **Select Organizations…** limits the list to the organizations and accounts that you select: only their repositories are scanned, which is faster when you can access many repositories. Select none to see all repositories again. **Dev Environments: Show Log** opens the complete log.

The first load of the list can take some time with many repositories; the view shows the repositories as they arrive. Later updates read only the repositories that changed.

## Installing Docker

When Docker is not installed, the view shows no repositories, but the steps to set Docker up, each with its button: on Windows **Install WSL 2**, then **Install Docker**. After the installation, your repositories appear in the view, and Docker is started when it is needed. The steps:

1. On Windows: **Install WSL 2** (`wsl --install`; restart the computer afterwards). Once WSL 2 is ready, the view shows "✓ WSL 2 is installed." instead of the button.
2. **Install Docker**:
   - macOS: with Homebrew, `brew install --cask docker-desktop`; without Homebrew, the installer `Docker.dmg` is downloaded from Docker and opens (drag Docker to Applications).
   - Windows: with winget, `winget install --exact --id Docker.DockerDesktop …`; without winget, `Docker Desktop Installer.exe` is downloaded from Docker and starts.
   - Linux (Ubuntu, Debian, Fedora, RHEL, CentOS): Docker Engine from the package repository of Docker, and your user joins the group `docker` (sign in again afterwards). Other distributions: the installation guide of Docker opens.
3. Docker starts by itself when an environment needs it. Right after the installation, a notification also offers **Start Docker**. At its first start, Docker Desktop shows its own dialogs once. On Linux, **Start Docker** runs `sudo systemctl enable --now docker` in a terminal to start the Docker service.
4. **Sign in with GitHub** (the button below the steps, while you are not signed in).

Nothing runs without your confirmation: a dialog first lists the exact commands, or the download address and the file. Commands run visibly in a terminal of VS Code, where you enter your password if one is needed. Downloads come only from Docker over HTTPS, and the installers are signed by Docker; your system checks the signature when the installer opens. Settings of the opened workspace do not change what runs in the terminal. If Docker is installed already, nothing is installed. Docker Desktop is free for personal use, education, non-commercial open source projects, and small businesses; larger companies need a paid subscription (Docker Subscription Service Agreement). The installation works only in a local window, not in a remote window.

## Settings

| Setting | Default | Description |
|---|---|---|
| `devEnvLauncher.reopenLastOnStartup` | `true` | Open the last used environment when VS Code starts. |
| `devEnvLauncher.openInNewWindow` | `false` | If `true`, **Start** and **Switch Environment…** open the environment in a new window, and the current window keeps its environment. The context menu then offers **Start in Current Window**, and the Command Palette **Switch Environment in Current Window…**. From an empty window, **Start** uses that window. Only the user settings count. |
| `devEnvLauncher.stopOnClose` | `true` | Stop an environment when no window uses it (window closed, VS Code quit, or **Close Remote Connection**), after the waiting time. If `false`, all environments keep running. To keep only some environments running, use **Keep Running When Closed** on them. |
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
- The preview and the test stop after 1 second: a regular expression that takes longer for your repository names is marked as too slow and cannot be saved, because the view would become slow with it. If the check fails, Save is not possible either.
- **Save** writes only this one setting in your user `settings.json`: it replaces the value of `devEnvLauncher.repositoryGroups` with the entries of the editor, and your other settings and comments stay as they are.
- If this setting changes in `settings.json` while the editor is open, the editor says so: "settings.json changed this setting." with **Load settings.json**. The entries in the editor stay until you choose; the editor never replaces them on its own.
- If you save after such a change, the editor shows the current list of `settings.json` and asks: **Load settings.json** shows that list and drops your unsaved edits; **Save Mine** replaces that one value with your entries; **Cancel** changes nothing and keeps your edits. Entries are never merged one by one. If `settings.json` changes again while this question is open, it asks again. If the value in `settings.json` is not a list, Save asks the same way before it replaces it.
- **Cancel**, or closing the tab, discards your changes; a Save that is still waiting then writes nothing.

## Security: what to expect

**A repository that you open is code that you run.** A malicious dev container can do harm. Its Dockerfile and build, its Features, its lifecycle commands, and the extensions in its container run with the rights of the container. They can:

- use the network: the internet, your local network, a VPN of your computer, and the services of your computer through `host.docker.internal`;
- attack the kernel, which every container shares with your computer (with Docker Desktop: with its virtual machine);
- use the channels that VS Code keeps open to your computer: the SSH and GPG agents, a socket that answers requests for your Git and Docker credentials, the opening of URLs, the clipboard, and your X11 display when one is set (see [Hardening your computer](#hardening-your-computer));
- read and change the repository, and use the GitHub token of the environment. The token can read and change the repositories that your account can access, and read your organization memberships (scopes `repo` and `read:org`).

The user in the container is chosen by the repository (`remoteUser`, `containerUser`, or the image), often a user without root rights that can use `sudo`. Dev Environments does not change it.

**What Dev Environments does.**

- Docker isolation:
  - Each environment runs in containers of its own. The repository is in a Docker volume, not in a folder of your computer.
  - Dev Environments mounts no file or folder of your computer into the container.
  - Published ports are bound to `127.0.0.1` while the checks are on, so your network cannot reach them.
  - The containers and volumes of an environment carry its labels. Dev Environments uses them to find what belongs to each environment, and the checks use them to refuse the volumes and networks of other environments.
- Checks of the configuration, on by default, with a switch per repository. Before a container is created, Dev Environments checks the configuration, its Features, the base image, and every service of Docker Compose. It refuses, with a message that names each setting: bind mounts of your files (also of the Docker socket), privileged mode, capabilities beyond Docker's default set and `SYS_PTRACE`, other security options than `seccomp=unconfined` and `no-new-privileges`, devices and GPUs, the namespaces of your computer, ports on all network addresses, the volumes of other programs and other containers, and the network of another container.
- Refused whatever the switch says: the volumes, named networks, and images of other environments (also of other GitHub accounts); the processes of other containers, and their volumes through `--volumes-from` or `volumes_from`, also of the dev container for the other services of Docker Compose; the folder with the GitHub token; the variables that set the Git configuration (`GIT_CONFIG` and `GIT_CONFIG_*`) or that Dev Environments sets (`GIT_SSH_COMMAND`, `DOCKER_CONFIG`, `GH_CONFIG_DIR`), and the token and host variables of the GitHub CLI (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST`); `initializeCommand`; and the labels of Dev Environments, the Dev Container CLI, and Docker Compose.
- The GitHub token is never in an environment variable, on a command line, or in a log. It is in a file of the environment's volume (mode 0600, owned by the user of the container). Every program in the container that runs as that user or as root can read it.
- For each container, Dev Environments switches off the copy of your Git configuration, the forwarding of your Git and Docker credentials, and the sign-in of the GitHub CLI with your token (settings of the Dev Containers extension for this container only).

**Limits.** The details are in [Container restrictions](docs/container-restrictions.md), section 10.

- The checks are a guard rail against mistakes and copied templates, not a sandbox. A crafted repository can get around them, for example through the way the Dev Container CLI rewrites a Dockerfile.
- All environments share one Docker. A repository can reach the local images and the build cache of other environments, also of other GitHub accounts. Do not open repositories that you do not trust on a computer where the environments of other accounts hold data that you need to protect.
- Every container reaches the ports on localhost of your computer through `host.docker.internal`, also the ports that VS Code forwards for other environments. Ports on `127.0.0.1` are protected against your network, not against other containers.
- The kernel is shared. A container is not a strong security boundary.
- The channels of VS Code stay open. Git in the environment does not use them, but a program that looks for them can.
- The checks allow `--network host`, `SYS_PTRACE`, and `seccomp=unconfined`. With `--network host`, the container uses the network of your computer, and a server in it that listens on all addresses can be reached from your network; on Linux with Docker Engine, it can also connect to local programs through their abstract Unix sockets (for example the X11 display and D-Bus).
- When the default runtime of your Docker is `nvidia`, the variable `NVIDIA_VISIBLE_DEVICES` gives a container your GPUs. It is not refused.
- For a Docker Compose build with Features, the user that the Dev Container CLI writes into its compose file is not checked.
- An `ENV` of an image, or an environment file of the repository, can set variables that the checks refuse in the configuration, for example `GH_TOKEN`.
- An image or a program in the container can change the settings of VS Code in the container, for example to forward ports on all addresses.
- The GitHub token of the environment is readable by every program in the container.
- With the checks off, a configuration can join the network of another container (`--network container:<name>`, `network_mode: container:`), also the dev container of another environment, and use the volumes of other containers.
- With the checks off, a configuration can use the Docker socket. It then controls Docker and every other environment, also their tokens.

Open only repositories that you trust. For others, use a virtual machine, or a separate user account with its own Docker (see [Hardening your computer](#hardening-your-computer)). A concept for a Docker in a virtual machine per GitHub account ([docs/concept-vm-isolation.md](docs/concept-vm-isolation.md)) describes a possible future direction; it is not planned.

## Known limits

- The first open of a repository needs internet access: for the download of the repository and of the images.
- The repository is in a Docker volume, not in a folder on your computer. Other programs on your computer cannot open the files directly.
- Configurations that mount files of the repository from your computer (variable `${localWorkspaceFolder}`) do not work, because the repository is not in a folder on your computer.
- While the host access checks are on, configurations that need access to your computer are refused, with a message that names each setting (see [Security: what to expect](#security-what-to-expect); the full list is in [Container restrictions](docs/container-restrictions.md)). Options of `runArgs` and `build.options` that the extension does not know are refused too, with a message of their own. Options that give no access to your computer are allowed, for example `--platform`, `--tmpfs`, `--cap-drop`, and `--read-only`; `--rm`, `-it`, and `-d` are removed, because Dev Environments runs the container itself; its log names them.
- The host access checks are on for every repository by default. For a repository that you trust, **Turn Off Host Access Checks…** in its context menu turns them off after a warning: its configuration, Features, and base image may then use the files of your computer (bind mounts), the Docker socket (which gives full control of Docker and of every other environment, also of other GitHub accounts), privileged mode, capabilities and security options, devices and GPUs, published ports on all network addresses (they are no longer bound to `127.0.0.1`), and the volumes of other programs. What stays refused is listed under [Security: what to expect](#security-what-to-expect). The row shows `host access unrestricted`, and the log says so at every start. **Turn On Host Access Checks** turns them on again: at the next start, a container that was made without them is made again, if the configuration passes the checks; otherwise the start stops with the usual message.
- Values of `${localEnv:…}` variables of your computer are not passed to the environment. They are empty or have their default value; `HOME`, `PATH`, `HOSTNAME`, `NODE_VERSION`, and `YARN_VERSION` get the values of the workspace helper (for example, `HOME` is `/root`).
- Git in the container older than version 2.32 reads the Git configuration of the environment only through `~/.gitconfig`, which the image must not bring with content of its own. Git older than version 2.9 may use the Git credentials of your computer; the extension warns about it.
- Only data in the repository volume survives a rebuild, and also when an update of the extension sets the container up again (the progress says so). Data in other folders of the container, for example the home folder, is lost, unless the configuration stores it in an additional named volume (property `mounts`).
- Each GitHub account has its own environment of a repository, with its own clone: two accounts that work on the same repository need the disk space for two clones. A configuration whose named volumes have a fixed name (or `${localWorkspaceFolderBasename}-…`) works for one account's environment only; use `${devcontainerId}` in the name to give each environment its own volume.
- Work that runs in the container after its window has closed, for example a long build in a terminal, ends when the container stops.
- On Linux with Docker Engine, the extension cannot start the Docker service by itself, because this needs administrator rights. **Start Docker**, in the notification after the installation and in the message "Docker is not running.", runs `sudo systemctl enable --now docker` in a terminal, where you enter your password. In a remote window, for example one connected over SSH, the message offers no **Start Docker**; it names the command to run.
- Docker Compose configurations (`dockerComposeFile` and `service`) start the dev container together with the other services, for example a database. The same checks apply to every service: published ports are bound to `127.0.0.1`, and only the dev container gets the repository volume. A service that mounts files or folders of the repository (for example `./init.sql`) gets them from the repository volume (Docker Engine 26 or newer) and can read and change them. Remote `include` and `extends` of compose files do not work. **Delete** removes the containers, networks, and images of the services; the volumes with their data (for example of a database) only when you tick them.
- With **Select Organizations…**, GitHub is asked only about the selected owners. Your environments of repositories of other owners stay in the list, but without the check whether the repository is still on GitHub. An environment created with an older version of Dev Environments that is not assigned to a GitHub account yet stays hidden while its owner is not selected.

## Hardening your computer

The Dev Containers extension and VS Code keep some channels from the container to your computer open (see [Security: what to expect](#security-what-to-expect)). Most of them cannot be switched off by a setting. A firewall does not help either: inside the container they are Unix sockets, files without an address or port, and between the container and your computer most of them travel inside the connection of the window (the `docker exec` stream through Docker). What you can do is keep things of value away from the end of each channel on your computer, and have your computer ask before it gives something out. Per channel:

**Git configuration, Git and Docker credentials, and the GitHub CLI.** Dev Environments already switches these off for its own containers: it sets `dev.containers.copyGitConfig` (also under the old key `remote.containers.copyGitConfig`), `dev.containers.gitCredentialHelperConfigLocation`, `dev.containers.dockerCredentialHelper`, and `dev.containers.githubCLILoginWithToken` for each container. To make this the default for your other dev containers too, put this into your user `settings.json`:

```json
"dev.containers.copyGitConfig": false,
"remote.containers.copyGitConfig": false,
"dev.containers.gitCredentialHelperConfigLocation": "none",
"dev.containers.dockerCredentialHelper": false,
"dev.containers.githubCLILoginWithToken": false
```

The socket that answers credential requests stays open, and a program in the container that looks for it can still ask. On macOS, the Git credential helper `osxkeychain` gives out the passwords it stored without asking; on Windows and Linux, the usual credential helpers do too. On macOS you can make it ask: for the items that matter, open Keychain Access, and in the item's **Access Control** select **Confirm before allowing access** and remove `git-credential-osxkeychain` from **Always allow access by these applications**. You then see a prompt for each read, and can deny it. At the prompt, choose **Allow** or **Deny**, not **Always Allow**, which adds the helper back. When Git stores the password anew, for example after a failed login, repeat these steps.

**SSH agent.** This is the biggest exposure. The Dev Containers extension forwards your SSH agent into every container when one runs as VS Code starts. There is no setting to turn this off; it is an open feature request ([#11413](https://github.com/microsoft/vscode-remote-release/issues/11413)). According to that request, `"SSH_AUTH_SOCK": ""` in `remoteEnv` does not stop it either. What works:

- On Linux, start VS Code without an agent: quit VS Code, then start it with `env -u SSH_AUTH_SOCK code`. This affects every window, also your local work.
- On macOS, this does not work: VS Code always gets the agent of your macOS login, so in effect the agent is always forwarded. Keep that agent empty (`ssh-add -D`), and do not use `AddKeysToAgent` or `UseKeychain` in `~/.ssh/config`, or `ssh-add --apple-load-keychain`. If you use another agent (for example 1Password), set it with `IdentityAgent` in `~/.ssh/config`, not by exporting `SSH_AUTH_SOCK` in a shell startup file: VS Code reads the environment of your shell when you start it from the Dock.
- On Windows, the agent is the service **OpenSSH Authentication Agent** (`ssh-agent`); it keeps the keys you add across restarts. Keep it empty with `ssh-add -D`, or stop it while you do not need it: in an administrator PowerShell, `Stop-Service ssh-agent` and `Set-Service ssh-agent -StartupType Manual` (its keys are back when it starts again). This agent does not support `ssh-add -c` or `ssh-add -t`.
- Or keep the agent, but have it ask (not with the Windows OpenSSH agent): `ssh-add -c` loads a key that needs your confirmation at each use. For this the agent needs an `ssh-askpass` program (macOS has none); without one, the key cannot be used. 1Password and Secretive can also ask for approval. Make sure they ask at each use: an approval that they remember, for an application or for a time, also lets programs in the container use the key.
- Load only the keys that you need, for a short time (not with the Windows OpenSSH agent): `ssh-add -t 1h`.

**GPG agent.** It is forwarded when the container has `gpg` and your computer runs an agent. Use short cache times in `gpg-agent.conf` (for example `default-cache-ttl 60` and `max-cache-ttl 600`), and add `no-allow-external-cache` so that the pinentry does not use the cache of a password manager. On macOS, pinentry-mac of GPG Suite ignores this option: it gives out a passphrase saved in Keychain without asking, whatever the cache time, and its **Save in Keychain** box is ticked again in each dialog. Switch saving off with `defaults write org.gpgtools.common DisableKeychain -bool yes`, then delete the passphrases already saved: in Keychain Access they are named after your key (for example `Name <email> (KEYID)`) and show `GnuPG` under **Where**. Or run `security delete-generic-password -s GnuPG` repeatedly until it finds none. Do not keep a key unlocked while a container that you do not trust is open.

**WSL and Wayland (Windows and Linux).** Two user settings of the Dev Containers extension:

- `"dev.containers.forwardWSLServices": false` stops forwarding the SSH and GPG agents of WSL. It does not stop the forwarding of the SSH agent of your computer, so also follow the steps for the SSH agent above.
- `"dev.containers.mountWaylandSocket": false` stops mounting your Wayland display (of WSL, or of your Linux desktop) into containers that the Dev Containers extension creates.

**X11 display.** When `DISPLAY` is set for VS Code, the Dev Containers extension forwards your X11 display into the container. This happens with XQuartz on macOS and on Linux; one report shows it on Windows with WSL 2 and Docker Desktop when `DISPLAY` was set in WSL ([#11599](https://github.com/microsoft/vscode-remote-release/issues/11599)). Whether it also happens for the windows of Dev Environments on Windows is not verified. A program in the container can then see and type into the windows of that display. There is no setting to turn this off; it is an open feature request ([#8031](https://github.com/microsoft/vscode-remote-release/issues/8031)).

- On macOS, XQuartz keeps `DISPLAY` set for your whole login and starts again when a program connects, so quitting it does not help. If you do not need XQuartz, uninstall it, then log out and in.
- On Linux, the X server is your desktop and cannot be quit. In a Wayland session, quit VS Code and start it with `env -u DISPLAY code --ozone-platform=wayland`; this should stop the forwarding. For your other dev containers, also set `"dev.containers.mountWaylandSocket": false` (see above): the Dev Containers extension mounts the Wayland display into the containers that it creates itself. Dev Environments creates its containers without this mount. On an X11 desktop, only a separate user account or a virtual machine helps (see Everything else).

**Ports, browser, and clipboard.** With `"remote.autoForwardPorts": false` and `"remote.localPortHost": "localhost"` (the default) in your user settings, VS Code forwards fewer ports on its own, and by default only on localhost. Extensions and some URLs can still forward ports. While its host access checks are on, Dev Environments refuses a configuration that sets another `remote.localPortHost`. An image or a program in the container can still set it in the settings of the container, which win over yours. No setting limits the opening of URLs in your browser; if this worries you, make a separate browser profile your default browser. No setting limits the clipboard either: do not copy secrets while a container that you do not trust is open.

**Everything else.** The only real boundary is a separate user account on your computer, or a virtual machine, for VS Code and Docker: then nothing of yours is at the end of the channels. On Linux, this separate account must not be in the group `docker` (which the Docker installation of Dev Environments adds your user to): that group gives root rights on the computer and access to the containers of all users. Give the account its own rootless Docker (Docker's "Rootless mode") instead, and select it as its setup recommends, with `docker context use rootless` in that account (or with `export DOCKER_HOST=unix:///run/user/<UID>/docker.sock`, `<UID>`: the output of `id -u` in that account, in a file that its login reads, for example `~/.profile`, or `~/.bash_profile` if that file exists, as on RHEL and CentOS; with zsh `~/.zprofile`; sign out and in afterwards): Dev Environments mounts the Docker socket into its helper container from the path in `DOCKER_HOST`, or, when `DOCKER_HOST` is empty, from the `unix://` path of the Docker context that the Docker CLI uses (`DOCKER_CONTEXT`, otherwise the current context), and otherwise from `/var/run/docker.sock`. In that account, do not use the Docker installation or **Start Docker** of Dev Environments, and do not add the account to the group `docker`: they set up the system Docker. Or use a virtual machine. With Docker Desktop, Enhanced Container Isolation (Business subscription) also hardens the container side.

## Privacy

- The extension uses the GitHub sign-in of VS Code. VS Code stores the session. The extension keeps your token out of its settings and stored lists. It writes the token only into the Docker volume of each environment of your account (see below).
- An environment belongs to the GitHub account that created it. Another account that signs in to VS Code cannot open it and does not see it (its first Start of the repository creates its own environment), and the repository list of one account is never shown to another. All environments are Docker volumes of the same user of your computer, so this protects against using the wrong account, not against another person who can use your user account.
- Git in the environment uses only its own configuration, and the token of the account that owns the environment, like a codespace: the extension writes the token into the environment (`/workspaces/.devenv+/github-token`, mode 0600, owned by the user of the container) at each start. The GitHub CLI (`gh`) in the environment is signed in with the same account and token (`/workspaces/.devenv+/gh/hosts.yml`, written at each start), so you never sign in to GitHub inside the environment. When a window leaves an environment because you signed out or another account signed in, the extension removes the token file and the sign-in of the GitHub CLI from the environment, also when its container is stopped. Otherwise the token stays in the volume, also after you sign out of GitHub in VS Code, until the next open replaces it or **Delete** removes the volume. Docker keeps volumes on the disk of your computer: with Docker Desktop in its disk image, which stays after Docker Desktop is uninstalled unless its data is removed, and on Linux under `/var/lib/docker/volumes`, readable by root. A sign-out in VS Code may not make the token invalid on GitHub. To make a stored token invalid, revoke the access of VS Code in the GitHub settings (Applications). The Git configuration, the Git credentials, the Docker credentials, and the SSH agent of your computer are not used by Git in the environment, and the Dev Containers extension does not copy your Git configuration into it or sign in its GitHub CLI with your token (settings for this container only). Credential helpers for other Git servers, for example a server of your company, go into `/workspaces/.devenv+/credentials.gitconfig` in the environment. Your other dev containers are not changed.
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
