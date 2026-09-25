# Dev Environments

Open your GitHub repositories in local dev containers with one action.

Dev Environments lists the GitHub repositories that you can access and that contain a Dev Container configuration. **Start** opens a repository in a container on your computer, in the current window. The extension does the rest for you:

- It starts Docker when Docker is not running.
- It downloads the repository into a Docker volume. Your work stays in this volume when the container is created again.
- Before each connection, it checks for a newer container image and updates the environment if one exists. Without internet access, it skips this check and uses the local image.
- When you close the window, it stops the container after a short waiting time.
- When VS Code starts again, it opens the last environment.

## Requirements

- Visual Studio Code 1.90 or later.
- Docker: Docker Desktop on macOS, Windows (with WSL 2), or Linux, or Docker Engine on Linux.
- A GitHub account.
- The Dev Containers extension. You do not need to install it yourself: VS Code installs it together with this extension.

Git on your computer is not needed.

## How to use it

1. Select the **Dev Environments** icon in the activity bar.
2. Select **Sign in with GitHub**. The list shows your repositories with a Dev Container configuration, grouped by owner.
3. Use the actions of a repository:
   - **Start**: creates the environment on the first use (this can take several minutes), starts the container, and connects the current window.
   - **Stop**: stops the container at once. Your files are kept.
   - **Delete**: removes the container and the volume with the repository, after you confirm it. If the volume has uncommitted changes, unpushed commits, or stashes, the confirmation shows them.
   - **⋯**: Switch Branch…, Select Configuration… (only for repositories with several configurations), Rebuild, and Show on GitHub.
4. To go to another environment, use **Dev Environments: Switch Environment…** (`Ctrl+Alt+E`, on macOS `Cmd+Alt+E`), or select the status bar item. The same window connects to the other environment.

**Search** and **Refresh** are at the top of the view. **Dev Environments: Show Log** opens the complete log.

## Settings

| Setting | Default | Description |
|---|---|---|
| `devEnvLauncher.reopenLastOnStartup` | `true` | Open the last used environment when VS Code starts. |
| `devEnvLauncher.stopOnClose` | `true` | Stop the environment when no window uses it. If `false`, the container keeps running. |
| `devEnvLauncher.waitingTimeSeconds` | `30` | Waiting time in seconds before a stop. It prevents a stop during a window reload. |
| `devEnvLauncher.updateImagesOnConnect` | `true` | Check for newer images at each connection. |
| `devEnvLauncher.respectShutdownActionNone` | `false` | If `true`, a repository with `"shutdownAction": "none"` keeps its container running after close. |
| `devEnvLauncher.owners` | `[]` | Show only repositories of these accounts or organizations. An empty list shows all. |
| `devEnvLauncher.includeArchived` | `false` | Show archived repositories. |
| `devEnvLauncher.includeForks` | `true` | Show forked repositories. |
| `devEnvLauncher.refreshIntervalMinutes` | `60` | Interval in minutes of the background update of the repository list. |

## Known limits

- The first open of a repository needs internet access: for the download of the repository and of the images.
- The repository is in a Docker volume, not in a folder on your computer. Other programs on your computer cannot open the files directly.
- Configurations that mount files of the repository from your computer (variable `${localWorkspaceFolder}`) do not work, because the repository is not in a folder on your computer.
- Configurations that need access to your computer are refused, with a message that names each setting: bind mounts (also of the Docker socket), privileged mode, devices, other capabilities and security options, the namespaces of the computer, the network of another container (`--network container:…`), and `initializeCommand`. Options of `runArgs` and `build.options` that the extension does not know are refused too, with a message of their own (`--platform` and `--tmpfs` are allowed). The container can use the network, also a VPN of your computer; its ports reach your computer only on localhost (VS Code port forwarding, and published ports on `127.0.0.1`), and URLs open in your browser. Exception: with `--network host`, the container uses the network of your computer, and a server in the container that listens on all addresses (`0.0.0.0`) can also be reached from your network, as a server on your computer itself.
- Values of `${localEnv:…}` variables of your computer are not passed to the environment. They are empty or have their default value; `HOME`, `PATH`, `HOSTNAME`, `NODE_VERSION`, and `YARN_VERSION` get the values of the workspace helper (for example, `HOME` is `/root`).
- Git in the container older than version 2.32 reads the Git configuration of the environment only through `~/.gitconfig`, which the image must not bring itself. Git older than version 2.9 may use the Git credentials of your computer; the extension warns about it.
- The Dev Containers extension and VS Code keep some channels to your computer open, for example the SSH agent socket, the opening of URLs, and the clipboard. For full isolation, use a separate user account on your computer or a virtual machine.
- Only data in the repository volume survives a rebuild, and also when an update of the extension sets the container up again (the progress says so). Data in other folders of the container, for example the home folder, is lost, unless the configuration stores it in an additional named volume (property `mounts`).
- A repository that has an environment of another GitHub account on your computer shows "Environment of another account": your account cannot create its own environment of it, because the extension keeps one environment per repository.
- Work that runs in the container after its window has closed, for example a long build in a terminal, ends when the container stops.
- On Linux with Docker Engine, the extension cannot start the Docker service, because this needs administrator rights.
- Docker Compose configurations are not supported yet.

## Privacy

- The extension uses the GitHub sign-in of VS Code. VS Code stores the session. The extension keeps your token out of its settings and stored lists. It writes the token only into the Docker volume of each environment of your account (see below).
- An environment belongs to the GitHub account that created it. Another account that signs in to VS Code cannot open it and does not see it (the row of the repository only says "Environment of another account"), and the repository list of one account is never shown to another. All environments are Docker volumes of the same user of your computer, so this protects against using the wrong account, not against another person who can use your user account.
- Git in the environment uses only its own configuration, and the token of the account that owns the environment, like a codespace: the extension writes the token into the environment (`/workspaces/.devenv+/github-token`, readable only by the user of the container) at each start. When a window leaves an environment because you signed out or another account signed in, the extension removes the token file from the running container. Otherwise the token file stays in the volume, also after you sign out of GitHub in VS Code, until the next open replaces it or **Delete** removes the volume. Docker keeps volumes on the disk of your computer: with Docker Desktop in its disk image, which stays after Docker Desktop is uninstalled unless its data is removed, and on Linux under `/var/lib/docker/volumes`, readable by root. A sign-out in VS Code may not make the token invalid on GitHub. To make a stored token invalid, revoke the access of VS Code in the GitHub settings (Applications). The Git configuration, the Git credentials, the Docker credentials, and the SSH and GPG agents of your computer are not used by Git in the environment. Credential helpers for other Git servers, for example a server of your company, go into `/workspaces/.devenv+/credentials.gitconfig` in the environment. Your other dev containers are not changed.
- The token is used in the helper container for the download of the repository, as a temporary file in memory, and to write the token file of the environment. It is never on a command line, in an environment variable, or in a log.
- For a private image on ghcr.io that Docker has no sign-in for, the extension gives Docker the GitHub session (scope `read:packages`) for the download of the image, in a temporary file that it removes after the download.
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
```
