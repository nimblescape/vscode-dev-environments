# Container restrictions

This document lists every restriction that Dev Environments applies to its dev containers, grouped by **who normally configures** the thing that the extension restricts. The requirements are in the concept ([vscode-dev-environments.md](vscode-dev-environments.md), section 9 "Host access" and "Accounts"); the technical decisions are in the [implementation notes](implementation-notes.md).

**Principle.** Nothing that configures the container may reach the computer, with three exceptions that the user decided to keep: the network (including VPN connections of the computer), ports of the container on `localhost` of the computer, and URLs that open in the computer's browser.

**Kinds of restriction.**

| Kind | Meaning |
|---|---|
| Refused | Start stops with a message that names each offending setting, before anything is pulled, built, or started. The workspace volume is kept. |
| Rewritten / removed | The extension changes the value in the override configuration that it gives to `devcontainer up`. |
| Neutralized | A channel still exists, but the extension makes the container ignore it (environment variables, files in the container). |
| Not passed | A value of the computer does not reach the workspace helper or the container. |

**Status.** "Planned" marks items that the user decided but that are not implemented yet (runArgs allow-list extension, `--rm`, one environment per repository and account, and the fixes of the open known gaps below). Everything else is implemented.

## 1. Repository author (`devcontainer.json`)

| What they normally configure | What the extension does | Kind |
|---|---|---|
| Bind mounts in `mounts` (string or object form). The Dev Container CLI turns each entry into `--mount` of `docker run`. | Every source that is a path of the computer is refused: it contains `/` or `\`, or starts with `.`, `~`, or a drive letter. This includes the Docker socket and `${localWorkspaceFolder}/…`. A text that Docker would parse differently is refused as a whole. | Refused |
| Other mount types in `mounts` | Named, anonymous, and tmpfs mounts are allowed. Refused: volumes of other environments (named like a workspace volume, `devenv-<name>-<8 hexadecimal characters>`; other `devenv-*` volumes of a repository are allowed), the helper's cache volume `devenv-helper-cache`, `volume-driver` and `volume-opt` (they can bind a folder of the computer), and the types npipe, image, cluster, and unknown types. | Refused |
| Mounts in `runArgs` (`-v`, `--volume`, `--mount`, in every spelling). The CLI appends `runArgs` unchanged to `docker run`. | The same rules as for `mounts`. | Refused |
| Devices, namespaces, and container sharing in `runArgs` | Refused: `--device`, `--device-cgroup-rule`, `--gpus`; `--pid`, `--ipc`, `--uts`, `--userns`, `--cgroupns` with any value; `--volumes-from`; `--network`/`--net container:<name>` (it joins another container's network, for example another environment's services). | Refused |
| Any other `runArgs` flag | An allow-list: `--init`, `--label`/`-l`, `--hostname`, `--env`/`-e`, `--env-file`, `--shm-size`, `--ulimit`, `--memory*`, `-m`, `--cpus`, `--user`, `--workdir`, `--name`, `--add-host`, `--dns*`, `--network`, `--platform`, `--tmpfs`, `--cap-add SYS_PTRACE`, `--security-opt seccomp=unconfined`, and `-p` on a loopback address. Everything else is refused, including stray arguments, entries that are not strings, and grouped short flags; flags that the policy does not know get a message of their own ("options that Dev Environments does not support"). The final `runArgs` of the override configuration are checked again before `up`. | Refused |
| (same) — planned | The allow-list is extended with flags that give no access to the computer: `--cap-drop`, `--read-only`, `--security-opt no-new-privileges`, `-i`, `-t`, `-it`, `-ti`, `--interactive`, `--tty`, `--group-add`, `--pids-limit`, `--stop-signal`, `--stop-timeout`, `--expose`, `--health-*`, `--oom-score-adj`. `--env-file` only inside `/workspaces`. `--runtime` and `--volume-driver` stay refused. | Allowed / refused |
| `--rm` in `runArgs` — planned | Removed from the `runArgs` of the override configuration, with a log line: the extension manages the container life cycle (stop, start, recreation). Today it is refused as an unknown flag. | Removed |
| `--name` in `runArgs` (without it, Docker picks a random name) | Removed, read with the same flag parser as the check (a `--name` that is the value of another flag stays); the extension adds `--name devenv-<owner>-<repository>-<short id>` at the end. | Removed |
| Published ports with an address (`appPort` strings, `-p`/`--publish`) | Every address outside `127.0.0.0/8` and `::1` is refused (for example `0.0.0.0`, `[::]`, `localhost`), and so are `-P`/`--publish-all` and `appPort` entries that are neither a number nor a string. | Refused |
| `build.options` (the CLI appends them unchanged to `docker build`) | Refused: `--secret`, `--ssh`, `--allow`, `--output`/`-o`, `--build-context` except `docker-image://` and `http(s)://`, stray arguments, unknown options. Allowed: `--network` (also `host`), `--add-host`, `--build-arg`, `--target`, `--label`, `--platform`, `--pull`, `--no-cache`. | Refused |
| `hostRequirements.gpu` (Dev Containers turns it into `--gpus all`) | Every value other than `false`, `null`, or absent is refused. The cpus, memory, and storage requirements are neither checked nor applied. | Refused |
| `initializeCommand` (Dev Containers runs it on the computer) | Refused (any non-empty value) and never passed to `up`: in the workspace helper it would run with the Docker socket. | Refused |
| `dockerComposeFile` | Refused: "Docker Compose configurations are not supported yet." | Refused |
| `workspaceMount` and `workspaceFolder` | Always the environment's named volume at `/workspaces`, with the folder `/workspaces/<repository>`; the repository's values are ignored. | Rewritten |
| `${localEnv:NAME}` and `${env:NAME}` (values of the computer) | Not passed. They resolve to their default, to an empty value, or to the helper's own value (`HOME=/root`, `PATH`, `HOSTNAME`, `NODE_VERSION`, `YARN_VERSION`). One warning names them, and those that get the helper's value. | Not passed |

