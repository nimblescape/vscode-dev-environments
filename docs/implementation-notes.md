# Implementation Notes — Version 1

These notes add the technical decisions that the concept ([vscode-dev-environments.md](vscode-dev-environments.md)) leaves open. The concept is the source of the requirements. If a note and the concept differ, the concept wins, and the note must be corrected.

## 1. Scope

- Phase 1 and phase 2 of the concept (section 12), except Docker Compose configurations. For a Docker Compose configuration (`dockerComposeFile`), the extension shows the message "Docker Compose configurations are not supported yet."
- Not in scope: phase 3 (profile template, backup of unpushed work, `build.cacheFrom`, Podman).
- The verification tasks V-1 to V-12 are not done yet. Code that depends on an unverified assumption has a comment `// Assumption (V-n): …`, so that a later check can find it.

## 2. Technology

| Item | Decision |
|---|---|
| Language | TypeScript, `strict: true`, target ES2022, module CommonJS |
| Bundler | esbuild. Two bundles: `dist/extension.js` (external: `vscode`) and `dist/sessionMonitor.js` (plain Node.js, no `vscode`). |
| Runtime dependencies | None. Use the Node.js modules `https`, `child_process`, `fs`, `crypto`, `os`, `path`. The Dev Container CLI is not a dependency of the extension: it is installed in the workspace helper image. `package.json` lists `@devcontainers/cli` as an exact devDependency only to pin this version: the build passes it to the code as `__DEVCONTAINER_CLI_VERSION__`, and the package is neither bundled nor shipped. So Dependabot proposes each new CLI version in a pull request of its own, and the contract tests (the options and the lifecycle error text, against the package) and `npm run test:docker` check it before a release. |
| Tests | vitest. Unit tests run without VS Code and without Docker. |
| VS Code API | `engines.vscode` `^1.90.0`, `@types/vscode` of the same version |
| Package | `@vscode/vsce` creates the VSIX file (decision D-6: private VSIX) |

**Layering rule.** Code in `src/core/` never imports `vscode`. It receives everything it needs through interfaces (process runner, file system paths, logger, clock). Code in `src/vscode/` adapts VS Code to these interfaces. The Session Monitor bundle uses only `src/core/` and `src/monitor/`. So most of the logic can be tested without VS Code.

## 3. Extension manifest

| Field | Value |
|---|---|
| `name` / `displayName` / `publisher` | `vscode-dev-environments` / `Dev Environments` / `nimblescape` |
| `extensionKind` | `["ui"]` |
| `extensionDependencies` | `["ms-vscode-remote.remote-containers"]` — **required**. The extension must declare its dependency on the Dev Containers extension explicitly. It uses this extension to connect a window to a container (concept 7.8). |
| `activationEvents` | `onStartupFinished`, `onResolveRemoteAuthority:attached-container` |
| View container | Activity bar, id `devEnvironments`, title "Dev Environments", one view `devEnvironments.repositories` (concept 6.2) |
| Settings | Exactly the settings of concept section 8, prefix `devEnvLauncher` (working name, decision D-1) |
| Command category | "Dev Environments" |
| Commands | `devEnvironments.start`, `.stop`, `.delete`, `.switchBranch`, `.selectConfiguration`, `.rebuild`, `.showOnGitHub`, `.switchEnvironment` (keybinding `ctrl+alt+e`, on macOS `cmd+alt+e`), `.refresh`, `.search`, `.showLog`, `.signIn` |

## 4. Local storage

All files are in the global storage folder of the extension (`context.globalStorageUri.fsPath`), on the local computer.

