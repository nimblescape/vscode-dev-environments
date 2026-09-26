# Dev Containers internals used by Dev Environments: inventory

Request: "Report any Dev Containers internal API we use in our extension."
Repository: `vscode-dev-environments`, branch `main`, commit `33ae64d`. No repository file was changed.

**Evidence and its limits**

- **Dev Containers 0.470.0.** Its code was not available here, because the network policy blocks the Marketplace download. Its behavior comes from `analyses/gap3-analysis.md`, an analysis of 0.470.0 written from its code (on the `handoff/queue` branch). Such rows say "from gap3 analysis". Rows that neither source covers say "not checkable here".
- **Dev Container CLI 0.89.0.** Checked in its source in `node_modules/@devcontainers/cli`.
- **VS Code.** Checked only against `@types/vscode` 1.90 and the documented built-in commands.
- **GitHub and Docker Desktop.** Neither was reachable here. Their rows are not checkable here.

## Status (update 2026-09-26)

The problems of section 6 and the NFR-06 finding were fixed on `main` in commit `133154c` ("Protect the GitHub token, sign in the GitHub CLI as the owner, label our volumes, and keep Dev Containers internals in one module", unit 5), after three review rounds and green CI:

| Section | Problem | Fix on main (`133154c`) |
|---|---|---|
| 1 | NFR-06 did not hold | All Dev Containers internals are in `src/core/devContainers.ts`; the authority encoding in `src/vscode/connection/authority.ts` imports the literal from it; a test pins the activation event in `package.json` |
| 6.1 | Credentialed pull dropped the context's TLS settings | The GitHub session is sent only over the default endpoint, `unix://`, `npipe://`, `ssh://`, or `tcp://` with `DOCKER_TLS_VERIFY` and `DOCKER_CERT_PATH`; otherwise a plain `docker pull` with Docker's own credentials |
| 6.2 | `gh` token push had no second layer | `gh` is signed in as the owner through `GH_CONFIG_DIR` in the volume (`gh/hosts.yml`, written with the owner's token); the configuration may not set `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST`; logins with `_` (Enterprise Managed Users) accepted |
| 6.3 | Token removal needed tools of the user's image | A workspace helper run removes the token file and `gh/hosts.yml` from the volume, whether the container runs or not |
| 6.4 | Compose and anonymous-volume labels decided ownership | Volumes that a configuration mounts are created with `devenv.environment-id`, `devenv.owner-id`, `devenv.repository`, `devenv.volume=additional`; recording and Delete use only these labels; environments of one account share such a volume, another account is refused; a restored registry protects the unlabeled volumes that a container mounts |
| 6.5 | `runArgs` prefix rules always took a value | `--dns*`, `--memory*`, `--health-*` flags are allowed only by their exact names |
| 6.6 | Remote-user rule ignored `runArgs --user` and `user:group` | Resolved as Dev Container CLI 0.89.0 does it |
| 6.7 | Volume hash rule too broad | A hash-suffixed name is refused only when the volume exists and is not the environment's own |
| 6.8 | The documented Features cache did not exist | Docs corrected: Features are downloaded at each build |
| 6.9 | Doc comments | Corrected (`containerGit.ts` header, docs) |

Container version 4: existing containers are created again once (files in the volume are kept). Section 7 ("what breaks first") still applies to future Dev Containers and CLI updates. The tables below describe the state before the fix; locations in them refer to commit `33ae64d`.

## 1. Summary

The extension depends on **20 internal details of the Dev Containers extension** (Table A). It also relies on **5 public Dev Containers features** for behavior that the documentation does not promise (Table B).

The critical internal is how Dev Containers reads **per-container settings**:
- It reads `customizations.vscode.settings` from the label `devcontainer.metadata`.
- It uses flat keys with a `dev.containers.*` → `remote.containers.*` fallback.
- It writes them into `Machine/settings.json` only at the first attach.

Container-only Git and credential isolation depend on this. If it changes, the failure is silent: Git, Docker and `gh` credentials of the computer are forwarded into environment containers again.

The second critical internal is the **`attached-container` authority**, meaning the hex-encoded JSON and the `attached-container` literal. If it changes, Start, Reopen and window restore fail loudly.

**NFR-06 does not hold.** NFR-06 says: "internal details of the Dev Containers extension are used in one component only". The concept names the Connection Adapter as that component. Only the authority encoding is kept there ([authority.ts](src/vscode/connection/authority.ts), used only by [connectionAdapter.ts](src/vscode/connectionAdapter.ts)).

These are the violations:

| Internal | Files outside the Connection Adapter |
|---|---|
| `attached-container` literal and resolver timing | `package.json:34` (activation event; its own literal, not tied to the constant); `src/vscode/extension.ts:320` and `src/vscode/controller.ts:373` (V-2 behavior) |
| Per-container settings (key names, `kv` fallback, first-attach write) | `src/core/helper/containerGit.ts:115-142`; `src/core/helper/devcontainerCli.ts:189`; `src/core/names.ts:14-21` (`CONTAINER_VERSION` 3 exists because of the first-attach write) |
| `remoteEnv` order and label use for Dev Containers, `shutdownAction`, postAttach | `src/core/helper/devcontainerCli.ts:70-71, 185-192`; `src/core/helper/containerGit.ts:75-100`; `src/core/helper/workspaceHelper.ts:537` |
| Forwarding Git helper written by Dev Containers | `src/core/helper/containerGit.ts:45-60, 166-260`; `src/core/pipeline/environmentService.ts:1776-1840` |
| Dev Containers volume names and labels | `src/core/helper/hostAccess.ts:539-548, 580`; `src/core/pipeline/environmentService.ts:1582, 2252, 2499` |
| Machine settings reach the window (`remote.localPortHost`) | `src/core/helper/hostAccess.ts:358-377` |

**Other findings**

- Two CLI assumptions are **contradicted** by CLI 0.89.0 (Table C):
  - the remote-user rule;
  - the Features cache.
- The verification found 9 defect groups (section 6). Three can expose the owner's GitHub token (section 6.1, 6.2, 6.3).

## 2. Table A: Dev Containers extension, internal

"Checked in 0.470.0" gives the source for the Dev Containers behavior. "CLI part confirmed" means the CLI side was checked in 0.89.0 as well.

| # | Dependency | What we rely on | Used for | Where | Checked in 0.470.0 | Risk | Guarded by test |
|---|---|---|---|---|---|---|---|
| A1 | Authority encoding | `attached-container+` followed by hex of the UTF-8 JSON `{containerName:'/<name>'}`. The decoder also accepts upper-case hex, extra fields, percent-encoding, and an older plain-name hex. | Opening the window on the container; finding the container of the current window | [authority.ts:32](src/vscode/connection/authority.ts#L32-L37), [authority.ts:83](src/vscode/connection/authority.ts#L83-L111) | not checkable here (the test fixture claims 0.470.0 without a source) | High. Loud: Start and Reopen fail. Silent: a restored window is no longer recognized. | Unit tests of our own encoding only (`authority.test.ts:25-107`). No contract test. |
| A2 | `@<parent>` suffix in the authority | The decoder cuts the hex at `@` (nested under WSL or SSH). | Recognizing nested windows | [authority.ts:57](src/vscode/connection/authority.ts#L57-L59) | not checkable here | Low. Silent: a nested window is not recognized. | `authority.test.ts:55-58` |
| A3 | `attached-container` literal | Used as the value of `vscode.env.remoteName`, as the authority prefix, and in the activation event. | Detecting environment windows; activating before the connection | [connectionAdapter.ts:28](src/vscode/connectionAdapter.ts#L28-L29), [package.json:34](package.json#L34) | not checkable here | High. Windows are not recognized, and the extension no longer activates before the connection. | Fakes only. No test ties `package.json:34` to the `ATTACHED_CONTAINER` constant. |
| A4 | Attach without prompt; restore re-attaches | `vscode.openFolder` with the authority attaches without a prompt. A restored window re-attaches once the container runs. | Start, Reopen, restore | [connectionAdapter.ts:72](src/vscode/connectionAdapter.ts#L72-L76) | not checkable here | Medium. Loud: a prompt or an error dialog. | `connectionAdapter.test.ts:71-95` checks our call only. |
| A5 | **Per-container settings** | We set 5 flat keys in `customizations.vscode.settings` (`copyGitConfig` under both prefixes, `gitCredentialHelperConfigLocation:'none'`, `dockerCredentialHelper:false`, `githubCLILoginWithToken:false`). Dev Containers writes them to `Machine/settings.json` at the first attach only and reads them with the `kv` rule. Later label entries win. | Switching off the Git config copy, Git and Docker credential forwarding, and `gh` sign-in, for this container only | [containerGit.ts:115](src/core/helper/containerGit.ts#L115-L142), [devcontainerCli.ts:189](src/core/helper/devcontainerCli.ts#L189) | from gap3 analysis (verbatim `kv`/`voe`/`Coe`, gap3:164-214); CLI part confirmed | **High, security.** Silent: the computer's `~/.gitconfig`, Git and Docker credential helpers, and `gh` token all reach the container. | `containerGit.test.ts:108-175` re-implements `kv`: a copy of the assumption, not a contract test. |
| A6 | `remoteEnv` applied last | Dev Containers applies label `remoteEnv` after the `userEnvProbe` shell environment, for the server, terminals and Source Control Git. | Container-only `GIT_CONFIG_*`, `DOCKER_CONFIG`, `GIT_SSH_COMMAND` | [containerGit.ts:90](src/core/helper/containerGit.ts#L90-L100), [devcontainerCli.ts:185](src/core/helper/devcontainerCli.ts#L185-L188) | from gap3 analysis (gap3:152-156); CLI part confirmed (last entry wins) | Medium, security. Silent: a shell profile could override the variables. Credentials are exposed only together with an A5 failure. | `containerGit.test.ts:56-76`; `test/docker/pipeline.test.ts:403-432` (label only) |
| A7 | Forwarding Git credential helper | Dev Containers writes `credential.helper` with `git config --system` and `--global`. `'none'` stops both writes. Our second layer: an empty helper at command-line level (`GIT_CONFIG_COUNT`) and in `~/.gitconfig`. | Keeping Git credential requests away from the computer | [containerGit.ts:45](src/core/helper/containerGit.ts#L45-L60), [containerGit.ts:166](src/core/helper/containerGit.ts#L166-L219) | from gap3 analysis (gap3:96-100) | High, security. Silent: a helper written at another level (for example per URL for a host other than github.com) would not be cleared. | `containerGit.test.ts:255-407` (real Git, forwarder never called); `test/docker/pipeline.test.ts:403-462` |
| A8 | Docker credential helper | `dockerCredentialHelper:false` stops `/usr/local/bin/docker-credential-dev-containers-*` and `credsStore`. `DOCKER_CONFIG` is our second layer. | Docker in the container does not use the computer's registry credentials | [containerGit.ts:139](src/core/helper/containerGit.ts#L139), [containerGit.ts:85](src/core/helper/containerGit.ts#L85) | from gap3 analysis (gap3:62-65, :101) | Medium, security. Silent: tools that ignore `DOCKER_CONFIG` get the computer's credentials. | `containerGit.test.ts:109-117`; `test/docker/pipeline.test.ts:403-438` |
| A9 | `gh` token push | `githubCLILoginWithToken:false` means no `gh auth login --with-token` in the container. | `gh` is not signed in with the computer's account | [containerGit.ts:140](src/core/helper/containerGit.ts#L140) | from gap3 analysis (gap3:62, :102); the code default is `true` (gap3:197) | **High, security. No second layer** (see 6.2). | `containerGit.test.ts:146-168` (simulated `kv`) |
| A10 | `copyGitConfig` skip rule | Dev Containers skips the `~/.gitconfig` copy when the target has a section other than `[filter]`/`[safe]`. Only our file content happens to satisfy this. | Backup against the copy | [container-restrictions.md:139](docs/container-restrictions.md#L139), [containerGit.ts:174](src/core/helper/containerGit.ts#L174-L183) | from gap3 analysis (gap3:231-273) | Low. It matters only if A5 fails too. | none for the rule |
| A11 | IPC socket and variables left untouched | `REMOTE_CONTAINERS_IPC` and `/tmp/vscode-remote-containers-ipc-*.sock` answer only Git and Docker credential requests (get, store, erase). `BROWSER` and `openExternal` do not use them. | URLs keep opening on the computer | [containerGit.ts:10](src/core/helper/containerGit.ts#L10-L12), [containerGit.ts:90](src/core/helper/containerGit.ts#L90-L94) | from gap3 analysis (gap3:25-36, :58-160) | High, security. Accepted limit today: any process in the container can read, store or erase the computer's credentials through the socket. New request types would widen this silently. | Variables-absent tests only; no socket test |
| A12 | SSH agent forwarding | Always forwarded, with `SSH_AUTH_SOCK` unchanged. Git is kept off the agent with `GIT_SSH_COMMAND`. | Git over SSH does not use the computer's keys | [containerGit.ts:86](src/core/helper/containerGit.ts#L86), [container-restrictions.md:79](docs/container-restrictions.md#L79) | from gap3 analysis (gap3:218-219) | Medium, security. Accepted limit: any process can sign with the computer's keys. | `containerGit.test.ts:56-61` |
| A13 | GPG agent forwarding | Forwarded unless the container's GnuPG home has private keys. | Documented limit | [container-restrictions.md:78](docs/container-restrictions.md#L78) | from gap3 analysis (gap3:221) | Low. Docs only. | `test/docker/pipeline.test.ts:439-440` |
| A14 | X11 forwarding | Forwarded unless the container env has a non-empty `DISPLAY`. `DISPLAY=''` in `remoteEnv` does not stop it. | Documented limit | [container-restrictions.md:132](docs/container-restrictions.md#L132) | from gap3 analysis (gap3:377) | Low. Docs only. | none |
| A15 | `known_hosts` and dotfiles copy | `known_hosts` is copied at every attach when missing. Dotfiles cannot be switched off per container. | Documented limit | [container-restrictions.md:105](docs/container-restrictions.md#L105) | from gap3 analysis (gap3:42, :222, :378) | Low. Docs only. | none |
| A16 | Container-creation settings do not apply | `defaultFeatures`, `gpuAvailability`, `workspaceMountConsistency`, `mountWaylandSocket` and `cacheVolume` have no effect, because the CLI creates the container. | Scope statement | [container-restrictions.md:105](docs/container-restrictions.md#L105) | not checkable here (gap3:216 lists them; attach-time use not shown) | Low. Docs only. | none |
| A17 | Dev Containers volume names | `vscode`, `vsc-remote-containers`, and names ending in `-<32 hex>` or `-<64 hex>` are refused as mounts. They are never recorded or deleted as additional volumes. | Protecting the VS Code Server cache and the clone volumes of the user's other dev containers | [hostAccess.ts:546](src/core/helper/hostAccess.ts#L546-L548), [environmentService.ts:1582](src/core/pipeline/environmentService.ts#L1582) | not checkable here | Medium, security. Silent if Dev Containers renames its volumes. The hash rule is too broad (see 6.7). | `hostAccess.test.ts:63-69`; `environmentService.test.ts:1770-1774` |
| A18 | Dev Containers volume labels | `vsch.*` and `dev.container.volume` mark volumes of Dev Containers. | Same as A17 | [hostAccess.ts:580](src/core/helper/hostAccess.ts#L580), [environmentService.ts:2499](src/core/pipeline/environmentService.ts#L2499) | not checkable here | Medium, security. Silent. | `hostAccess.test.ts:660-663` |
| A19 | Container machine settings reach the window (`remote.localPortHost`) | Dev Containers writes any `customizations.vscode.settings` into the container's machine settings. The window applies window-scoped settings from there. The tunnel binds `0.0.0.0` unless the value is `localhost`. The policy therefore refuses other values. | Keeping forwarded ports off the LAN | [hostAccess.ts:358](src/core/helper/hostAccess.ts#L358-L377), [container-restrictions.md:29](docs/container-restrictions.md#L29) | from gap3 analysis (gap3:169-175, :370-376; VS Code 1.139.0 side too) | High, security. Silent: another write path or another bind setting would expose ports. An image-shipped `Machine/settings.json` already bypasses the check (documented limit). | `hostAccess.test.ts:301-316, 524-549` |
| A20 | Git-version warning | "Git < 2.9 is unsafe" assumes the Dev Containers forwarder would answer when A5 fails. | Warning the user | [containerGit.ts:240](src/core/helper/containerGit.ts#L240-L260), [environmentService.ts:1808](src/core/pipeline/environmentService.ts#L1808-L1840) | from gap3 analysis (consistent with gap3:96-100) | Low. Warning text only. | `containerGit.test.ts:492-511` |

## 3. Table B: Dev Containers extension, public, relied on as behavior

| # | Dependency | What we rely on | Used for | Where | Checked in 0.470.0 | Risk | Guarded by test |
|---|---|---|---|---|---|---|---|
| B1 | Extension id and `extensionKind` | `extensionDependencies: ms-vscode-remote.remote-containers`; `extensionKind: ui` | Dev Containers provides the resolver | [package.json:26](package.json#L26-L31) | confirmed (manifest fields) | Low. Loud if the id changes. | none |
| B2 | **Label `devcontainer.metadata` applied at attach (V-1)** | On attach, Dev Containers reads the merged configuration from the label and applies extensions, settings, `remoteUser`, `forwardPorts`, `remoteEnv` and postAttach. The override puts settings, `remoteEnv` and `shutdownAction` only into that label. | Attaching to a container created by the CLI; all of A5 to A8 | [devcontainerCli.ts:161](src/core/helper/devcontainerCli.ts#L161-L193), [containerGit.ts:127](src/core/helper/containerGit.ts#L127-L131) | from gap3 analysis (gap3:180-183: `set-up --include-merged-configuration`); CLI part confirmed | **High, security.** Loud: extensions and settings are missing. Silent: container-only Git is not applied. | `test/docker/pipeline.test.ts:403-432` checks label content only; nothing checks the attach. |
| B3 | `shutdownAction:'none'` in the override | As the last label entry it wins, so Dev Containers never stops an attached container. The Session Monitor alone owns stop-on-close. | One owner for stop-on-close | [devcontainerCli.ts:190](src/core/helper/devcontainerCli.ts#L190-L192) | not checkable here (gap3 covers settings order, not `shutdownAction` on attach); CLI part confirmed | Medium. Dev Containers would stop the container on close or reload, and running processes would be lost. | `devcontainerCli.test.ts:191-202` (content only) |
| B4 | postAttach on attach (`--skip-post-attach`) | `up` skips `postAttachCommand` because Dev Containers runs it at attach. Create-time commands are not re-run (CLI marker files). | Running postAttach once per attach | [devcontainerCli.ts:70](src/core/helper/devcontainerCli.ts#L70-L71), [workspaceHelper.ts:536](src/core/helper/workspaceHelper.ts#L536-L537) | not checkable here (gap3 shows `set-up` but not postAttach or markers); CLI part confirmed | Medium. postAttach never runs, or create-time commands run twice. | Option present (contract test and `devcontainerCli.test.ts:64-87`) |
| B5 | Port forwarding on loopback | `forwardPorts` goes over the server connection (not the IPC socket) and binds per `remote.localPortHost`. Published ports are rewritten to `127.0.0.1` by us. | Ports reachable only as `localhost:<port>` | [hostAccess.ts:710](src/core/helper/hostAccess.ts#L710-L734), [devcontainerCli.ts:181](src/core/helper/devcontainerCli.ts#L181-L184) | from gap3 analysis (gap3:145-150, :374) | Low, security. Mostly owned by VS Code and Docker. | `devcontainerCli.test.ts:251-277`; `test/docker/pipeline.test.ts:498` |

## 4. Table C: Dev Container CLI 0.89.0, not a stable contract

What the contract test [devcontainerCli.contract.test.ts](src/core/helper/devcontainerCli.contract.test.ts) guards:
- **Option names, flag/value kinds and choices** of `read-configuration`, `build` and `up`, checked against `--help` (lines 102-150).
- **The lifecycle-failure description template**, checked in the bundle (lines 154-187).

It does not guard output shapes, merge rules, or Docker call order. **Two rows are contradicted by 0.89.0 (C5, C7).**

| # | Dependency | What we rely on | Used for | Where | Checked in CLI 0.89.0 | Risk | Guarded by test |
|---|---|---|---|---|---|---|---|
| C1 | `devcontainer.metadata` format and merge | The label is a JSON array (or one object) ordered image, then Features, then config/override. The last entry wins. Host-access keys are read from every entry. | Host-access check of the image; remote user; the override winning | [pipelineRules.ts:286](src/core/pipeline/pipelineRules.ts#L286-L312), [hostAccess.ts:305](src/core/helper/hostAccess.ts#L305-L331) | confirmed (`Oj`, `Kt`, `ji`). An existing container re-applies only `remoteUser`, `userEnvProbe` and `remoteEnv`. | High, security. Silent: a changed label parses as `[]`, and image mounts or `privileged` pass unchecked. | Synthetic labels only |
| C2 | Pinned version | `@devcontainers/cli` 0.89.0 in the helper image; the version is part of the image tag. | All C rows | [package.json:474](package.json#L474), [Dockerfile:34](resources/helper/Dockerfile#L34) | confirmed | Medium. A version bump passes CI when only options and the lifecycle text stay the same. | `helperImage.test.ts:151-156`; **contract test** |
| C3 | Result line of `build`/`up` | The last non-empty stdout line is JSON with `outcome`. Fields read: `containerId`, `remoteUser`, `remoteWorkspaceFolder`, `imageName`, `message`, `description`. | Pipeline results | [devcontainerCli.ts:81](src/core/helper/devcontainerCli.ts#L81-L107), [workspaceHelper.ts:763](src/core/helper/workspaceHelper.ts#L763-L786) | confirmed (`I9`, `hI`, `C9`) | High. Loud if missing. Silent if a field is renamed (wrong owner user). | Synthetic output only |
| C4 | Lifecycle failure text | `<hook>Command from <origin> failed.`; the CLI skips later commands, exits 1, and leaves the container running. | Opening with a warning instead of failing | [devcontainerCli.ts:109](src/core/helper/devcontainerCli.ts#L109-L130), [pipelineRules.ts:230](src/core/pipeline/pipelineRules.ts#L230-L248) | confirmed (`R_`, `Rd`, `sW`) | Medium. Loud: a hard open failure. | **contract test** (154-187); `pipelineRules.test.ts:300-330` |
| C5 | **Remote-user rule (CONTRADICTED)** | `imageRemoteUser` takes the last `remoteUser`, else the last `containerUser`, else the image user, else `root`. | Ownership fix before `up`; user after a lifecycle failure | [pipelineRules.ts:286](src/core/pipeline/pipelineRules.ts#L286-L312), [environmentService.ts:1613](src/core/pipeline/environmentService.ts#L1613-L1634) | **contradicted.** The CLI (`vG`, `mn`) uses the last `runArgs --user/-u` when no `remoteUser` is set, and splits `user:group`. See 6.6. | Medium. Silent: the repository stays owned by root. | `pipelineRules.test.ts:259-273` (no `--user` or `user:group` case) |
| C6 | `read-configuration` output | The last stdout line is JSON with `configuration` and `mergedConfiguration` (merged shape). With `--id-label`, the merge uses the existing container's label. | Host-access check before the build | [workspaceHelper.ts:444](src/core/helper/workspaceHelper.ts#L444-L511), [hostAccess.ts:292](src/core/helper/hostAccess.ts#L292-L315) | confirmed (`F9`, `ji`) | High, security. Silent: Feature mounts would be caught only after the Feature scripts have run. | Synthetic output only |
| C7 | **Features cache (CONTRADICTED)** | `--user-data-folder /devenv-cache` is expected to keep downloaded Features. | Offline builds (concept 536) | [devcontainerCli.ts:12](src/core/helper/devcontainerCli.ts#L12-L17), [vscode-dev-environments.md:536](docs/vscode-dev-environments.md#L536) | **contradicted.** The `ociCache` sits in a per-run `os.tmpdir()` folder (`kQ`, `fj`), and the helper runs with `--rm`. See 6.8. | Low. Loud: an offline build with Features fails. | Arguments only |
| C8 | `--update-remote-user-uid-default never` | `never` wins even over `updateRemoteUserUID:true`; `off` does not. | No `-uid` image | [devcontainerCli.ts:68](src/core/helper/devcontainerCli.ts#L68-L69) | confirmed (`SQ`) | Low | **contract test** (choices) |
| C9 | `--no-lockfile` and lockfile name | The lockfile is `devcontainer-lock.json`, or `.devcontainer-lock.json` for a config named `.devcontainer.json`. | No new file in the repository | [scripts.ts:260](src/core/helper/scripts.ts#L260-L276) | confirmed (`gQ`, `sQ`) | Low. Silent: an untracked lockfile. | `scripts.test.ts:179-195`; **contract test** (option) |
| C10 | `--id-label` lookup | `docker ps -a --filter label=…`; the first match is used, running or stopped. The label is set on new containers. | Finding the environment's container | [devcontainerCli.ts:64](src/core/helper/devcontainerCli.ts#L64-L65), [workspaceHelper.ts:551](src/core/helper/workspaceHelper.ts#L551-L556) | confirmed (`Tr`, `dn`) | High, security. Loud: a name conflict. Reserved labels are refused. | **contract test** (option only) |
| C11 | `--override-config` replaces the config | The override fully replaces `devcontainer.json`; there is no merge. | Unsanitized repository values never reach `up` | [devcontainerCli.ts:161](src/core/helper/devcontainerCli.ts#L161-L194), [scripts.ts:247](src/core/helper/scripts.ts#L247-L258) | confirmed (`ki`) | **High, security.** Silent: if the CLI merged, repository `runArgs`, mounts or `initializeCommand` would apply. | **contract test** (option only) |
| C12 | `--remove-existing-container` order | The old container is removed before image resolution and `docker run`. | Recovery after a failure | [devcontainerCli.ts:73](src/core/helper/devcontainerCli.ts#L73), [environmentService.ts:1292](src/core/pipeline/environmentService.ts#L1292-L1318) | confirmed (`LG`, `CW`, `ng`) | Medium. Loud. | **contract test** (option only) |
| C13 | `docker run` argument order | `runArgs` come after the CLI's `-l`/`-e`/`-u` and before the image `-l` labels. A number `appPort` becomes `127.0.0.1:n:n`. The CLI passes no `--name`. | Policy on `runArgs`; our `--name` | [hostAccess.ts:102](src/core/helper/hostAccess.ts#L102-L103), [hostAccess.ts:720](src/core/helper/hostAccess.ts#L720-L730) | confirmed (`QW`) | Medium, security. Mostly order-independent; see C5 for `-u`. | No test against the CLI order |
| C14 | `up` on an existing container | `up` only runs `docker start`; it does not run `docker run` or re-apply the override. | Skipping the image host-access check (`createsContainer=false`) | [environmentService.ts:1277](src/core/pipeline/environmentService.ts#L1277-L1281), [environmentService.ts:1536](src/core/pipeline/environmentService.ts#L1536) | confirmed (`LG`, `BW`, `Yr`) | Medium, security. Silent host-access gap if this changes. | Fake helper only |
| C15 | `--skip-post-attach` | Skips `S_` (postAttach) entirely. | See B4 | [devcontainerCli.ts:70](src/core/helper/devcontainerCli.ts#L70-L71) | confirmed | Low | **contract test** (option) |
| C16 | Feature key resolution copied | Lower-casing; the `devcontainers-contrib` → `devcontainers-extra` redirect; the first path component is the registry. | The image check asks for the same artifact the build uses | [reference.ts:92](src/core/imageCheck/reference.ts#L92-L102), [reference.ts:121](src/core/imageCheck/reference.ts#L121-L135) | confirmed (`Je`); a harmless difference for 2-part keys | Low. Silent: a missed Feature update. | `reference.test.ts:116-130` (our copy) |
| C17 | `${env:X}` is an alias of `${localEnv:X}` | Both forms resolve in the helper. | Warning about computer-dependent variables | [localEnv.ts:12](src/core/helper/localEnv.ts#L12-L13) | confirmed (`C_`) | Low. Cosmetic. | `localEnv.test.ts:15` |

## 5. Table D: VS Code, GitHub and Docker Desktop internals

### D1. VS Code

| # | Dependency | What we rely on | Used for | Where | Checked | Risk | Guarded by test |
|---|---|---|---|---|---|---|---|
| D1.1 | `vscode-remote` scheme | Folder URIs use `vscode-remote://<authority><path>`. | Opening and identifying windows | [authority.ts:84](src/vscode/connection/authority.ts#L84-L91), [connectionAdapter.ts:30](src/vscode/connectionAdapter.ts#L30-L38) | not in `@types/vscode` | Medium | Fakes |
| D1.2 | `vscode.env.remoteName` | `undefined` means a local window (public). | Window type; Docker setup only in local windows | [connectionAdapter.ts:28](src/vscode/connectionAdapter.ts#L28-L29), [dockerSetup.ts:438](src/vscode/dockerSetup.ts#L438) | confirmed (d.ts:10105) | Low | `connectionAdapter.test.ts:107-155` |
| D1.3 | **Activation on `onResolveRemoteAuthority:attached-container` blocks the connection** | VS Code activates this non-resolver extension for another extension's authority. It waits, without a timeout, for `activate()` (Docker start, image check, update, possibly minutes) before it resolves. | The container is up to date before a restored window connects | [package.json:34](package.json#L34), [extension.ts:319](src/vscode/extension.ts#L319-L322) | not checkable here (the event type is documented for resolvers only; the waiting is undocumented) | **High, security.** Loud: a connection error. Silent: attach to an old-version container with the older override. | none for VS Code behavior (`controller.test.ts:1203` uses a fake) |
| D1.4 | `vscode.openFolder` options | `forceReuseWindow` overrides `window.openFoldersInNewWindow`. The promise may not settle before the reload. | Start and Reopen in the same window | [connectionAdapter.ts:76](src/vscode/connectionAdapter.ts#L76) | options documented; semantics not | Medium | `connectionAdapter.test.ts:71-77` |
| D1.5 | `openFolder` focuses an existing window | Opening the same folder focuses the window instead of opening it twice. | No duplicate windows | [connectionAdapter.ts:62](src/vscode/connectionAdapter.ts#L62-L73) | not checkable here (V-2) | Medium | Decision logic only |
| D1.6 | `workbench.action.remote.close` | The window becomes an empty local window, reloads, and the old host ends within 30 s or 10 s. | Hand-off and leaving an environment | [controller.ts:69](src/vscode/controller.ts#L69-L77), [environmentService.ts:2636](src/core/pipeline/environmentService.ts#L2636-L2641) | not in d.ts or the documented commands (V-3) | High, security. Silent: a stop is not done. The account-change path keeps the window attached longer. | Fakes |
| D1.7 | `workbench.action.reloadWindow` | Reloading reconnects the remote. | Reconnect | [connectionAdapter.ts:67](src/vscode/connectionAdapter.ts#L67-L70) | internal command | Low | `connectionAdapter.test.ts:80-84` |
| D1.8 | `workbench.action.openWalkthrough` | The id format is `publisher.name#id`; `false` means the same editor group. | "Install Docker…" | [dockerSetup.ts:50](src/vscode/dockerSetup.ts#L50-L53), [controller.ts:333](src/vscode/controller.ts#L333) | internal command | Medium. Loud. | `dockerSetup.test.ts:193-210` |
| D1.9 | `setContext` | Documented command (when-clause guide). | Context keys | [auth.ts:150](src/vscode/auth.ts#L150), [sidebar.ts:511](src/vscode/sidebar.ts#L511) | public | Low | `controller.test.ts:503` |
| D1.10 | `ELECTRON_RUN_AS_NODE` with `process.execPath` | The detached monitor runs as Node and outlives VS Code. | Session Monitor | [sessionCoordinator.ts:380](src/vscode/sessionCoordinator.ts#L380-L389) | not a VS Code contract (V-3) | High. Silent: containers are never stopped. | Spawn options only |
| D1.11 | Reload faster than the waiting time (V-4) | 30 s is longer than a window reload. | No stop during a reload | [rules.ts:297](src/monitor/rules.ts#L297-L300) | not checkable here | Medium. Loud: connection loss. | Arithmetic only |
| D1.12 | `$BROWSER`, `code`, `openExternal` channels | The VS Code server sets `BROWSER` after the resolver env, and it uses `VSCODE_IPC_HOOK_CLI`, not the Dev Containers IPC socket. | Leaving these variables untouched | [containerGit.ts:91](src/core/helper/containerGit.ts#L91-L94) | from gap3 analysis (VS Code server 1.139.0 code) | Medium. Loud. | `containerGit.test.ts:71` |
| D1.13 | Command links in progress messages | Markdown `command:` links render in notification progress. | "Show details" | [progress.ts:15](src/vscode/progress.ts#L15-L16) | not in d.ts | Low. Cosmetic. | Text only |
| D1.14 | Extension host PID equals window lifetime | One local host per window (`ui`); `kill(pid,0)` tests liveness. | Status files, busy marks, lock | [sessionCoordinator.ts:52](src/vscode/sessionCoordinator.ts#L52), [lock.ts:28](src/monitor/lock.ts#L28-L33) | not checkable here | Medium | `lock.test.ts:29-39` |
| D1.15 | `deactivate()` runs synchronously on close | It runs, and within a budget of about 70 ms (retries with `Atomics.wait`). | Writing "closing" and the reopen record | [sessionCoordinator.ts:223](src/vscode/sessionCoordinator.ts#L223-L246), [paths.ts:178](src/core/storage/paths.ts#L178-L192) | not checkable here (V-3) | Medium. Silent: a delayed stop or no reopen. | `sessionCoordinator.test.ts:306-322` |
| D1.16 | `globalStorageUri` shared by all windows and profiles | One coordination folder. | Registry, sessions, lock | [extension.ts:79](src/vscode/extension.ts#L79) | d.ts says "global" only | High. A monitor stops a container another profile uses. | none |
| D1.17 | GitHub provider keeps a rejected session | `createIfNone` returns a session whose token was rejected; `forceNewSession` replaces it. | Re-sign-in workaround | [auth.ts:39](src/vscode/auth.ts#L39-L42), [auth.ts:207](src/vscode/auth.ts#L207-L211) | not checkable here | Low | `auth.test.ts:93-212` |
| D1.18 | `account.id` is the numeric GitHub user ID | Compared with GraphQL `databaseId`; names `repositories-<id>.json`. | Boundary between accounts | [auth.ts:74](src/vscode/auth.ts#L74-L82), [discoveryService.ts:718](src/core/discovery/discoveryService.ts#L718) | d.ts: "unique identifier" only | High, security (fails closed) | Fakes |
| D1.19 | `account.label` is the GitHub login | Organization cache; ghcr.io username. | Display, ghcr.io | [auth.ts:74](src/vscode/auth.ts#L74-L99), [ownerSelector.ts:94](src/vscode/ownerSelector.ts#L94) | d.ts: "human-readable name" only | Low | `auth.test.ts:45-50` |
| D1.20 | Client id of VS Code's GitHub OAuth app | `01ab8ac9400c4e429b23` is used in the "Authorize" hint URL. | OAuth-restricted organizations | [discoveryService.ts:51](src/core/discovery/discoveryService.ts#L51), [discoveryService.ts:1112](src/core/discovery/discoveryService.ts#L1112) | not checkable here | Low. Wrong page. | `discoveryService.test.ts:794` pins the literal only |
| D1.21 | `openExternal(file:)` runs an installer | The Windows shell runs the downloaded `.exe`. | Docker Desktop install | [dockerSetup.ts:365](src/vscode/dockerSetup.ts#L365) | d.ts documents http(s), mailto and vscode only | Medium. Loud. | Fake |
| D1.22 | Proxy and certificate patching of `https` | VS Code applies `http.proxy` and system certificates to Node `https` in the extension host. | GraphQL, registry, download behind proxies | [http.ts:33](src/core/http.ts#L33-L36), [dockerDownload.ts:27](src/core/docker/dockerDownload.ts#L27) | not in d.ts | Medium. Silent: skipped updates. | none |
| D1.23 | Node ≥ 20 in VS Code ≥ 1.90 | esbuild targets `node20`; `Atomics.wait` is used. | Runtime | [esbuild.mjs:35](esbuild.mjs#L35-L40), [package.json:20](package.json#L20-L22) | release notes only | Low | none |
| D1.24 | Extension host env is the login-shell env | `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG` and `PATH` match the user's terminal. | Docker engine and credential choice | [extension.ts:76](src/vscode/extension.ts#L76-L77), [extension.ts:122](src/vscode/extension.ts#L122) | user docs only | Medium. Silent: another engine is used. | none |
| D1.25 | No `capabilities.untrustedWorkspaces` | The documented default disables the extension in Restricted Mode. Whether environment windows are restricted is unknown. | — | [package.json:26](package.json#L26-L36) | not checkable here | Medium, security. The account checks would not run in such a window. | none |
| D1.26 | Heartbeats resume after sleep within 60 s | Timers resume promptly, and the hosts of windows closed during sleep have ended. | Sleep rule of the monitor | [rules.ts:364](src/monitor/rules.ts#L364-L371) | not checkable here (V-3) | Medium. Loud: a stop under an active window. | `rules.test.ts:332, 553-575` |
| D1.27 | Monitor holds `Code.exe` (RK-4) | The detached monitor keeps the old executable running. | — | [sessionCoordinator.ts:379](src/vscode/sessionCoordinator.ts#L379-L395) | not checkable here | Low. A delayed VS Code update. | none |
| D1.28 | Old extension folder stays during an update | `dist/sessionMonitor.js` and the helper `Dockerfile` are read at run time. | Monitor spawn; helper build | [extension.ts:121](src/vscode/extension.ts#L121), [helperImage.ts:180](src/core/helper/helperImage.ts#L180-L190) | not checkable here | Low | none |

### D2. GitHub

| # | Dependency | What we rely on | Used for | Where | Checked | Risk | Guarded by test |
|---|---|---|---|---|---|---|---|
| D2.1 | GraphQL error `type` values | `NOT_FOUND`, `FORBIDDEN` and `RATE_LIMITED` in the top-level `type` field (not in the spec). | Missing repository or owner; hints | [githubApi.ts:16](src/core/discovery/githubApi.ts#L16-L22), [discoveryService.ts:1239](src/core/discovery/discoveryService.ts#L1239-L1250) | not checkable here | Medium | Recorded texts |
| D2.2 | SAML and OAuth-restriction error texts | Regexes and `extensions.saml_failure`; the organization login is parsed from the message. | Fix-link hints | [discoveryService.ts:1086](src/core/discovery/discoveryService.ts#L1086-L1102) | not checkable here | Low. Silent: no hint. | `discoveryService.test.ts:784-804` |
| D2.3 | Null nodes plus an error path alias | The organization is found via `error.path[0]`. | Hints | [discoveryService.ts:1011](src/core/discovery/discoveryService.ts#L1011-L1040) | not checkable here (V-5) | Low | `discoveryScope.test.ts:283-310` |
| D2.4 | Timeout texts and 502/503/504 | Retry with smaller pages. | Large accounts | [discoveryService.ts:1095](src/core/discovery/discoveryService.ts#L1095), [discoveryService.ts:1234](src/core/discovery/discoveryService.ts#L1234-L1250) | not checkable here | Medium. Loud. | `discoveryIncremental.test.ts:96-108` |
| D2.5 | Query semantics | Affiliations cover team repositories; 50 lookups fit the time limit; `object(expression:)` resolves like `rev-parse`. | Discovery | [discoveryService.ts:71](src/core/discovery/discoveryService.ts#L71-L94), [discoveryService.ts:121](src/core/discovery/discoveryService.ts#L121-L140) | not checkable here (V-5) | Medium. Silent: repositories missing. | Fakes |
| D2.6 | `pushedAt` changes on every push | Incremental refresh. | Fast refresh | [incremental.ts:39](src/core/discovery/incremental.ts#L39-L51) | not checkable here | Low. Silent: a stale list. | Fakes |
| D2.7 | ghcr.io accepts the OAuth token | The session token (`read:packages`) is used as the registry password. | Private ghcr.io images | [auth.ts:94](src/vscode/auth.ts#L94-L98), [auth.ts:220](src/vscode/auth.ts#L220-L230) | not checkable here (docs list PATs only) | Medium. Loud: a sign-in loop. | Fakes |
| D2.8 | `x-access-token` user with an OAuth token | Git over HTTPS to github.com. | Clone, fetch, push | [containerGit.ts:20](src/core/helper/containerGit.ts#L20-L24), [scripts.ts:124](src/core/helper/scripts.ts#L124-L127) | not checkable here | Low | `containerGit.test.ts`; `scripts.test.ts` |
| D2.9 | "Token rejected" texts of Git and GitHub | `Authentication failed…`, `Invalid username or token`, `…401`. | Re-sign-in path | [pipelineRules.ts:216](src/core/pipeline/pipelineRules.ts#L216-L228) | not checkable here | Medium. Loud, misleading. | `pipelineRules.test.ts:329-350` |

### D3. Docker, Docker Desktop, Docker Compose

| # | Dependency | What we rely on | Used for | Where | Checked | Risk | Guarded by test |
|---|---|---|---|---|---|---|---|
| D3.1 | `docker desktop start` and its "unsupported" texts | `Usage:` with exit 0, or `unknown command` / `is not a docker command`. | Starting Docker | [dockerStart.ts:64](src/core/docker/dockerStart.ts#L64-L68), [dockerStart.ts:94](src/core/docker/dockerStart.ts#L94-L102) | not checkable here | Low | `dockerStart.test.ts:34-278` |
| D3.2 | Start fallbacks | `open -g -a Docker`; `…\Docker\Docker\Docker Desktop.exe`. | Starting Docker | [dockerStart.ts:110](src/core/docker/dockerStart.ts#L110-L135) | not checkable here (V-11) | Low | `dockerStart.test.ts:133, 166-172` |
| D3.3 | Docker CLI search folders | Docker Desktop bundle paths after `PATH`. | Finding `docker` | [dockerCli.ts:46](src/core/docker/dockerCli.ts#L46-L61) | not checkable here | Low | `dockerCli.test.ts:35-46` |
| D3.4 | Socket `/var/run/docker.sock` in the VM; `/.docker/desktop/` detection | The helper mounts that socket path. | Helper Docker access | [workspaceHelper.ts:114](src/core/helper/workspaceHelper.ts#L114-L126) | not checkable here (V-7) | Medium. Loud. | `workspaceHelper.test.ts:165-170` |
| D3.5 | Resource Saver | No background calls; a 20 s limit on `docker info`. | Battery; wake-up | [monitorLoop.ts:201](src/monitor/monitorLoop.ts#L201-L206), [containerAdapter.ts:63](src/core/docker/containerAdapter.ts#L63-L64) | not checkable here (V-11) | Low | `monitorLoop.test.ts:564-585` |
| D3.6 | `permission denied` in `docker info` | Means the user is not in the `docker` group. | Hint instead of a start | [dockerStart.ts:192](src/core/docker/dockerStart.ts#L192-L198) | not checkable here | Low | `dockerStart.test.ts:237` |
| D3.7 | Download URLs and redirect rule | Downloads come from `desktop.docker.com`, and redirects stay on that host over HTTPS. | Installer download | [dockerSetup.ts:30](src/core/docker/dockerSetup.ts#L30-L39), [dockerDownload.ts:70](src/core/docker/dockerDownload.ts#L70-L83) | not checkable here | Medium. Fails closed. | `dockerDownload.test.ts:68-100` |
| D3.8 | Package ids | Homebrew cask `docker-desktop`; winget `Docker.DockerDesktop`. | Install | [dockerSetup.ts:200](src/core/docker/dockerSetup.ts#L200-L208) | public ids | Low | `dockerSetup.test.ts:137-140` |
| D3.9 | Linux install commands | `download.docker.com` repositories, packages, dnf5 syntax from Fedora 41, `os-release`, `docker` group. | Guided install | [dockerSetup.ts:212](src/core/docker/dockerSetup.ts#L212-L300) | public docs; change over time | Medium | `dockerSetup.test.ts:145-271` |
| D3.10 | VPN routes and DNS | Container traffic uses the computer's network stack. | — | [hostAccess.ts:98](src/core/helper/hostAccess.ts#L98-L101) | not checkable here (V-7) | Low | none |
| D3.11 | `host.docker.internal` | It reaches the computer's localhost ports (documented limit). | — | [container-restrictions.md:111](docs/container-restrictions.md#L111) | not checkable here | Low, security (accepted) | none |
| D3.12 | Docker error texts | `No such container/volume/image/object`; in-use texts; helper `docker run` exit 125 plus `no such image` (image pruned, so rebuild). | Races; cleanup; helper rebuild | [containerAdapter.ts:99](src/core/docker/containerAdapter.ts#L99-L106), [workspaceHelper.ts:789](src/core/helper/workspaceHelper.ts#L789-L799) | not checkable here | Medium. Loud. | `containerAdapter.test.ts:306-526` |
| D3.13 | JSON output fields | `State.Status` values; `image ls {{json .}}` keys; `<none>`; containerd dangling listing. | State; cleanup; build numbers | [containerAdapter.ts:109](src/core/docker/containerAdapter.ts#L109-L121), [containerAdapter.ts:555](src/core/docker/containerAdapter.ts#L555-L575) | not checkable here | Medium | `containerAdapter.test.ts:79-93, 650` |
| D3.14 | Credential store read | `config.json` `auths`, `credsStore`, `credHelpers`; the `docker-credential-* get` protocol; `https://index.docker.io/v1/`; the `<token>` user. The lookup order is claimed to be "as in the Docker CLI", which is **unverified** (6.9). | Image-check credentials | [credentials.ts:40](src/core/imageCheck/credentials.ts#L40-L167) | not checkable here | Medium, security (fails closed) | `credentials.test.ts:82-120` |
| D3.15 | Temporary `docker --config` pull | `DOCKER_HOST` is taken from `context inspect .Endpoints.docker.Host`. **The context's TLS settings are dropped** (6.1). | Credentialed ghcr.io pull | [containerAdapter.ts:615](src/core/docker/containerAdapter.ts#L615-L643), [containerAdapter.ts:650](src/core/docker/containerAdapter.ts#L650-L665) | not checkable here | **High severity, low likelihood; security** | `containerAdapter.test.ts:830-890` (accepts plain `tcp://`) |
| D3.16 | A config with only `auths` disables the default store | The Docker CLI detects its default credential store only without `auths`, `credsStore` and `credHelpers`. | Same pull | [containerAdapter.ts:249](src/core/docker/containerAdapter.ts#L249-L253), [dockerConfig.test.ts:5](test/docker/dockerConfig.test.ts#L5-L7) | not checkable here | Low | `containerAdapter.test.ts:855-880` |
| D3.17 | Host flag parsing copied (pflag) | Value and short-flag rules; **prefix allow rules `--dns*`, `--memory*`, `--health-*` always take a value** (6.5). | Host-access policy for `runArgs` and build options | [hostAccess.ts:233](src/core/helper/hostAccess.ts#L233-L234), [hostAccess.ts:867](src/core/helper/hostAccess.ts#L867-L870) | not checkable here | Medium, security | `hostAccess.test.ts:105-393` |
| D3.18 | Builder uses host-pulled base images | The helper has no registry credentials. The CLI adds `--pull` only with `--no-cache` (confirmed in 0.89.0). BuildKit is expected to use the local image. | Private base images; offline builds | [pipelineRules.ts:120](src/core/pipeline/pipelineRules.ts#L120-L139), [devcontainerCli.ts:31](src/core/helper/devcontainerCli.ts#L31-L43) | CLI part confirmed; builder not checkable here | Medium | `pipelineRules.test.ts` |
| D3.19 | Base-image removal by digest; classic vs containerd store | A pulled image keeps the check digest in `RepoDigest`. | Disk cleanup | [environmentService.ts:2442](src/core/pipeline/environmentService.ts#L2442-L2476) | not checkable here (V-9) | Low. Silent disk growth. | `environmentService.test.ts:602-640` |
| D3.20 | Compose and anonymous volume marks | `com.docker.compose.*` labels, `com.docker.volume.anonymous`, and 64-hex names (6.4). | Refusing mounts; keeping volumes on Delete | [hostAccess.ts:567](src/core/helper/hostAccess.ts#L567-L584), [environmentService.ts:2478](src/core/pipeline/environmentService.ts#L2478-L2503) | not checkable here | Medium, security (data loss, cross-project access) | `hostAccess.test.ts:658-673`; `environmentService.test.ts:1766` |

### D4. Other: registries, base images, Git, OS

| # | Dependency | What we rely on | Used for | Where | Checked | Risk | Guarded by test |
|---|---|---|---|---|---|---|---|
| D4.1 | Registry digest semantics | HEAD returns `Docker-Content-Digest`. Registries answer 401/403 (not 404) for private images. The index digest is stable. A Docker Hub HEAD is not counted as a pull. | Update detection without pulling | [registryClient.ts:153](src/core/imageCheck/registryClient.ts#L153-L231), [helperImage.ts:61](src/core/helper/helperImage.ts#L61-L90) | not checkable here (V-9) | Medium. Silent: an answer of 404 means updates are never applied. | Fake transport |
| D4.2 | Helper image inputs | `node:24-trixie-slim`, Debian apt, the `download.docker.com` trixie suite, npm, tini, `NODE_VERSION`/`YARN_VERSION`. | Workspace helper | [Dockerfile:8](resources/helper/Dockerfile#L8-L41), [helperImage.ts:176](src/core/helper/helperImage.ts#L176-L190) | not checkable here (V-10) | High. Loud: nothing can be created until an update. Supply chain: the helper holds the Docker socket. | `test/docker/helperImage.test.ts` (not in `npm test`) |
| D4.3 | Network-failure texts | `could not resolve host`, `dial tcp`, `ENOTFOUND`, … | "Needs internet" message | [pipelineRules.ts:188](src/core/pipeline/pipelineRules.ts#L188-L214) | not checkable here | Low | `pipelineRules.test.ts:199-230` |
| D4.4 | Git in the user's image | `-c safe.directory=*` is honored; `branch --show-current` exists (Git ≥ 2.22). | Git summary; `branchInContainer` | [gitSummary.ts:20](src/core/git/gitSummary.ts#L20-L46), [environmentService.ts:2585](src/core/pipeline/environmentService.ts#L2585-L2603) | not checkable here | Low. Silent: stale counts. | `gitSummary.test.ts:129` |
| D4.5 | `rm` and `stat -c` in the user's image | Needed to remove the owner's token when an account leaves (6.3). | Token removal | [controller.ts:1529](src/vscode/controller.ts#L1529-L1549), [containerGit.ts:221](src/core/helper/containerGit.ts#L221-L236) | not checkable here | Low likelihood, security | `controller.test.ts:1942-2107` (no missing-tool case) |
| D4.6 | Quarantine marks | `com.apple.quarantine` value format; `Zone.Identifier` `ZoneId=3`. | OS check of the installer | [dockerSetup.ts:303](src/core/docker/dockerSetup.ts#L303-L314), [dockerSetup.ts:374](src/vscode/dockerSetup.ts#L374-L385) | not checkable here | Medium, security. Silent: the OS check is lost. | Format only |
| D4.7 | Rosetta detection | `sysctl.proc_translated` = 1 selects the arm64 installer. | Installer choice | [dockerSetup.ts:114](src/vscode/dockerSetup.ts#L114-L118) | public (Apple) | Low | **none** for the `sysctl` call (only `hardwareArch`, `dockerSetup.test.ts:394-404`) |
| D4.8 | `wsl --status` exit code 0 | Means WSL 2 is ready. | Walkthrough step | [dockerSetup.ts:468](src/vscode/dockerSetup.ts#L468-L480) | not checkable here | Low | `dockerSetup.test.ts:513-517` |
| D4.9 | winget location | `%LOCALAPPDATA%\Microsoft\WindowsApps` is in the fixed `PATH`. | Install terminal | [dockerSetup.ts:405](src/core/docker/dockerSetup.ts#L405-L410) | not checkable here | Low | `installTerminalOptions` |
| D4.10 | `~/Downloads` | Download target, not the known folder. | Installer | [dockerSetup.ts:313](src/vscode/dockerSetup.ts#L313-L319) | not checkable here | Low. Cosmetic. | none |

## 6. Problems found while taking the inventory

The problems are ordered by severity. Unauthorized access and data loss come first.

### 6.1 Credentialed pull drops the Docker context's TLS settings (unauthorized access)

**Location**
- [containerAdapter.ts:650-665](src/core/docker/containerAdapter.ts#L650-L665): `envForOwnConfig`.
- The unit test [containerAdapter.test.ts:882-885](src/core/docker/containerAdapter.test.ts#L882-L885) accepts `DOCKER_HOST=tcp://10.0.0.5:2375`.

**What the code does**
- It copies only `.Endpoints.docker.Host` into `DOCKER_HOST`.
- `--config <tmp>` hides the context's TLS files.
- `DOCKER_TLS_VERIFY` and `DOCKER_CERT_PATH` are never derived from the context.

**Scenario**
1. The current context is TLS `tcp://h:2376`, and `DOCKER_HOST` is not set in VS Code's environment.
2. The image is a private ghcr.io image, and Docker has no ghcr.io credentials of its own.
3. The CLI speaks plain HTTP to the TLS port.
4. With `DOCKER_API_VERSION` set, or a Docker CLI older than 25, `POST /images/create` goes out before the server's 400 answer. It carries `X-Registry-Auth` in cleartext, and that header holds the GitHub OAuth token with scopes `repo`, `read:org` and `read:packages` ([auth.ts:17](src/vscode/auth.ts#L17)).
5. Anyone on the network path can read the token. It gives read and write access to the user's private repositories.

With CLI 25 and later and version negotiation, the pull fails loudly at `/_ping` and nothing is sent. This client behavior is known from the moby client; it was not checkable here.

Nothing in `src` refuses `tcp://`, although the concept excludes remote Docker hosts ([vscode-dev-environments.md:123](docs/vscode-dev-environments.md#L123)).

**Severity:** High impact, low likelihood.

**Fix**
- Use the GitHub-session pull only for `unix://`, `npipe://` or `ssh://` endpoints, or for `tcp://` when TLS variables are set.
- Otherwise, use Docker's own pull.
- Alternatively, carry over `SkipTLSVerify` and the context's TLS path (`.Storage.TLSPath`).
- Add a test that refuses a TLS context without TLS variables.

### 6.2 `gh` token push has no second layer (unauthorized access)

**Location:** [containerGit.ts:140](src/core/helper/containerGit.ts#L140). There is no `GH_CONFIG_DIR` in [containerEnvironment](src/core/helper/containerGit.ts#L78-L89).

**Scenario**
1. A Dev Containers version stops honoring the per-container `githubCLILoginWithToken` (A5, A9). Its code default is `true` (gap3:197).
2. It runs `gh auth login --with-token` with the computer's token.
3. `gh` in the environment is signed in as the computer's account, which may be another account than the environment owner.
4. This is silent. Git and Docker have second layers (`GIT_CONFIG_COUNT`, `DOCKER_CONFIG`); `gh` has none.

**Severity:** High, conditional on a Dev Containers change.

**Fix**
- Set `GH_CONFIG_DIR` to a folder in the volume through `containerEnv` and `remoteEnv`.
- At each open, check that folder, for example with `gh auth status` or by the presence of `hosts.yml`, and warn or clear it.
- Add the case to V-8.

### 6.3 Owner token removal depends on tools in the user's image (unauthorized access between accounts)

**Location:** [controller.ts:1529-1549](src/vscode/controller.ts#L1529-L1549) and [containerGit.ts:221-236](src/core/helper/containerGit.ts#L221-L236).

**What the code does:** it runs `docker exec rm`, then `stat -c`.

**Scenario**
1. A window leaves an environment because the signed-in account may not use it.
2. In a distroless image, or an image without `rm` or `stat -c`, both commands fail.
3. The only result is a log warning.
4. The owner's token stays readable in the running container until it stops.

**Severity:** Medium.

**Fix:** Remove the token file through the helper on the workspace volume. The helper does not need any tools in the user's image. Keep `docker exec` only as the first attempt.

### 6.4 Compose and anonymous-volume labels decide ownership (data loss, cross-project access)

**Location:** [hostAccess.ts:567-584](src/core/helper/hostAccess.ts#L567-L584) and [environmentService.ts:2478-2503](src/core/pipeline/environmentService.ts#L2478-L2503).

**What the code does:** it uses a list of foreign labels (`com.docker.compose.*`, `com.docker.volume.anonymous`) to find volumes that belong to other programs. None of these labels is a documented contract.

**Scenario:** Compose renames or drops its labels. Then:
- a repository can mount another project's volume (for example `-v shop_db:/x`) without a refusal;
- Delete can remove a Compose volume that reuses a name the environment recorded earlier.

**Severity:** Medium (silent data loss).

**Fix**
- Invert the rule: delete or keep only volumes the pipeline created and labeled, for example with `devenv.environment-id` set at creation.
- Refuse mounts of any existing volume that has labels the environment did not set.
- Add a `test/docker` case with real Compose.

### 6.5 `runArgs` prefix rules always take a value (host-access bypass, latent)

**Location:** [hostAccess.ts:233-234](src/core/helper/hostAccess.ts#L233-L234), [hostAccess.ts:867-870](src/core/helper/hostAccess.ts#L867-L870) and [hostAccess.ts:935-939](src/core/helper/hostAccess.ts#L935-L939).

**What the code does:** any flag that starts with `--dns`, `--memory` or `--health-` is allowed and takes the next argument as its value.

**Scenario**
1. Docker adds a boolean flag with one of these prefixes.
2. `["--memory-x", "--privileged"]` then passes the policy, with `--privileged` hidden as a value.
3. Docker reads `--privileged` as a flag.

Every current flag with these prefixes takes a value, so this is not exploitable today.

**Severity:** Medium (security, latent).

**Fix:** Replace the prefixes with the explicit list of current flags. Unknown flags then fail closed.

### 6.6 Remote-user rule ignores `runArgs --user` and `user:group` (repository can stay owned by root)

**Location:** [pipelineRules.ts:286-312](src/core/pipeline/pipelineRules.ts#L286-L312) (`imageRemoteUser`), used at [environmentService.ts:1537](src/core/pipeline/environmentService.ts#L1537) and [environmentService.ts:1613-1634](src/core/pipeline/environmentService.ts#L1613-L1634). The ownership fix is `OWNERSHIP_FIX_SCRIPT` at [gitSummary.ts:54-58](src/core/git/gitSummary.ts#L54-L58).

**How the CLI differs (C5)**
- CLI 0.89.0 uses the last `runArgs --user/-u` when the metadata has no `remoteUser`. The policy allows that flag ([hostAccess.ts:148](src/core/helper/hostAccess.ts#L148)).
- The CLI splits `user:group`.

**Scenario with `--user node`**
1. The image user is root, and no `remoteUser` is set, so `runArgs` has `--user node`.
2. The pre-`up` fix resolves `root` and skips.
3. `postCreate` fails as `node` on root-owned files, for example with `EACCES` from `npm install`.
4. `openAfterLifecycleFailure` records `root`, so `finish` skips the fix.
5. The repository stays owned by root while VS Code works as `node`. It is not repaired later, because the fix runs only when the environment was created or cloned.

**Scenario with `user:group`**
- `id -u "user:group"` fails. The fix only logs a warning.

**Severity:** Medium (functional; no exposure).

**Fix**
- Copy the CLI rule: take the last `-u`/`--user`/`-u=`/`--user=` from the configuration's `runArgs` before the image user.
- Split at `:` before `id -u`.
- Add test cases for both.

### 6.7 Dev Containers volume hash rule is too broad

**Location:** [hostAccess.ts:546-548](src/core/helper/hostAccess.ts#L546-L548).

**What the code does:** `/-([0-9a-f]{32}|[0-9a-f]{64})$/` matches any volume name that ends in a 32- or 64-hex suffix.

**Scenario:** A repository's own named volume, for example `cache-<md5>`, is refused as "a volume of the Dev Containers extension". This fails closed and is loud, but the message is wrong.

**Severity:** Low.

**Fix**
- Require the Dev Containers forms (`vsc-<repo>-<hash>` / `<repo>-<hash>`), which are only a hint.
- Combine the name rule with the `vsch.*` labels.
- Or document the refusal in `docs/container-restrictions.md`.

### 6.8 The documented Features cache does not exist

**Location**
- [vscode-dev-environments.md:536](docs/vscode-dev-environments.md#L536): "Features that were downloaded once are available without internet access".
- [implementation-notes.md:91](docs/implementation-notes.md#L91): "Features cache".
- [implementation-notes.md:110](docs/implementation-notes.md#L110): "All calls get `--user-data-folder`". This is wrong for `read-configuration`, which ignores the option anyway. That line also omits `.devcontainer-lock.json`.

**What CLI 0.89.0 does:** it keeps `ociCache` in a per-run `os.tmpdir()` folder, and the helper runs with `--rm` (C7).

**Scenario:** An offline first build or rebuild of a configuration with Features fails.

**Severity:** Low (documentation; the loud failure matches FR-13).

**Fix**
- Correct the three doc lines.
- Answer V-10 with "no".
- Optionally mount a volume at the CLI's temp folder, if offline Features are wanted.

### 6.9 Doc comments that contradict the code or are unverified

**`containerGit.ts:9` says "documented settings"**
- [containerGit.ts:9](src/core/helper/containerGit.ts#L9) (and "its documented settings" at [containerGit.ts:117](src/core/helper/containerGit.ts#L117)) describe the mechanism as documented.
- [containerGit.ts:130](src/core/helper/containerGit.ts#L130) says the per-container reading is "not documented", and A5 shows it is internal.
- **Fix:** say "internal, per-container use of documented settings (V-8)". **Severity:** Low (misleading for reviewers of NFR-06).

**Lookup order "as in the Docker CLI"**
- [credentials.ts:62-66](src/core/imageCheck/credentials.ts#L62-L66) claims this order. It is unverified, and it differs: the CLI overlays the helper result on the file entry.
- **Effect:** the image check may use credentials that `docker pull` does not. The GitHub fallback is then skipped ([pullCredentials.ts:37](src/core/pipeline/pullCredentials.ts#L37)), and the pull fails loudly.
- **Fix:** match the CLI order, or mark the comment as an assumption. **Severity:** Low.

**`branchInContainer` has no fallback for old Git**
- [environmentService.ts:2585-2603](src/core/pipeline/environmentService.ts#L2585-L2603) lacks the `symbolic-ref` fallback that [gitSummary.ts:38](src/core/git/gitSummary.ts#L38) has.
- **Effect:** with Git older than 2.22 it returns `undefined`.
- **Fix:** reuse the summary's fallback. **Severity:** Low.

**Activation literal not tied to the constant**
- [package.json:34](package.json#L34) has no test that ties it to `ATTACHED_CONTAINER`.
- **Fix:** add a manifest test. **Severity:** Low.

**Dead branch in `LIFECYCLE_FAILURE`**
- Its `postAttach` alternative can never match, because `up` always gets `--skip-post-attach`.
- **Severity:** Cosmetic.

## 7. What breaks first and what to do

- **A Dev Containers release changes per-container settings or the attach flow (A5, A9, B2).** This fails silently and forwards credentials again.
  - Add a post-attach self-check: `docker exec` the container once per open, and verify that `Machine/settings.json` holds the five keys, that there is no `credential.helper` forwarder, and that there is no `gh` `hosts.yml`.
  - Warn when any check fails.
  - Add `GH_CONFIG_DIR` (6.2).
  - Run V-8 against every new Dev Containers release before changing the supported range.
- **Authority or `attached-container` changes (A1, A3).** Start fails loudly.
  - Keep the literal in one module.
  - Test `package.json:34` against it.
  - Run the V-2 manual check on each Dev Containers update.
- **A CLI bump beyond 0.89.0.** The contract test passes as long as the options stay.
  - Extend it with bundle checks like the lifecycle template: result-line fields (C3), label order (C1), override replaces config (C11), `--id-label` uses `ps -a` (C10), and `read-configuration` output keys (C6).
  - Fix C5 in the same change.
- **Fix 6.1 now.** It is a small, local code change that closes a token-exposure path.
- **Restore NFR-06, or restate it.**
  - Move the Dev Containers knowledge into one module, for example `src/core/devContainers.ts`: the settings keys, `kv` notes, volume names and labels, the `attached-container` literal, and the `remote.localPortHost` reason.
  - Or change NFR-06 to list the files in section 1.

## Method

**Finders.** 5 independent finders looked at the connection, the attach flow, internals, the CLI, and a sweep of the rest. They produced 80 candidates.

**Verifiers.** 4 verifiers, one each for Dev Containers, the CLI, VS Code, and externals, merged duplicates and dropped none. They kept 69 items and found 16 more that the finders missed.

**Critics.** 3 completeness-critic rounds added 28 items (18, then 8, then 2) and applied 18 corrections. The last round checked 78 source files. It did not add 6 items: 5 public-spec replications and 1 OS behavior.

**Merge.** Four cross-file duplicates were merged into one row each:
- the OAuth client id;
- activation blocking the connection (together with the activation-event item);
- `remote.localPortHost` and the machine settings;
- the Docker "No such" error texts (together with the helper exit-125 case).

**Result.** 109 verified items: A 20, B 5, C 17, D1 28, D2 9, D3 20, D4 10.
