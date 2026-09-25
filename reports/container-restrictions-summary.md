# Container restrictions, grouped by who normally sets them

Nothing that configures the container may reach the Mac, with three exceptions: the network, ports on localhost only, and URLs that open in the Mac's browser. We use three kinds of restriction: we **refuse** a configuration with a message before anything is pulled, built or started; we **rewrite or remove** values in the override configuration given to `devcontainer up`; and we **neutralize** channels inside the container with environment variables and files.

Everything below is in the working tree and not committed yet. *v1* means the rule is committed and unchanged since version 1. *(decided, not built yet)* marks decision 1b. The review workflow is still editing files, so line numbers can move.

## 1. Repository author (devcontainer.json)

| What they normally configure (where) | What we do | How |
|---|---|---|
| Bind mounts in `mounts`, in string or object form, as a list or a single value. The CLI turns each into `--mount` on `docker run`. | We refuse every source that is a host path: it contains `/` or `\`, or starts with `.`, `~` or a drive letter. This includes the Docker socket and `${localWorkspaceFolder}/x`, which resolves to `/workspaces/<repo>/x`. We refuse the whole text if Docker would parse it differently. | Refused ([hostAccess.ts:172](src/core/helper/hostAccess.ts#L172)) |
| Other volume and mount types in `mounts` | We allow named, anonymous and tmpfs mounts. We refuse other `devenv-*` volumes, `devenv-helper-cache`, any `volume-driver` or `volume-opt` (a bind mount in disguise), and the types npipe, image, cluster and any unknown type. | Refused ([hostAccess.ts:247](src/core/helper/hostAccess.ts#L247)) |
| Mounts in `runArgs` (`-v`, `--volume`, `--mount`, in every spelling). The CLI appends `runArgs` unchanged to `docker run`. | Same rules as for `mounts`. | Refused ([hostAccess.ts:267](src/core/helper/hostAccess.ts#L267)) |
| Devices, namespaces and container sharing in `runArgs` | We refuse `--device`, `--device-cgroup-rule` and `--gpus`. We refuse `--pid`, `--ipc`, `--uts`, `--userns` and `--cgroupns` with any value, which is stricter than the spec's `=host`. We refuse `--volumes-from` and `--network`/`--net container:<x>`. | Refused ([hostAccess.ts:65](src/core/helper/hostAccess.ts#L65)) |
| Any other `runArgs` flag | We use an allow-list: `--init`, `--label`/`-l`, `--hostname`, `--env`/`-e`, `--env-file`, `--shm-size`, `--ulimit`, `--memory*`, `-m`, `--cpus`, `--user`, `--workdir`, `--name`, `--add-host`, `--dns*`, `--network`, `--cap-add SYS_PTRACE`, `--security-opt seccomp=unconfined`, and `-p` on loopback. Everything else is refused, including stray arguments and grouped short flags. Today that also refuses `--platform`, `--tmpfs`, `--cap-drop`, `--read-only`, `-it`, `--restart`, `--runtime` and `--volume-driver`. | Refused ([hostAccess.ts:35](src/core/helper/hostAccess.ts#L35)) |
| (same) | We extend the allow-list with `--platform`, `--cap-drop`, `--read-only`, `--security-opt no-new-privileges`, `--tmpfs <path>`, `-i`, `-t`, `-it`, `-ti`, `--interactive`, `--tty`, `--group-add`, `--pids-limit`, `--stop-signal`, `--stop-timeout`, `--expose`, `--health-*` and `--oom-score-adj`. We allow `--env-file` only under `/workspaces`. We keep `--runtime` and `--volume-driver` refused by name. *(decided, not built yet)* | Allowed / refused |
| `--rm` in `runArgs` | We remove it from the override `runArgs` and log a line. The removal uses the same flag parser as the check. Today `--rm` is refused as an unknown flag. *(decided, not built yet)* | Removed |
| `--name` in `runArgs`. Without it, Docker picks a random name. | We remove it without a message and add `--name devenv-<owner>-<repo>-<shortid>` last. *v1* | Removed ([devcontainerCli.ts:150](src/core/helper/devcontainerCli.ts#L150)) |
| Published ports that name an address (`appPort` strings, `-p`/`--publish`) | We refuse any address outside 127.0.0.0/8 and `::1`, for example `0.0.0.0`, `[::]` or `localhost`. We refuse `-P`/`--publish-all`, and `appPort` entries that are neither a number nor a string. | Refused ([hostAccess.ts:316](src/core/helper/hostAccess.ts#L316)) |
| `build.options`. The CLI appends them unchanged to `docker build`. | We refuse `--secret`, `--ssh`, `--allow` and `--output`/`-o`. We refuse `--build-context` unless it is `docker-image://` or `http(s)://`. We refuse stray arguments and unknown options such as `--progress`. We allow `--network` (host included), `--add-host`, `--build-arg`, `--target`, `--label`, `--platform`, `--pull` and `--no-cache`. | Refused ([hostAccess.ts:477](src/core/helper/hostAccess.ts#L477)) |
| `hostRequirements.gpu`. Dev Containers turns it into `--gpus all`, depending on `dev.containers.gpuAvailability`. | We refuse any value other than false, null or absent. The CLI in the helper would drop it silently anyway. We neither check nor apply the cpus, memory and storage requirements. | Refused ([hostAccess.ts:126](src/core/helper/hostAccess.ts#L126)) |
| `initializeCommand`. Dev Containers runs it on the Mac. | We refuse any non-empty value (also `false` and `0`) and never pass it to `up`. In the helper it would run with the Docker socket. Version 1 passed it. | Refused ([hostAccess.ts:150](src/core/helper/hostAccess.ts#L150)) |
| `dockerComposeFile` | We refuse it on the raw text (`composeNotSupported`). The policy does not parse compose files. *v1* | Refused ([configChecks.ts:150](src/core/helper/configChecks.ts#L150)) |

## 2. Dev Container Feature author

| What they normally configure (where) | What we do | How |
|---|---|---|
| `privileged` in devcontainer-feature.json (for example docker-in-docker). It can also come from devcontainer.json, from `runArgs` or from the image label. The CLI turns it on if any source sets it. | We refuse any value that counts as true, and `--privileged` with any value, `=false` included. | Refused ([hostAccess.ts:123](src/core/helper/hostAccess.ts#L123)) |
| `capAdd`. The CLI takes the union of all sources and adds `--cap-add` for each. | We refuse every capability except `SYS_PTRACE`/`CAP_SYS_PTRACE`. | Refused ([hostAccess.ts:296](src/core/helper/hostAccess.ts#L296)) |
| `securityOpt`. The CLI takes the union of all sources and adds `--security-opt`. | We refuse every option except `seccomp=unconfined`. `no-new-privileges` is refused today and will be allowed *(decided, not built yet)*. | Refused ([hostAccess.ts:306](src/core/helper/hostAccess.ts#L306)) |
| Feature `mounts`, `hostRequirements.gpu` and `initializeCommand` (for example docker-outside-of-docker binds `/var/run/docker.sock`) | We check all six properties in `read-configuration --include-merged-configuration`, before any pull, build or start. If the merged read fails (offline, or a private base image), we check only the repository configuration before the build. The image label check before `up` still catches the Features, but only after their install scripts ran. We do not restrict install scripts and entrypoints. | Refused ([environmentService.ts:910](src/core/pipeline/environmentService.ts#L910), [workspaceHelper.ts:427](src/core/helper/workspaceHelper.ts#L427)) |

## 3. Base image (image metadata label)

| What they normally configure (where) | What we do | How |
|---|---|---|
| `LABEL devcontainer.metadata` of the image in `image` or in the Dockerfile's `FROM` (for example prebuilt images with Features baked in) | We check `mounts`, `privileged`, `capAdd`, `securityOpt`, `hostRequirements.gpu` and `initializeCommand` through the merged configuration before the build. We ignore `runArgs`, `appPort` and build options in the label, because the CLI ignores them too. | Refused ([hostAccess.ts:115](src/core/helper/hostAccess.ts#L115)) |

## 4. Dev Container CLI

| What they normally configure (where) | What we do | How |
|---|---|---|
| Workspace mount. By default it is a bind mount of the local folder, with the consistency from `dev.containers.workspaceMountConsistency`. The repository can override `workspaceMount` and `workspaceFolder`. | The workspace is always the environment's named volume at `/workspaces`, with the folder `/workspaces/<repo>`. We ignore the repository's values without a message and do not check them. `up` gets no `--mount` and no `--mount-git-worktree-common-dir`. *v1* | Rewritten ([devcontainerCli.ts:181](src/core/helper/devcontainerCli.ts#L181)) |
| `${localWorkspaceFolder}`, which normally resolves to the clone on the Mac | It resolves to `/workspaces/<repo>` in the volume. The RK-10 warning appears when it is used outside `workspaceFolder`, `workspaceMount`, `name`, `initializeCommand`, `mounts` and `runArgs`. | Neutralized ([configChecks.ts:137](src/core/helper/configChecks.ts#L137)) |
| Environment image label. `devcontainer build` writes it and `up` applies it. | We read it with `docker image inspect` and check it before every container creation. If a new image fails, we remove it, keep the old image, and do not start the old container. An existing current container starts without a new check. | Refused ([environmentService.ts:1496](src/core/pipeline/environmentService.ts#L1496)) |
| Container reuse. `up` reuses the container that its id labels find. | We add `--label devenv.container-version=2` after the repository `runArgs`. A container without this label, or with an older value, is created again from its environment image (`up --remove-existing-container`, no build, volume kept). It is never started with `docker start`. This happens once, and it loses data outside `/workspaces` and runs `onCreateCommand`/`postCreateCommand` again. | Rewritten ([pipelineRules.ts:12](src/core/pipeline/pipelineRules.ts#L12), [environmentService.ts:1153](src/core/pipeline/environmentService.ts#L1153)) |
| UID update. The CLI option `--update-remote-user-uid-default` defaults to `on`, and `updateRemoteUserUID` applies on Linux hosts only. | We pass `never`, which also wins over `updateRemoteUserUID: true`. The ownership fix sets file owners instead. *v1* | Removed ([devcontainerCli.ts:64](src/core/helper/devcontainerCli.ts#L64)) |
| Credentials for Feature downloads (`DEVCONTAINERS_OCI_AUTH`, the Docker config, and `GITHUB_TOKEN` of the machine where the CLI runs) | None of them reach the helper, so private Features fail in the build. This is not documented. | Not passed ([workspaceHelper.ts:164](src/core/helper/workspaceHelper.ts#L164)) |

## 5. Dev Containers extension (Microsoft)

| What they normally configure (where) | What we do | How |
|---|---|---|
| Git config copy. `dev.containers.copyGitConfig` (default true) copies the Mac's `~/.gitconfig` and `~/.config/git/config` into the container. | We set `GIT_CONFIG_GLOBAL=/workspaces/.devenv+/gitconfig` in containerEnv and remoteEnv, so Git 2.32 or newer reads neither home file. We write empty home files before the first attach. **The empty `~/.gitconfig` does not stop the copy** (finding 2). | Neutralized ([containerGit.ts:82](src/core/helper/containerGit.ts#L82)) |
| Git credential forwarding. `dev.containers.gitCredentialHelperConfigLocation` (default `global`) relays to the Mac's helper (osxkeychain or `gh auth git-credential`). | `GIT_CONFIG_COUNT=2`: `credential.helper=` clears every helper, then the container's own helper is added for `https://github.com`. This needs Git 2.31 or newer. The forwarding helper is still written, also into the volume gitconfig, but Git does not use it. | Neutralized ([containerGit.ts:24](src/core/helper/containerGit.ts#L24)) |
| Which GitHub credentials Git uses. Normally they are the Mac's, through the forwarding helper. | Git uses only the owner account's token file `/workspaces/.devenv+/github-token` (mode 0600). We write it at every open, in a helper without socket or network. The helper answers only `get` requests for https://github.com. There is no `GH_TOKEN`. | Rewritten ([containerGit.ts:8](src/core/helper/containerGit.ts#L8), [environmentService.ts:1507](src/core/pipeline/environmentService.ts#L1507)) |
| Docker credential forwarding. `dev.containers.dockerCredentialHelper` (default true) writes a `credsStore` into `~/.docker/config.json`. | We set `DOCKER_CONFIG=/workspaces/.devenv+/docker`, an empty 0700 folder. skopeo, podman and oras may ignore it (not verified). | Neutralized ([containerGit.ts:28](src/core/helper/containerGit.ts#L28)) |
| GPG agent forwarding. It is automatic when `private-keys-v1.d` is empty. | We set `GNUPGHOME=/workspaces/.devenv+/gnupg` and put a placeholder file in `private-keys-v1.d`, so the extension does not forward the agent. If the folder's owner is not the remote user, the agent is forwarded again (V-8). | Neutralized ([scripts.ts:195](src/core/helper/scripts.ts#L195)) |
| SSH agent forwarding. It is automatic and sets `SSH_AUTH_SOCK=/tmp/vscode-ssh-auth-<id>.sock`. | We set `SSH_AUTH_SOCK=''` in remoteEnv and `GIT_SSH_COMMAND='ssh -o IdentityAgent=none'`. The socket file stays. | Neutralized ([containerGit.ts:49](src/core/helper/containerGit.ts#L49)) |
| Container list. Remote Explorer and Attach to Running Container show every container, whichever account is signed in. | We show only the signed-in account's environments in the sidebar, Search, the switcher, the picker and the reopen at startup. Signed out, we show none. We do not ask GitHub about hidden environments. The owner is stored in the registry and in the volume label `devenv.owner-id`. | Removed ([ownership.ts:14](src/core/ownership.ts#L14), [sidebar.ts:183](src/vscode/sidebar.ts#L183)) |
| Volumes per repository. Clone Repository in Container Volume creates a new volume and container on each call. | We allow one environment per repository across all accounts. A second account gets `otherAccount`. | Refused ([registry.ts:131](src/core/storage/registry.ts#L131)) |
| (same) | One environment per repository **and** account, each with its own clone, volume, container, Git identity and token. *(decided, not built yet)* | Rewritten |
| Docker socket. The bootstrap container that clones and builds gets the socket through a bind mount. | Only the CLI runs (read-configuration, build, up) get the socket and the cache volume. Clone, switch branch, Git summary, the token write and file reads get neither. The ownership fix runs without the socket. | Not passed ([workspaceHelper.ts:164](src/core/helper/workspaceHelper.ts#L164)) |
| Helper environment. The extension normally runs this logic on the Mac, with the full VS Code process environment and `~/.docker/config.json`. | The helper gets no variables of the Mac. `DOCKER_*`, `BUILDX_*`, `BUILDKIT_*`, `LD_*`, `PATH` and `NODE_OPTIONS` are never passed. The token arrives only on stdin, into a noexec tmpfs, and that run gets no variables. Runs that need no network get `--network none`. The helper starts with `--pull never`, and no Docker credentials of the Mac enter it. | Not passed ([workspaceHelper.ts:117](src/core/helper/workspaceHelper.ts#L117)) |
| Stop on close. The default `shutdownAction` is `stopContainer`; the repository, a Feature or the image can change it. | The override sets `shutdownAction: 'none'`, and the Session Monitor stops containers instead. A repository's `none` is kept only with `devEnvLauncher.respectShutdownActionNone`. *v1* | Rewritten ([devcontainerCli.ts:198](src/core/helper/devcontainerCli.ts#L198)) |

## 6. Docker defaults

| What they normally configure (where) | What we do | How |
|---|---|---|
| Published ports without an address bind on all interfaces. The CLI binds only a numeric `appPort` to 127.0.0.1. | We bind them to 127.0.0.1: `8080:80` becomes `127.0.0.1:8080:80`, `80` becomes `127.0.0.1::80`, and a number n becomes `127.0.0.1:n:n`. This changes only the override configuration. A Docker test checks it with `docker port`. | Rewritten ([hostAccess.ts:501](src/core/helper/hostAccess.ts#L501), [hostAccess.ts:368](src/core/helper/hostAccess.ts#L368)) |
| Who may act on containers. Every process of the macOS user controls every container through the socket. | We refuse Start, Stop, Delete, Rebuild, Switch branch, Select configuration, Reconnect, the switcher and the open on another account's environment (`otherAccount`). The VS Code layer checks, and the core checks again. The token and the account always come from one session. | Refused ([controller.ts:1617](src/vscode/controller.ts#L1617), [environmentService.ts:733](src/core/pipeline/environmentService.ts#L733)) |
| Container lifetime. A container runs until it is stopped, or restarts according to `--restart`. | The Session Monitor stops unused registry containers after `devEnvLauncher.waitingTimeSeconds` (default 30 s). It does not check accounts. *v1* | Rewritten ([rules.ts:199](src/monitor/rules.ts#L199)) |

## 7. VS Code

| What they normally configure (where) | What we do | How |
|---|---|---|
| Window restore and attach (`window.restoreWindows`; Dev Containers resolves the `attached-container+` authority) | A window that is restored, reloaded or attached to another account's container runs no pipeline and closes its connection. A sign-in, sign-out or account switch closes such a window at once. The container can still be used for a short moment (V-2/V-8), and an attached window without a folder is not recognized. | Refused ([controller.ts:1456](src/vscode/controller.ts#L1456), [controller.ts:1483](src/vscode/controller.ts#L1483)) |
| Workspace Trust before Reopen in Container | The first open of a repository whose owner is not the account or one of its organizations needs a confirmation. Cancel creates nothing, and later opens do not ask. *v1* | Refused unless confirmed ([environmentService.ts:588](src/core/pipeline/environmentService.ts#L588)) |

## 8. The user's Mac environment and settings

| What they normally configure (where) | What we do | How |
|---|---|---|
| Values for `${localEnv:NAME}` and `${env:NAME}`. They come from the VS Code process environment on the Mac, and the repository references them. | We do not pass them. They resolve to their default, to an empty value, or to the helper's own value (`HOME=/root`, `PATH`, `HOSTNAME`, `NODE_VERSION`, `YARN_VERSION`). One warning names them. Version 1 passed them. | Not passed ([localEnv.ts:1](src/core/helper/localEnv.ts#L1), [environmentService.ts:927](src/core/pipeline/environmentService.ts#L927)) |
| Dev Containers settings for container creation: `defaultFeatures`, `gpuAvailability`, `workspaceMountConsistency`, `mountWaylandSocket`, `experimentalMountGitWorktreeCommonDir` and `cacheVolume` | They do not apply, because the CLI in the helper creates the container and Dev Containers only attaches. Settings used at attach time (copyGitConfig, credential helpers, dotfiles, defaultExtensions) still apply. *v1* | Not passed ([devcontainerCli.ts:27](src/core/helper/devcontainerCli.ts#L27)) |

## Other: version 1 data and the workspace volume

| What they normally configure (where) | What we do | How |
|---|---|---|
| Version 1 registry entries without an owner | They stay hidden and unusable until the signed-in account shows on GitHub that it can access the repository. That account then becomes the owner. Claims run one at a time, under the registry lock. | Removed ([ownership.ts:91](src/core/ownership.ts#L91)) |
| Version 1's shared `repositories.json` | Each account gets `repositories-<id>.json`, and we delete the shared file. A refresh that returns another account is discarded. | Rewritten ([paths.ts:43](src/core/storage/paths.ts#L43)) |
| The repository's `.git/config`, hooks, fsmonitor and transports in the volume | Helper runs that use the token run Git with `core.hooksPath=/dev/null` and `core.fsmonitor=false`, over https only, with no prompts, and fetch from the fixed URL `https://github.com/<repo>.git`. The token file is removed before `git switch`. | Neutralized ([scripts.ts:81](src/core/helper/scripts.ts#L81)) |
| Links or files that container processes plant in `/workspaces/.devenv+` | We remove them. The token is written into a temporary folder and moved into place with `mv -fT`, and owners are set with `chown -h`. | Removed ([scripts.ts:180](src/core/helper/scripts.ts#L180)) |

## Deliberately kept

| What | Normally configured by | Note |
|---|---|---|
| Full network: internet, LAN, VPN, and services on the Mac through `host.docker.internal`. `--network host`, `--add-host`, `--dns*` and build `--network host` are allowed. | Docker defaults; repository `runArgs`/`build.options` | Only `container:<x>` is refused. V-7 is still open for Windows and Linux. |
| `--network host`, macvlan and ipvlan: published ports are ignored, and container ports become ports of the computer | Repository author; the Docker Desktop host networking setting | Documented as an exception under "Ports". |
| VS Code port forwarding to the Mac's localhost | VS Code (`remote.localPortHost`, default localhost) | Not enforced: with `allInterfaces`, forwarded ports listen on 0.0.0.0. |
| URLs open in the Mac's browser (`$BROWSER`, `openExternal`, Open in Browser) | VS Code | Any container process can open any URL, custom URL schemes included. |
| The owner's full GitHub token (`repo`, `read:org`), readable by every process in the container | VS Code GitHub session | Decision 3. It covers more than a codespace token, and the docs do not state its scope. |
| The Mac's registry credentials, for the image check and the pull on the Mac. For ghcr.io, the session with `read:packages`, for one pull. | The user (`~/.docker/config.json`, credential helper) | Used on the Mac only. They never enter the helper or the container. |
| Full Docker control for the CLI runs in the helper | — | This is why `initializeCommand` is refused. |

## Not restrictable: documented limits

- **Same macOS user.** The account separation protects against using the wrong GitHub account. It does not protect against another person or process working as the same macOS user. `docker exec`, Docker Desktop and the Dev Containers commands reach every environment, including another account's token file. The registry, the reopen record, pending operations and the Session Monitor are shared by all accounts. The remedy is separate users on the computer.
- **Channels that Dev Containers and VS Code open when a window attaches.** These are the SSH agent socket file, `REMOTE_CONTAINERS_IPC`, the forwarding credential helper programs of Git and Docker, and the VS Code remote API. Any process can call the helper programs. The remote API covers the clipboard, `openExternal`, `code`, commands of local extensions, and sign-in requests with consent. It also covers Git askpass, which Git falls back to when the token file is missing or the host is not github.com. Full isolation needs a separate macOS user, a VM, or Docker Desktop Enhanced Container Isolation.
- **Repository code runs, with the network.** This covers Dockerfile `RUN`, Feature install scripts and entrypoints, and lifecycle commands. A container is not a strong boundary.
- **Old Git in the image.** Git older than 2.32 ignores `GIT_CONFIG_GLOBAL`, and Git older than 2.31 also ignores `GIT_CONFIG_COUNT`. With such a Git, pushes use the Mac's helper again, and the docs mention only the 2.32 limit. `sudo git` and `env -i git` also drop the variables. We do not check the Git version.
- **The token stays after sign-out.** After a sign-out or an account change, the token file stays until the next open or a Delete. Only revoking VS Code's access on GitHub makes it invalid.
- **Not documented yet:**
  - X11 forwarding with XQuartz. `DISPLAY=''` does not stop it.
  - The copy of `~/.ssh/known_hosts`. We could block it the way we block `~/.config/git/config`.
  - `gh` signs in with the Mac's token when `dev.containers.githubCLILoginWithToken` is on.
  - The user's dotfiles are cloned and installed in each new container.

## Findings from verification

1. **The `runArgs` check can be bypassed.** The check runs on the repository `runArgs`, but `docker run` gets `loopbackRunArgs(stripNameArgs(stringList(runArgs)))`.
   - `stripNameArgs` removes `--name` and the next entry, even when `--name` is the value of another flag.
   - `stringList` drops entries that are not strings.
   - So `["--label","--name","--init","--label","-v/Users:/host"]` and `["--label",3,"--label","-v/Users:/host"]` both pass the check and become a bind mount. The same trick works for `--privileged` and `-p0.0.0.0:…`.
   - Fix: check the final override `runArgs`, or strip with `parseFlags` and refuse entries that are not strings. The planned `--rm` removal must not repeat the mistake ([devcontainerCli.ts:150](src/core/helper/devcontainerCli.ts#L150), [devcontainerCli.ts:184](src/core/helper/devcontainerCli.ts#L184)).
2. **The empty `~/.gitconfig` does not stop `copyGitConfig`.** The extension skips the copy only when the file has a section other than `[filter]` or `[safe]`.
   - At the first attach, the Mac's `~/.gitconfig` is appended to the container's.
   - The extension's follow-up `git config --global` edits land in the volume gitconfig. `gpg.ssh.allowedSignersFile` then survives rebuilds.
   - The docs, the comment in environmentService and the Docker test comment all say the empty file stops the copy. The test only checks for 0 bytes, before any attach.
   - Fix: write a section header such as `[include]`, or set `remote.containers.copyGitConfig: false` in `customizations.vscode.settings`. It must be the old key: a `false` under `dev.containers.copyGitConfig` falls back to the user setting.
3. **`REMOTE_CONTAINERS_IPC` carries credentials, not the browser.** In 0.470.0 it carries only the `git-credential-helper` and `docker-credential-helper` requests. Any process can send it a `get` for github.com and receive the Mac's credentials. The docs keep it "on purpose" because they assume it serves the browser.
   - Option: remoteEnv `REMOTE_CONTAINERS_IPC=''`. The socket file stays.
   - Per-container settings in `customizations.vscode.settings` could also be set: `dev.containers.gitCredentialHelperConfigLocation: "none"`, `dev.containers.dockerCredentialHelper: false` and `dev.containers.githubCLILoginWithToken: false`.
4. **Other named volumes can be mounted.** Only `devenv-*` names are protected. A configuration can mount the Dev Containers `vscode` volume or volumes of other projects. After 1b, a fixed-name volume would also be shared by both accounts' environments of one repository.
5. **A repository label can replace the id label.** The CLI puts its `-l` before the repository `runArgs`, so a repository's `--label devenv.environment-id=X` wins. The container is then not found, or is found under X. This was observed in the CLI source, not tested in Docker.
6. **`-e` and `--env-file` in `runArgs` override the Git variables in containerEnv.** This affects `GIT_CONFIG_*`, `DOCKER_CONFIG`, `GNUPGHOME` and `GIT_SSH_COMMAND` for PID 1 and for plain `docker exec`. remoteEnv still wins for the VS Code server, its terminals and lifecycle commands.
7. **Ports on 127.0.0.1 are reachable from every container** through `host.docker.internal`. A Docker test shows this for a server on the Mac's loopback. By inference, this includes ports that VS Code forwards for another account's environment. Binding to localhost protects against the LAN only.
8. **`otherAccount` reveals** that another account has an environment of the repository, although spec 1 says hidden environments must stay hidden. Decision 1b removes this case.