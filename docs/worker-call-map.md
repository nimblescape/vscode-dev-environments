# Call map: what the flows do on the Docker engine (state of 2026-10-03, before step 11)

Reference for plan step 11 (docs/plan-remote-worker.md): what moves into the worker, so no flow is forgotten. Line numbers are those of commit `e3cc65c` and drift; the function names stay.

Ways a call travels today: **relay** (`docker` operation through the lock's worker or the router, one round trip), **batch** (a step of the batch helper), **worker op** (`lock`, `refresh`, `batch`, `pull`, `startContainers`, …), **direct** (the local Docker CLI, one SSH session on a remote host), **local** (no Docker).

## Round trips per flow (remote host, worker open)

| Flow | Relay | Batch | Worker op | Direct |
|---|---|---|---|---|
| Start of a stopped container, unchanged | ~30–40 | ~7 | 3–4 | 2–4 (+2 in the background) |
| Open of a running container | ~25–35 | ~6 | 3 | 2–4 |
| First open (build, single container) | ~70–100 | ~10 | 4 + pulls | ~6–8 |
| Rebuild | ~55–80 | ~9 | 3 + pulls | 3–5 |
| Docker Compose, on top | +20–40 | +2–4 | | |
| Stop | 6 + n | 0 | 2 | 2 |
| Delete (warning, questions, removal) | ~40–60 | 0 | 2 | 2–3 |
| Refresh | 0 | 0 | 1 | 1–2 |
| Heartbeat tick | 1–2 | 0 | 0 | 0 |
| Window release | 3–5 | 0 | 0 | 0 |
| Token removal (window leaves, account changes) | 0 | 0 | 0 | 3–4 |

## Flows and their parts (all move into the worker in step 11)

- **Open** (`EnvironmentService.openFirst`, `openExisting`, `runPipeline`): volume ownership and creation, clone, the configuration files and the configuration (plain, merged, Docker Compose model and hash), the host access analysis and its facts (volumes, networks, containers, images and their labels), the image record (`adoptImageRecord`, `pinnedImagePresent`), the image update check (registry HTTP), pull, build, labels, removal of old images and base images, the helper image of the open and its maintenance, the Session Monitor ensure and the first heartbeat, the monitor's settings and image list, `up` or Docker Compose `up` with the volumes, folders, ownership before the create, Git files, the token write, the home `.gitconfig`, the lifecycle commands, the recorded volumes, the ownership fix, the user IDs, `git --version`, the workspace identities, the existing service folders, the Git state; the recreate of an outdated or damaged container; the start of stopped side services; the withdraw after a helper failure; the removal after a failed first open.
- **Select configuration** (listing in the batch helper, then the Rebuild path), **Clone again** (new volume, clone, or Delete).
- **Stop** (Git state, stop of the dev container and of the side services), **Close and Keep Running** (heartbeat).
- **Delete** (warning from the Git state, the removable volumes, the removal of containers, the Compose project, images, base images, volumes, `forget` in the monitor).
- **Refresh** (already the worker op `refresh`).
- **Heartbeats** (verify, send, repair with monitor ensure), **window release** (Git state, release heartbeat).
- **Token removal** and the window-side reads (`containerOutdated`, `containerRuns`, `containerStateText`, `currentBranch`), today outside any operation and direct.
- **Registry rebuild from the volumes** (`reconcileFromVolumes`, also at activation, direct there).

## Bypasses found (not bootstrap)

1. Direct while the lock is held: the label build (`labelImage`), the ownership `docker run` before the create (a second container on the volume), the monitor's `start`, `run -i` and `exec -i`, the helper image rebuild of the maintenance.
2. Direct outside any operation: token removal, `containerOutdated`, `containerRuns` / `containerStateText`, `currentBranch`, the reconcile at activation, the sidebar's `isRunning`.
3. The remote "is Docker running" check goes through the worker, so the worker is opened before Docker is known to run (`checkCurrentEngine`).
4. Repeated work: `requireVolume` before each step (~8 per open), the removable volumes of Delete computed three times, `findContainer` and the Compose container list read several times, one `startContainers` per container.

## Where a flow needs the user's computer

- **Questions to the user**: the trust of a new repository; files missing (Clone again or Delete); the kind of the configuration changed; the configuration changed (Rebuild now or later); the recreate offer; Delete's questions; the configuration pick of Select configuration.
- **Local state**: the registry, the window status, pending and busy files (`otherWindowOf`, `requireNoOtherWindow` before removing, renaming or recreating a container), the remembered refused update.
- **Local secrets**: the GitHub session (token, packages), the registry credentials that Docker stored (`docker-credential-*`, `config.json`).
- **Local network**: the GitHub API (identity, package repositories).