| File | Content | Writers |
|---|---|---|
| `registry.json` | Environment Registry (concept 7.5) | windows, Session Monitor |
| `repositories.json` | Stored result of the discovery (concept 7.4) | windows |
| `sessions/<window-id>.json` | Window status file (concept 7.9) | one window |
| `pending/<environment-id>.json` | Pending connection file (concept 7.9) | windows |
| `operations/<environment-id>.json` | Pending operation, for example `rebuild` (concept 7.14) | windows |
| `disconnect/<environment-id>.json` | Request from a window to the window that is connected to the environment: close the connection first, then hand off the stop, rebuild, or delete (concept 6.2, 7.14). Dropped after 60 seconds. | windows |
| `reopen.json` | Reopen record (concept 7.10) | windows |
| `monitor.json` | Settings for the Session Monitor: waiting time, `stopOnClose` | windows |
| `monitor.lock` | Process ID of the running Session Monitor | Session Monitor |
| `monitor.log` | Log of the Session Monitor (the process has no output channel), at most about 1 MB | Session Monitor |
| `helper.json` | State of the workspace helper images (section 7): per helper tag the base image and its digest at the build, `builtAt`, `checkedAt`, `lastUsedAt`; the time of the last cleanup | windows |

Rules:
- Every JSON write is atomic: write a temporary file in the same folder, then rename it.
- Read-modify-write of `registry.json` happens under a lock (a lock folder created with `mkdir`, removed after the write; a lock older than 10 seconds counts as stale).
- `deactivate()` uses only synchronous file writes.

## 5. Names and labels

- Environment ID: `crypto.randomUUID()`. Short ID: the first 8 characters.
- Volume and container name: `devenv-<owner>-<repository>-<short id>`, lower case, only `[a-z0-9_.-]`, at most 63 characters.
- Environment image: `devenv-<short id>:<build number>`.
- Labels on the volume: `devenv.environment-id`, `devenv.repository`. The container gets `devenv.environment-id` through the CLI option `--id-label`.

## 6. Docker

- **Finding the CLI.** The extension host on macOS often has a short `PATH`. Search `PATH`, then `/usr/local/bin`, `/opt/homebrew/bin`, `/Applications/Docker.app/Contents/Resources/bin` (macOS), and `C:\Program Files\Docker\Docker\resources\bin` (Windows). While the CLI is missing (or cannot be started), the extension searches again, at most every 10 seconds, so a Docker installed while VS Code runs is found without a reload.
- **Docker start** as in concept 7.6: `docker info` as the check; `docker desktop start`, and the fallbacks per platform; on Linux with Docker Engine, only the message with `sudo systemctl start docker`. Repeat `docker info` every 2 seconds for at most 2 minutes.
- **Docker socket for the workspace helper:** mount `/var/run/docker.sock` to `/var/run/docker.sock`. This path works with Docker Desktop on macOS, Windows, and Linux, and with Docker Engine. If `DOCKER_HOST` is a `unix://` path, mount that path instead — only on Linux with Docker Engine: with Docker Desktop, the engine runs in a virtual machine, so a path of the computer is not a path of the engine, and the helper always mounts `/var/run/docker.sock`.

## 7. Workspace helper

