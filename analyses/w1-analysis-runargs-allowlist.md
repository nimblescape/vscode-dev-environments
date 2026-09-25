**runArgs flags: current policy, safety, and a recommendation**

Two problems come before the flag question. There are two ways around the current allow-list, so adding flags only helps once they are fixed. I confirmed the first by running the policy code; the second is from Docker's documented `--network` syntax and was not tested. Flag status below was checked by running `runArgsProblems` on each flag. Docker is not installed, so the Docker behaviour below comes from Docker's documented behaviour and the Dev Container CLI 0.89.0 source, not from runs.

### Ways around the policy found during the check

1. **Removing `--name` after the check lets any flag through (high).** The policy checks the repository's `runArgs`. Docker then gets `stripNameArgs(runArgs)` (`src/core/helper/devcontainerCli.ts:150`). That function drops `--name` and the argument after it, even when `--name` was really the value of another flag. Example:
   - `["-e","--name","--init","-e","--privileged"]` gives no problems.
   - Docker receives `["-e","-e","--privileged",…]`. Docker takes the next argument as a flag's value even when it starts with `-`, so it runs `--privileged`.
   - The same works with `-v=/Users:/host` or `--device=…`.
   
   The fix: remove `stripNameArgs`. The extension adds its own `--name` last, and Docker keeps the last value. Also check the final `runArgs` that are passed to `up`.
2. **The other-container network check can be skipped (medium; check once Docker is back).** `--network name=container:<other>` is the long form of `--network`, and Docker treats it as network mode `container:<other>`. `networkProblems` only looks for a value starting with `container:`, so this passes (confirmed: no problems). Read the `name=` form too.
3. **`--label devenv.*` replaces the container's own id label (low).** The CLI adds its id labels before `runArgs` in `docker run`, and a later label wins. After that, the extension and the Session Monitor no longer recognise the container. Refuse label keys starting with `devenv.` and `devcontainer.`.
4. **`--env-file` can read any file of the helper (low).** During `up` the helper also holds the shared cache volume `/devenv-cache`, which the `-v` rule refuses to mount. Allow only paths inside `/workspaces/<repo>/`.
5. **Named volumes are shared by name (not a runArgs flag, but it concerns other containers).** Any volume except `devenv-*` and the helper cache is allowed. A repository can therefore mount volumes of the user's other containers, or share a fixed-name volume such as `vscode-extensions` with an environment of the other account.

### Flags

| Flag | Allowed now | Safe to allow | Caveat |
|---|---|---|---|
| `--platform` | no | yes | Must match the platform the environment image was built for (set in `build.options`), otherwise the start fails because the image exists only locally. amd64 on Apple Silicon is emulated and slow. Already allowed in `build.options`. |
| `--rm` | no | yes | Stopping the container (Session Monitor or Stop) deletes it. Each start then recreates it from the image: onCreate and postCreate run again, and anything outside the volume is lost. Docker refuses it together with `--restart`. |
| `-i`, `-t`, `--interactive`, `--tty` | no | yes | They do nothing for a dev container. `-it` breaks the start: the CLI in the helper has no terminal (the npm package ships without node-pty), so Docker says "the input device is not a TTY". The parser also treats `-it` as unknown. Best: remove them from the `runArgs` passed to `up`. |
| `--tmpfs` | no | yes | Same as `--mount type=tmpfs`, which is already allowed. |
| `--cap-drop` | no | yes | Only removes rights. Dropping CHOWN, DAC_OVERRIDE, FOWNER, SETUID or SETGID (or ALL) breaks the extension's `docker exec -u root` steps (ownership fix, empty `~/.gitconfig`) and sudo. |
| `--read-only` | no | yes | The environment will very likely not work (VS Code Server is installed in the home folder, the extension writes `~/.gitconfig`, the CLI patches `/etc`), unless the configuration adds tmpfs or volumes for those folders. |
| `--security-opt no-new-privileges[:true]` | no (only `seccomp=unconfined`) | yes | Hardening; sudo and setuid stop working inside the container. `seccomp=<file>` is also safe (never more open than `unconfined`), but the file is read in the helper. Keep `apparmor=`, `label=` and `systempaths=unconfined` refused. |
| `--shm-size`, `--ulimit`, `--memory*`, `-m`, `--cpus` | yes | yes | Resources only. A memory limit that is too low gets VS Code Server killed. |
| `--init`, `--workdir`/`-w`, `--user`/`-u` | yes | yes | The container stays unprivileged. |
| `--hostname`/`-h`, `--add-host`, `--dns*` | yes | yes | Network only. `--dns` replaces the DNS that Docker Desktop forwards from the Mac, which is what resolves VPN names. |
| `--label`/`-l` | yes | with a key check | See finding 3. |
| `--entrypoint` | no | yes | No effect: the CLI adds `--entrypoint /bin/sh` after `runArgs`. |
| `--group-add` | no | yes | Groups apply inside the container only; with no bind mounts or devices there is nothing of the Mac to open. |
| `--sysctl` | no | yes | Docker accepts only settings that stay inside the container (`kernel.msg*`, `kernel.sem`, `kernel.shm*`, `fs.mqueue.*`, `net.*`) and refuses `net.*` with `--network host`. |
| `--gpus` | no | no | Gives access to devices of the host. Keep refused, like `hostRequirements.gpu`. |
| `--runtime` | no | no | Selects another container runtime configured in Docker (for example `nvidia` adds devices). Keep refused, or allow only `runc`. |
| `--oom-score-adj` | no | only ≥ 0 | A negative value makes the kernel kill other containers or Docker's own processes first when memory runs out. |
| `--oom-kill-disable` | no | keep refused | Ignored by Docker Desktop. On a cgroup v1 Linux host without a memory limit, it can hang the host. |
| `--pids-limit` | no | yes | Hardening. |
| `--restart` | no | `no`, `on-failure[:n]` | `always` and `unless-stopped` can start the container together with Docker, without a window and outside the Session Monitor (concept 7.6). |
| `--log-driver`, `--log-opt` | no | only `json-file`, `local`, `none` | Other drivers write to a socket or the journal of the Docker host (`syslog` or `fluentd` with `unix://`, `journald`), use Docker's cloud credentials (`awslogs`, `gcplogs`), or read files of the host (`syslog-tls-*`). |
| `--health-*`, `--no-healthcheck` | no | yes | The check runs inside the container. |
| `--stop-signal`, `--stop-timeout` | no | yes; limit the timeout | The CLI's keep-alive script exits only on SIGTERM. The monitor and Stop call `docker stop` without `-t`, so each stop can wait the full timeout. Limit it to 60 s or less, or pass `-t`. |
| `--expose` | no | yes | Metadata only; nothing is published because `-P` is refused. |
| `--link` | no | no | Names another container. On the default network, older Docker versions copy that container's environment variables into this one. Deprecated. |
| `--mac-address` | no | network only | Can clash with or pose as another container on the same Docker network. Rarely needed; keep refused. |
| `--ip`, `--ip6` | no | yes | Work only on a user-defined network; Docker refuses an address already in use. |
| `--network-alias` | no | network only | On a shared network it can answer for another container's name. |
| `--storage-opt` | no | yes (`size=` only) | Fails on Docker Desktop. |
| `--device`, `--device-cgroup-rule` | no | no | Devices of the host. A cgroup rule plus the default MKNOD right lets the container create a device node for the host disk. |
| `--device-read/write-bps/-iops`, `--blkio-weight-device` | no | yes (limits only) | They name device paths of the Docker host but give no access. Rarely used; keep refused. |
| `--blkio-weight`, `--cpuset-*`, `--cpu-shares`/`-c`, `--cpu-period`, `--cpu-quota`, `--kernel-memory` | no | yes | Resources only. Some are ignored by the Docker Desktop kernel. |
| `--isolation` | no | yes | Windows only; Linux accepts only `default`. |
| `--volume-driver` | no | no | A volume plugin decides what a volume is, which can be a folder of the host. Same reason `volume-driver` is refused in `mounts`. |
| `--attach`/`-a` | no | yes | No effect: the CLI already passes `-a STDOUT -a STDERR`. `-a STDIN` is also reported as "argument STDIN". |
| `--detach`/`-d` | no | yes, but it always fails | Docker refuses `-d` together with the CLI's `-a` ("Conflicting options: -a and -d"). |
| `--name` | yes (removed) | yes | See finding 1. |

