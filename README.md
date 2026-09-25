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
- `initializeCommand` runs in a helper container, not directly on your computer.
- Only data in the repository volume survives a rebuild. Data in other folders of the container, for example the home folder, is lost, unless the configuration stores it in an additional named volume (property `mounts`).
- Work that runs in the container after its window has closed, for example a long build in a terminal, ends when the container stops.
- On Linux with Docker Engine, the extension cannot start the Docker service, because this needs administrator rights.
- Docker Compose configurations are not supported yet.

## Privacy

- The extension uses the GitHub sign-in of VS Code. VS Code stores the session. The extension does not store your token.
- The token is used in the helper container only for the download of the repository, as a temporary file in memory.
- For a private image on ghcr.io that Docker has no sign-in for, the extension gives Docker the GitHub session (scope `read:packages`) for the download of the image, in a temporary file that it removes after the download.
- The stored lists contain metadata only, for example repository names, branch names, image names, and numbers of changes.
- The first open of a repository that does not belong to you or to one of your organizations asks for a confirmation, because it runs code from that repository.
- The extension collects no telemetry.

## Build

```sh
npm install
npm run build     # bundles dist/extension.js and dist/sessionMonitor.js
npm test          # unit tests, without VS Code and without Docker
npm run package   # creates the .vsix file
```