- **Image.** `resources/helper/Dockerfile`, with `ARG BASE_IMAGE=node:24-trixie-slim` (Node.js 24 LTS on Debian 13). It installs `git`, `ca-certificates`, `openssh-client`, the Docker CLI and the buildx plugin (Debian packages `docker-ce-cli` and `docker-buildx-plugin` from `download.docker.com`), and `@devcontainers/cli` in a pinned version. It sets `git config --system --add safe.directory '*'`, because the helper runs as root on files of another user.
- **Tag.** `devenv-helper:<first 12 characters of sha256(Dockerfile content + CLI version)>`, label `devenv.helper=true`. The extension builds the image when this tag is missing (first use, and after an extension update that changes the Dockerfile or the CLI version), with `--pull` (without it when the registry does not answer). **Refresh:** at most once a week per tag, the open pipeline reads the registry digest of the base image, with the registry client, the credentials, and the 5-second limit of the image check (section 9), and compares it with the digest in `helper.json`. When it changed, the extension builds the same tag again with `--pull --no-cache` (new base image, Debian packages, and Docker CLI) and removes the previous image if it has no tag anymore. No answer from the registry keeps the image and checks again at the next open; a failed build keeps the image (Docker moves the tag only after a successful build) and checks again a week later. An image built before the digest was recorded gets the current digest, without a build. **Cleanup:** at most once a day, of the images with the label `devenv.helper=true`, except the image of the current tag, the extension removes dangling images and helper tags that no window used for 7 days (`lastUsedAt`, written at most once an hour). A helper tag that `helper.json` does not know first gets 7 days of grace, so a helper that old windows of another extension version still use is not removed and built again in a loop. Tags of other repositories are never removed, and never with force; a failed removal (for example an image that a helper container uses) is logged and tried again at the next cleanup. Two windows can do this at the same time: each write of `helper.json` is atomic, and the file is advisory, so at worst a check or a build runs twice.
- **Run.** Each helper run is `docker run --rm -i` with the workspace volume at `/workspaces` and the label `devenv.helper-run=true`. Only the Dev Container CLI runs (read-configuration, build, up) also get the Docker socket and the cache volume `devenv-helper-cache` (Features cache, to verify in V-10). Git runs (clone, switch branch, Git summary) and the file-reading scripts get neither, because Git runs programs that the repository configuration names (filter drivers). Runs that need no network (Git summary, reading and listing configurations) use `--network none`.
- **Token for the clone.** The token never appears on a command line, in an environment variable of the container, in the volume, or in `.git/config`. The helper receives it on standard input, writes it to a `tmpfs` mount, and a Git credential helper reads it from there. The remote URL is `https://github.com/<owner>/<repository>.git`.
- **Ownership.** The helper clones as root. Otherwise the user in the container cannot write the files, so the extension changes the owner of the files that belong to another user (`find … -exec chown`) to the user and group of `remoteUser`: before the first `devcontainer up` of a new clone, in a short-lived container of the environment image (the remote user comes from its label `devcontainer.metadata`), because `onCreateCommand` and `postCreateCommand` run during `up` as that user; and after each creation of a container, as root in the dev container.
- **`${localEnv:NAME}`.** The extension finds these variables in the text of `devcontainer.json` and passes their local values to the helper with `-e NAME=value`.
- **Properties that need the computer** (`${localWorkspaceFolder}`, bind mounts of local folders): the extension shows a clear message (concept RK-10).

## 8. Dev Container CLI calls (in the helper)

| Step | Call |
|---|---|
| Read configuration | `devcontainer read-configuration --workspace-folder /workspaces/<repo> --config <config path>` |
| Build environment image | `devcontainer build --workspace-folder /workspaces/<repo> --config <config path> --image-name devenv-<short id>:<n>` |
| Create or start container | `devcontainer up --workspace-folder /workspaces/<repo> --override-config <override file> --id-label devenv.environment-id=<id> --skip-post-attach` (plus `--remove-existing-container` when the container is replaced) |

- The override configuration is the complete configuration for `up` (the CLI uses it instead of the repository configuration). It contains only: `image`, `workspaceMount`, `workspaceFolder`, `runArgs` (repository values plus `--name <container name>`), `appPort`, `shutdownAction: "none"` (concept 7.6). Everything else comes from the label `devcontainer.metadata` of the environment image.
- `--skip-post-attach`: the Dev Containers extension runs `postAttachCommand` when it attaches (to verify in V-1).
- All calls get `--user-data-folder /devenv-cache` (the cache volume). `up` also gets `--update-remote-user-uid-default never`, because the CLI runs as root in the helper and would otherwise build an extra image at each container creation. `build` gets `--no-lockfile` unless the repository has a `devcontainer-lock.json`, so the build does not add a file to the repository.
- The last line of standard output of `build` and `up` is a JSON result (`outcome`, `imageName`, `containerId`, `remoteUser`, `remoteWorkspaceFolder`). All other output goes to the output channel.
- When a lifecycle command fails, `up` exits with code 1 and the result `{ outcome: 'error', containerId, description: '… from … failed.' }` (to verify in V-10). If that container runs, the helper keeps it, and the open continues with a warning, as with the Dev Containers extension. The remote user then comes from the label `devcontainer.metadata` of the image.
- The config hash (`configHash`) is `sha256` of the text of `devcontainer.json` plus the text of the Dockerfile, if there is one.