### Recommendation

1. **Fix findings 1 and 2 first.** Check the exact `runArgs` Docker receives, and read the long `--network` form.
2. **Allow as they are:**
   - `--platform`, `--rm`, `--tmpfs`, `--cap-drop`, `--read-only`
   - `--pids-limit`, `--cpu*`, `--cpuset-*`, `--blkio-weight`, `--kernel-memory`, `--isolation`
   - `--group-add`, `--sysctl`, `--health-*`, `--no-healthcheck`, `--stop-signal`, `--expose`
   - `--ip`, `--ip6`, `--network-alias`, `--entrypoint`, `--attach`
3. **Remove before `up`, with a log line:** `-i`, `-t`, `--interactive`, `--tty` and `-d`/`--detach`. They do nothing here, and `-it` and `-d` make the start fail.
4. **Allow with a value check:**
   - `--security-opt no-new-privileges` (also `:true`, `=true`, `:false`)
   - `--restart no` or `on-failure[:n]`
   - `--stop-timeout` of 60 or less
   - `--log-driver json-file`, `local` or `none`, with only size, rotation and tag options in `--log-opt`
   - `--oom-score-adj` of 0 or more
   - `--storage-opt size=`
   - `--label` keys not starting with `devenv.` or `devcontainer.`
   - `--env-file` only inside the repository folder
5. **Keep refused:**
   - Devices: `--gpus`, `--device`, `--device-cgroup-rule`, `--device-*-bps`/`-iops`, `--blkio-weight-device`
   - Other: `--runtime`, `--link`, `--volume-driver`, `--oom-kill-disable`, `--mac-address`
   - Keep refusing unknown flags. New Docker flags can give access to the host: for example, Docker 28's `--use-api-socket` mounts the Docker socket and the registry credentials (it is refused now as unknown). `--cgroup-parent`, `--cidfile` and `--label-file` should stay refused too.
6. **Change the error text for unknown flags.** Right now they are listed under "needs access to your computer", which is wrong for `--rm` or `--platform`. Something like "not known to be safe" would be accurate.

Neither of your two requirements is affected. Port forwarding to localhost, `$BROWSER`, `openExternal` and the Dev Containers IPC socket are untouched. Network reach, including VPN resources, stays open: `--network` (also `host`), `--dns*` and `--add-host` stay allowed.

Two things to check about `--network host`:
- On Linux Docker Engine it also shares the host's local sockets (X11, D-Bus) and its 127.0.0.1 services, which is more than network access.
- With Docker Desktop's host networking turned on, a service in the container listening on 0.0.0.0 might be reachable from the LAN. That would break the "ports only on localhost" rule.

I changed no project files. The throwaway scripts that ran the policy are in `/private/tmp/claude-501/-Users-hs-workspace-projects-vscode-dev-environments/bce08af7-c1a4-4ec6-b4fd-f0585152ddc7/scratchpad/flagcheck/`.