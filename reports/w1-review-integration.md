I applied the cross-area changes from all five reports, except a few listed at the end. `docker info` worked (Docker is reachable again), so I ran `npm run test:docker`, and it passes. Nothing is committed.

**Command results**
- `npx tsc --noEmit`: 0 errors.
- `npx vitest run`: 57 files, 1730 tests passed (1709 before; 21 new).
- `node esbuild.mjs --production` and `npm run package`: OK. `vsce ls --no-dependencies` lists exactly the six expected files: `package.json`, `README.md`, `dist/extension.js`, `dist/sessionMonitor.js`, `resources/icon.svg`, `resources/helper/Dockerfile`.
- `npm run test:docker`: 28/28 passed (25 before, 3 new scenarios). The teardown found no Docker objects left behind and none of yours removed.
- Nothing is failing.

**Code changes**
- **Host access** (in `environmentService.ts`):
  - A refusal now separates settings that need your computer from options Dev Environments doesn't know. The message code stays `hostAccess`. New texts: `Messages.unsupportedOptions` and `Messages.hostAccessAndUnsupported`.
  - Before `up`, the `runArgs` exactly as Docker gets them are checked again, before anything else runs.
- **Old Git**: every new container now has its Git version checked. Git older than 2.9 shows a warning (`Messages.oldGit`); Git 2.9 to 2.31 only gets a log line. Comments that still said "empty ~/.gitconfig" are fixed.
- **`${localEnv}` warning**: it now names the variables that get the workspace helper's own values, for example HOME=/root (new `HELPER_ENV_NAMES` in `localEnv.ts`).
- **Refused updates**: `refusedUpdate` is now a proper field of the registry entry and is checked when the registry is read.
- **Texts**:
  - The texts for refused updates and recreated containers moved into `messages.ts`.
  - The three texts for "older environment not assigned yet" are now one, `Messages.olderEnvironmentNotAssigned`, with its own error code `environmentUnassigned` (warning, Try again).
- **Claims**:
  - `extension.ts` uses the quiet repository lookup (no repository names in the log) and asks you with a modal Assign / Not now before an older environment is assigned (`VsCodePipelineUi.confirmAssignment`).
  - The environment service now gets `claims`.
  - Start and other commands can ask you; restored windows never ask.
- **Refactoring**: two container labels and the volume-name pattern moved into `names.ts`. The code comments in `hostAccess.ts` now mention the `--network host` exception.
- **Docker tests**: they now expect the new Git variables and the new `~/.gitconfig`. New scenarios: a credential helper you add for another host works, but never for github.com; a removed token file gives no password; Git 2.30 (Alpine 3.13 image) still gets the owner's token and identity.

**Docs** (concept, implementation notes, README, `container-restrictions.md`, and a note in the spec): updated where behaviour changed. That covers the claim rules, sign-out handling, the "Environment of another account" row, refused options, refused updates, the recreated-container texts, the Git variables and `~/.gitconfig`, and when the token is removed. In `container-restrictions.md`, known gaps 1 and 2 are marked fixed. I also rewrote the planned fix for gap 3: it no longer removes the IPC socket, because your requirement (a) needs it. Port forwarding, `$BROWSER` and the network are unchanged, as your requirements (a) and (b) say.

**Not applied, with reasons**
- **Command to assign older environments, and the "older environments exist" notification:** both would show you environments that are meant to stay hidden until claimed, which the spec forbids. I removed the two unused texts; the core function behind the command stays, unused. This needs your decision.
- **Skipping the merged configuration read when the image exists and there is no container (optional):** it would drop the check of Features before a build.
- **Removing the token from stopped containers through the helper (optional):** the token is now removed only from running containers.
- **Moving the controller and tree texts into `messages.ts` (optional):** skipped.

`docs/container-restrictions.md` was changed on disk by someone else while I worked. Its "Docker in Docker" section is gone and the gaps section was renumbered. I kept that version and only made targeted edits on top.

Main files changed:
- `/Users/hs/workspace/projects/vscode-dev-environments/src/core/pipeline/environmentService.ts`
- `/Users/hs/workspace/projects/vscode-dev-environments/src/vscode/extension.ts`
- `/Users/hs/workspace/projects/vscode-dev-environments/src/vscode/controller.ts`
- `/Users/hs/workspace/projects/vscode-dev-environments/test/docker/pipeline.test.ts`