## 2. Dev Container Feature author (`devcontainer-feature.json`)

| What they normally configure | What the extension does | Kind |
|---|---|---|
| `privileged` (for example docker-in-docker). It can also come from `devcontainer.json`, `runArgs`, or the image label; the CLI turns it on if any source sets it. | Refused for every value that counts as true, and `--privileged` with any value. | Refused |
| `capAdd` (the CLI adds the union of all sources as `--cap-add`) | Every capability except `SYS_PTRACE` is refused. | Refused |
| `securityOpt` (the CLI adds the union of all sources as `--security-opt`) | Every option except `seccomp=unconfined` is refused (`no-new-privileges`: allowed — planned). | Refused |
| `mounts` of a Feature (for example docker-outside-of-docker binds `/var/run/docker.sock`), `hostRequirements.gpu`, `initializeCommand` | Checked in the merged configuration (`devcontainer read-configuration --include-merged-configuration`) before any pull, build, or start. If the merged read fails (offline, or a private base image), only the repository configuration is checked before the build; the check of the environment image before `up` still catches the Features, but only after their install scripts ran. Install scripts and entrypoints are not restricted. | Refused |

## 3. Base image (`devcontainer.metadata` label)

| What they normally configure | What the extension does | Kind |
|---|---|---|
| The label `devcontainer.metadata` of the image in `image` or in the Dockerfile's `FROM` (for example prebuilt images with Features) | `mounts`, `privileged`, `capAdd`, `securityOpt`, `hostRequirements.gpu`, and `initializeCommand` are checked through the merged configuration before the build, and on the environment image before each container creation. `runArgs`, `appPort`, and build options in the label are ignored, as the CLI ignores them. | Refused |

## 4. Dev Container CLI