## 9. Image check

- **References** (concept 7.7): `image`; each `FROM` of the Dockerfile (with `ARG` values from `build.args` and from `ARG` defaults; without references to earlier stages and without `scratch`); each Feature key that is an OCI reference. Local Features (`./…`), tarball URLs, and references with `@sha256:` are not checked.
- **Normalization:** Docker Hub is `registry-1.docker.io`, official images get the prefix `library/`, and the default tag is `latest`.
- **Request:** `HEAD /v2/<name>/manifests/<tag>` with the `Accept` types for OCI index, Docker manifest list, Docker manifest v2, and OCI manifest. The digest comes from the header `Docker-Content-Digest`.
- **Authentication:** first without credentials. On `401`, read `WWW-Authenticate: Bearer realm=…,service=…,scope=…` and request a token, with Basic credentials if Docker has credentials for this registry (`~/.docker/config.json`: `auths`, `credsStore`, `credHelpers`; credential helpers through `docker-credential-<name> get`). For `ghcr.io`, the fallback is the GitHub session with the scope `read:packages`, requested only when needed (concept 7.7). The `docker pull` of such an image uses the same session: the extension writes it to a temporary Docker config folder (`docker --config`, mode 0700, removed after the pull) and passes the endpoint of the current Docker context as `DOCKER_HOST`.
- **Time limit:** all requests of one connection run in parallel under one `AbortController` with 5 seconds (NFR-08). If one registry does not answer, the whole update step is skipped (FR-13).
- **Proxy:** use the Node.js `https` module. VS Code applies its proxy settings to this module in the extension host.
- **Build record:** it stores the digests that the check read right before the build. The comparison uses the build record, not the local images (concept 7.7).

## 10. Git operations

| Purpose | Commands (in the helper on the volume, or with `docker exec` in a running container) |
|---|---|
| Branch | `git branch --show-current` |
| Uncommitted files | `git status --porcelain` (count of lines) |
| Unpushed commits | `git rev-list --count HEAD --branches --not --remotes` (HEAD and all local branches, so it includes branches left by Switch branch…, concept 7.5 / 7.14 step 1; with an unborn HEAD only `--branches`) |
| Stashes | `git stash list` (count of lines) |
| Switch branch | `git fetch https://github.com/<owner>/<repository>.git '+refs/heads/*:refs/remotes/origin/*'` (the same result as `git fetch origin`, but a changed remote in `.git/config` cannot redirect the token), then `git switch <branch>` |

## 11. Connection to the container

- Folder URI: `vscode-remote://attached-container+<hex of {"containerName":"/<container name>"}><remoteWorkspaceFolder>` (to verify in V-2).
- Open with `vscode.openFolder` and `forceNewWindow: false`, always in the current window.
- "Close Remote Connection" is the command `workbench.action.remote.close`.

## 12. Session Monitor

- Start: `child_process.spawn(process.execPath, [<dist/sessionMonitor.js>, <global storage path>], { detached: true, stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } })`, then `unref()`.
- The decision logic (rule 1, rule 2, sleep rule of concept 7.9) is a pure function in `src/monitor/rules.ts`, with unit tests for every row of the table "Results for typical situations".
- A process is alive if `process.kill(pid, 0)` does not throw `ESRCH`.
- The Session Monitor never starts Docker. If `docker info` fails, no container runs, and it does nothing.

## 13. User interface

- Texts: exactly the texts of the concept where it gives them (section 6.5), plain language (NFR-02).
- Progress: one notification with the steps of concept 6.5, and a button **Show details** for the output channel "Dev Environments".
- Tree: groups by owner, rows as in concept 6.2. `contextValue` lists the possible actions, for example `repository;canStart;canDelete;multiConfig`, and the menus use `viewItem =~ /canStart/`.
- While an environment is Updating, Start, Stop, and Rebuild are hidden (concept 7.9 rule 1). Delete stays (concept 7.15), except while the operation is itself a delete: after the confirmations, it waits until the operation of the other window has ended, in a progress notification with Cancel.
