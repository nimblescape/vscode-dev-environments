# Unit 1b, step A3 report: known gaps 3 to 7, adapted to the user decision of 2026-09-25

Verification at the end of A3 (before B1 started): `npx tsc --noEmit` clean, `npx vitest run` 2051 tests, `node esbuild.mjs --production` OK, `npm run test:docker` 32/32. Breaking each new rule on purpose (24 edits) made at least one test fail every time.

## How the user decision changed the step
- No Dev Containers or VS Code server variable is set any more: the committed `remoteEnv SSH_AUTH_SOCK=''` is removed, and `REMOTE_CONTAINERS_IPC=''` is not added.
- The GPG workaround is gone: the placeholder in `private-keys-v1.d` is removed, and `GNUPGHOME` too (without the placeholder, Dev Containers forwards the GPG agent to wherever `GNUPGHOME` points, so the variable protected nothing). A `gnupg/` folder from an earlier version stays untouched in existing volumes (it may hold the user's keys).
- The `~/.gitconfig` no longer relies on the Dev Containers skip rule: the literal copy of that rule, the "append to files with only [safe]/[filter]" logic and the empty `~/.config/git/config` are removed. `~/.gitconfig` is written only when it is missing or empty, and only for Git older than 2.32 and for processes without the variables.
- Only documented variables remain: `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, `GIT_SSH_COMMAND=ssh -o IdentityAgent=none`, `DOCKER_CONFIG`. `GIT_CONFIG_PARAMETERS` is removed (undocumented). `remoteEnv` equals `containerEnv`.
- Dev Containers features are switched off only through their settings: the override carries `customizations.vscode.settings` with five keys (`dev.containers.copyGitConfig` and `remote.containers.copyGitConfig` false, `dev.containers.gitCredentialHelperConfigLocation` "none", `dev.containers.dockerCredentialHelper` false, `dev.containers.githubCLILoginWithToken` false), marked `// Assumption (V-8)`. `CONTAINER_VERSION` is 3, so existing containers are recreated once at the next open.
- Limits documented in docs/container-restrictions.md section 10 and concept section 9: the IPC socket, the SSH agent socket and the GPG agent socket still exist and a process that looks for them can use them; Git does not use them.

## Each gap
- Gap 3: fixed through the settings only; `$BROWSER`, `openExternal`, Open in Browser and port forwarding untouched (A1 findings hold). Live checks added to V-8.
- Gap 4: named volumes refused when they belong to something else — by name (`vscode`, `vsc-remote-containers`, names ending in an MD5/SHA-256 hash = Dev Containers clone volumes); volumes used by environments of other accounts (from the registry; entries without owner don't count); existing volumes whose labels show another owner (Docker Compose, Dev Containers `vsch.*`, anonymous volumes, `devenv.environment-id`), read with `docker volume inspect`. Limit: a volume without such labels can still be mounted.
- Gap 5: labels whose key starts with `devenv.` or `devcontainer.` are refused as "not supported", except the extension's own two labels. The Docker test label was renamed from `devenv.test-run` to `devenv-test.run`.
- Gap 6: refused in `-e`/`--env`, `containerEnv` and `remoteEnv` of the repository and of the image metadata (Features, base image): the variables the extension sets plus every other `GIT_CONFIG*`. The merged configuration is not checked (for an existing container it holds the extension's own values). `--env-file` stays allowed below `/workspaces`; its content is not checked (documented limit).
- Gap 7: documented as a known limit.
- Gap 9 (new, from A1): `remote.localPortHost` other than `localhost` in the configuration's VS Code settings is refused.

## Accepted results (recorded in specs/spec-decisions-policy-per-account.md)
1. A repository configuration MAY set `SSH_AUTH_SOCK`, `REMOTE_CONTAINERS_IPC` and `GNUPGHOME` itself (the extension no longer sets them; no access to the computer).
2. Git 2.9 to 2.30 gets the container's credential settings only through `~/.gitconfig`; limit documented; github.com always gets only the owner's token.

## Changed files
`src/core/helper/{containerGit,hostAccess,devcontainerCli,scripts,workspaceHelper}.ts`, `src/core/names.ts`, `src/core/docker/containerAdapter.ts` (new `inspectVolumes`), `src/core/pipeline/environmentService.ts` (`hostAccessInput`, the three checks) and `environmentService.testkit.ts`, their tests, `src/core/pipeline/pipelineRules.test.ts`, `test/docker/{pipeline.test,dockerRun,helperImage.test}.ts`, docs (container-restrictions, concept, notes, README).