| What it normally does | What the extension does | Kind |
|---|---|---|
| Mounts the workspace as a bind mount of the local folder | The workspace is always the environment's named volume (see section 1). | Rewritten |
| Reuses the container that its id labels find | The extension adds `--label devenv.container-version=2`. A container without this label, or with an older value, is created again from its environment image (`up --remove-existing-container`, no build, the volume is kept). This happens once; data outside `/workspaces` is lost (the progress says so) and `onCreateCommand`/`postCreateCommand` run again. A container created while the configuration could not be read gets `--label devenv.container-config=unknown` instead of the repository's `runArgs` and `appPort`, and is created again once the configuration can be read. | Rewritten |
| Updates the UID of the remote user (`--update-remote-user-uid-default on`) | The extension passes `never`; the ownership fix sets the file owners instead. | Rewritten |
| Downloads Features with the credentials of the machine where it runs (`DEVCONTAINERS_OCI_AUTH`, Docker config, `GITHUB_TOKEN`) | None of them reach the workspace helper: private Features cannot be downloaded. | Not passed |

## 5. Dev Containers extension (Microsoft)

These are channels that the Dev Containers extension opens when it attaches a window, controlled by its settings (defaults in brackets).

| What it normally does | What the extension does | Kind |
|---|---|---|
| Copies the computer's `~/.gitconfig` and `~/.config/git/config` into the container (`dev.containers.copyGitConfig`, on) | Before the first attach, the extension writes a `~/.gitconfig` with a `[credential]` and an `[include]` section: the Dev Containers extension copies only into a file without a section other than `[filter]` or `[safe]`, so nothing is copied. A file of the image without such a section gets the same content appended; an empty `~/.config/git/config` is written. `GIT_CONFIG_GLOBAL=/workspaces/.devenv+/gitconfig` (containerEnv and remoteEnv), so Git 2.32 or newer reads neither home file; older Git reads the volume's configuration through the include. | Refused / neutralized |
| Forwards Git credential requests to the computer's credential helper (`dev.containers.gitCredentialHelperConfigLocation`, global) | Four settings of the command line level, as `GIT_CONFIG_PARAMETERS` (read by every Git version) and as `GIT_CONFIG_COUNT=4`: `credential.helper=` (clears every helper), an include of the user's `/workspaces/.devenv+/credentials.gitconfig` (helpers for other hosts), then for `https://github.com` a clear again and the container's own helper. This works with Git 2.9 or newer; the extension warns about an older Git after each container creation. The forwarding helper is still written, but Git does not use it. | Neutralized |
| Git uses the computer's GitHub credentials | Git uses only the owner account's token in `/workspaces/.devenv+/github-token` (mode 0600, owned by the remote user), written at every open by a helper run without Docker socket and network. The credential helper answers only `get` requests for `https://github.com`. No `GH_TOKEN`. | Rewritten |
| Writes a Docker credential store that forwards to the computer (`dev.containers.dockerCredentialHelper`, on) | `DOCKER_CONFIG=/workspaces/.devenv+/docker` (an empty folder). Tools other than the Docker CLI may ignore it. | Neutralized |
| Forwards the GPG agent when the container has no private keys | `GNUPGHOME=/workspaces/.devenv+/gnupg` with a placeholder file in `private-keys-v1.d`, so the agent is not forwarded. | Neutralized |
| Forwards the SSH agent (`SSH_AUTH_SOCK=/tmp/vscode-ssh-auth-<id>.sock`) | `SSH_AUTH_SOCK=''` (remoteEnv) and `GIT_SSH_COMMAND='ssh -o IdentityAgent=none'`. The socket file stays. | Neutralized |
| Shows every container in Remote Explorer and "Attach to Running Container", whichever account is signed in | The extension shows and allows only the environments of the signed-in GitHub account (sidebar, search, switcher, pickers, reopen at startup); signed out, none. The owner is stored in the registry and in the volume label `devenv.owner-id`. | Removed |
| Creates a new volume and container per "Clone Repository in Container Volume" | One environment per repository and account (planned). Today one per repository across all accounts: a repository with another account's environment shows "Environment of another account", without Start and Select configuration. | Refused / rewritten |
| Gives the bootstrap container the Docker socket | Only the Dev Container CLI runs of the workspace helper (read-configuration, build, up) get the socket and the cache volume; Git runs and file reads get neither, and runs that need no network get `--network none`. The helper gets no environment variables of the computer. | Not passed |
| Stops the container when the window closes (`shutdownAction`, stopContainer) | The override sets `shutdownAction: none`; the Session Monitor stops containers that no window uses. A repository's `none` is kept only with `devEnvLauncher.respectShutdownActionNone`. | Rewritten |

## 6. Docker defaults

| What Docker normally does | What the extension does | Kind |
|---|---|---|
| Publishes ports without an address on all interfaces | Bound to `127.0.0.1`: `8080:80` becomes `127.0.0.1:8080:80`, `80` becomes `127.0.0.1::80`, a number `n` becomes `127.0.0.1:n:n`. | Rewritten |
| Lets every process of the user control every container | Start, Stop, Delete, Rebuild, Switch branch, Select configuration, Reconnect, the switcher, and the open refuse another account's environment. | Refused |
| Runs a container until it is stopped | The Session Monitor stops unused containers after `devEnvLauncher.waitingTimeSeconds` (default 30 s). | Rewritten |

## 7. VS Code

| What VS Code normally does | What the extension does | Kind |
|---|---|---|
| Restores and attaches windows (`window.restoreWindows`) | A window that is restored, reloaded, or attached to another account's container runs no pipeline and closes its connection; a sign-in, sign-out, or account switch closes such a window at once and removes the token from the running container. A window that keeps its connection is closed again about every 10 s; it reloads when the owner signs in again. A window attached to a container of an older extension version that the pipeline cannot create again closes its connection too. | Refused |
| Workspace Trust before opening code | The first open of a repository whose owner is not the account or one of its organizations needs a confirmation. | Refused unless confirmed |

## 8. The computer's environment and settings

| What normally applies | What the extension does | Kind |
|---|---|---|
| Values for `${localEnv:…}` from the VS Code process | See section 1. | Not passed |
| Dev Containers settings for container creation (`defaultFeatures`, `gpuAvailability`, `workspaceMountConsistency`, `mountWaylandSocket`, `cacheVolume`) | Do not apply: the CLI in the workspace helper creates the container; the Dev Containers extension only attaches. Settings used at attach time (copyGitConfig, credential helpers, dotfiles, defaultExtensions) still apply. | Not passed |

## 9. Deliberately kept

| What | Normally configured by | Note |
|---|---|---|
| Full network: internet, LAN, VPN, and services on the computer through `host.docker.internal`; `--network host`, `--add-host`, `--dns*`, and build `--network host` | Docker defaults; repository `runArgs`/`build.options` | Only `--network container:<name>` is refused. VPN reachability on Windows (WSL 2) and Linux: to verify (V-7). |
| With `--network host` (and macvlan/ipvlan), published ports are ignored and container ports become ports of the computer | Repository author; Docker Desktop host networking | An exception to "ports on localhost only". |
| VS Code port forwarding to `localhost` of the computer | VS Code (`remote.localPortHost`, default localhost) | With `allInterfaces`, forwarded ports listen on all interfaces. |
| URLs open in the computer's browser (`$BROWSER`, `openExternal`, Open in Browser) | VS Code | Any process in the container can open any URL. |
| The owner's GitHub token (scopes `repo`, `read:org`), readable by every process in the container | VS Code GitHub session | User decision (like a codespace, but a wider scope than a codespace token). |
| The computer's registry credentials for the image check and the pull on the computer; for ghcr.io, the GitHub session with `read:packages` | The user (`~/.docker/config.json`, credential helpers) | Used on the computer only; they never enter the helper or the container. |

## 10. Known limits

- **Same macOS user.** The account separation protects against using the wrong GitHub account. It does not protect against another person or process working as the same macOS user: `docker exec`, Docker Desktop, and the Dev Containers commands reach every environment, including another account's token file. The registry, the reopen record, pending operations, and the Session Monitor are shared by all accounts. The remedy is separate users on the computer.
- **Channels of the Dev Containers extension and VS Code.** The SSH agent socket file, `REMOTE_CONTAINERS_IPC`, the forwarding credential helper programs of Git and Docker, and the VS Code remote API (clipboard, `openExternal`, the `code` command, commands of local extensions, sign-in requests with consent, Git askpass) stay available to processes in the container. Full isolation needs a separate macOS user, a VM, or Docker Desktop Enhanced Container Isolation.
- **Repository code runs, with the network.** Dockerfile `RUN`, Feature install scripts and entrypoints, and lifecycle commands run. A container is not a strong security boundary.
- **Old Git in the image.** Git older than 2.32 ignores `GIT_CONFIG_GLOBAL` and reads the volume's configuration only through the extension's `~/.gitconfig`, which is missing when the image brings its own file with a section. Every Git version reads `GIT_CONFIG_PARAMETERS`, but Git older than 2.9 does not clear helpers with an empty value, so its pushes may use the computer's credential helper; the extension checks the Git version of each new container and warns about it. `sudo git` and `env -i git` also drop the variables.
- **The token stays after sign-out.** When a window leaves an environment because of a sign-out or an account change, the extension removes the token file from the running container. Otherwise (a stopped container, or an environment that no window of this computer shows) the token file stays until the next open or Delete. Only revoking VS Code's access on GitHub makes it invalid.
- **Not restricted yet:** X11 forwarding (XQuartz; `DISPLAY=''` does not stop it), the copy of `~/.ssh/known_hosts`, `gh` signing in with the computer's token when `dev.containers.githubCLILoginWithToken` is on, and the user's dotfiles (cloned and installed in each new container).

## 11. Known gaps (planned fixes)

Found when this summary was verified against the code; each is scheduled for a fix.

1. **Fixed: the `runArgs` check could be bypassed.** The check runs on the repository's `runArgs`, but `docker run` gets them after the removal of `--name` (which also removes the next entry, even when `--name` is the value of another flag) and after entries that are not strings are dropped. `["--label","--name","--init","--label","-v/Users:/host"]` passes and becomes a bind mount. Fixed: entries that are not strings are refused, `--name` is removed with the same flag parser as the check, and the final `runArgs` are checked before `up`.
2. **Fixed: the empty `~/.gitconfig` did not stop the copy.** The Dev Containers extension skips the copy only when the file has a section other than `[filter]` or `[safe]`, so the computer's `~/.gitconfig` is appended at the first attach. Fixed: the extension writes a file with a `[credential]` and an `[include]` section.
3. **`REMOTE_CONTAINERS_IPC` carries credentials, not the browser.** In Dev Containers 0.470.0 it serves the Git and Docker credential helper requests: any process can ask it for the computer's GitHub credentials. Opening URLs uses VS Code's own channel. The channel itself stays: `$BROWSER`, `openExternal`, and the IPC socket must keep working (user requirement), so `REMOTE_CONTAINERS_IPC` is not removed. Fix: per-container Dev Containers settings (`gitCredentialHelperConfigLocation: none`, `dockerCredentialHelper: false`, `githubCLILoginWithToken: false`), with a check that the browser still opens.
4. **Other named volumes can be mounted** (for example the Dev Containers `vscode` volume); only `devenv-*` names are protected.
5. **A repository label can replace the id label.** A repository `--label devenv.environment-id=…` wins over the CLI's id label. Fix: refuse labels with the prefix `devenv.` in `runArgs`.
6. **`-e`/`--env-file` in `runArgs` can override the Git variables** (`GIT_CONFIG_*`, `DOCKER_CONFIG`, `GNUPGHOME`, `GIT_SSH_COMMAND`, `SSH_AUTH_SOCK`) for the container's main process and plain `docker exec`. Fix: refuse these names.
7. **Ports on `127.0.0.1` are reachable from every container** through `host.docker.internal`, including ports that VS Code forwards for another account's environment. Binding to localhost protects against the LAN only. To be documented as a limit (network access to the computer is allowed).
8. **The row "Environment of another account" and the `otherAccount` message reveal** that another account has an environment of a repository that the signed-in account can access. Resolved by one environment per repository and account (planned).
