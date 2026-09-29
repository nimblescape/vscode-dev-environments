# Plan: Remote Worker and Open Work

This is the agreed plan for the remote worker and the work queue around it (user decisions 2026-09-28 and 2026-09-29). It is the reference for the next pull requests. Update it when a step is merged or a decision changes.

## 1. Why

On a remote Docker host every Docker call of the extension opens its own SSH connection (about 1.6 s), and every helper step starts, runs and removes its own container. A first Start needs 15–30 such calls, including about 8 helper containers. The remote worker pays the connection once and runs the work next to the engine.

## 2. Decisions

| Date | Decision |
|---|---|
| 2026-09-28 | A **worker** per window and Docker host, never shared between users or windows. Opened on first use, closed after 10 minutes idle, reopened after a break. Request ids, cancel per request, a version check at start, and a fallback to the direct path when it cannot be opened. |
| 2026-09-28 | The worker **ends itself** when it loses its connection (end of input, 60 s silence with a ping every 15 s, 15 minutes without an operation, a hard deadline, `--rm`). No remote cleanup is possible or needed. Cancel removes what the worker started. |
| 2026-09-28 | **Operations interface**: the extension sends JSON operations; the worker runs all steps of an operation on that machine and reports progress. |
| 2026-09-28 | **Progress and output go to the local log** (Dev Environments output), as detailed as the worker logs and records the results. The GitHub token is masked everywhere. |
| 2026-09-29 | **The worker does everything the extension does on a Docker engine**: Start, build, Rebuild, Select configuration, Stop, Delete, Switch branch, refreshes and the Session Monitor's work. **It works the same for local and remote Docker.** |
| 2026-09-29 | **One mechanism fills the containers: the pipe.** The container runs a small loader; the extension (or the worker, for its helpers) writes the bundle from the `.vsix` as the first line of stdin; the loader stores it in the container and starts it. Communication goes over stdin/stdout of `docker … -a -i`. |
| 2026-09-29 | **Steps run inside the worker.** The worker is the trusted boundary. Exception: steps that need an environment's volume are delegated to **one helper container per operation**, which the worker starts locally with that volume. The helper is loaded through the same pipe and runs the operation's **whole batch** (for example clone, configuration reads, build, `up`, lifecycle commands, token write, Git config, ownership fix) — never one container per step. |
| 2026-09-29 | Inside a helper, Git runs as a user without access to the Docker socket; the token is sent only with the request that needs it and stays in memory. |
| 2026-09-29 | **Concurrency**: an environment lock on the Docker host (a `flock` per environment in the monitor's state volume) for the whole operation, released when the process ends; the local busy mark stays as the first stage. Operations that change the working copy check for Git lock files and uncommitted changes and refuse instead of forcing; read-only Git steps use `--no-optional-locks`. |
| 2026-09-28 | The **remote Session Monitor** stays one container per engine and never accepts connections. Heartbeats, the "in use elsewhere" check and `forget` become operations of the local Session Monitor's own worker, which runs `docker exec` on the monitor container locally. After a restart the monitor resumes from its stored script. |
| 2026-09-29 | **No previous helper image.** There shall be no case in which an open needs an older helper image: the previous-helper fallback of PR #64 is removed again. The current helper image is built ahead of time (in the background after an extension update, before an open needs it); an open that still finds no helper image fails with "The workspace helper could not be prepared." Pinning the image of an open by its ID stays. |
| 2026-09-28 | **Names**: container named by its 8-hex short ID; the Docker context named after the SSH profile or host; image `devenv-<owner>-<repo>-<adjective>-<scientist>:<n>`. No compatibility for old names. |
| 2026-09-29 | **Versions**: no migration code for files, windows, names or data until release; all container upgrade mechanisms stay and are exercised now (container version label and recreate, monitor label, local monitor protocol version, registry version). |
| 2026-09-28 | Not planned: a Go agent on the host, Remote Tunnels, credential helpers that read the token through the worker, SSH ControlMaster settings. |

## 3. Steps

Every step is its own pull request: local checks, CI (`test`, `docker`), review rounds until a round finds nothing new, squash merge.

| # | Step | Content | Status |
|---|---|---|---|
| 1 | Cleanup of old monitor data | old records, leftover files, capped monitor log | PR #63 in review |
| 2 | No `docker start` fallback | pinned helper image per open, build label; the previous-helper fallback is removed again | PR #64 in review |
| 3 | Pipe loading | one loader for the worker, its helpers and the monitor; the script size limit goes away | next |
| 4 | Hanging `docker stop` | measure the gap between monitor ticks from the end of the previous tick | queued |
| 5 | Worker: operations and environment lock | every plain Docker call, the batched refresh (containers and branches), Stop, the Docker part of Delete; the `flock` per environment | queued |
| 6 | Worker: Start batch | one helper per operation runs the bootstrap batch; covers Start, Rebuild, Select configuration, Clone again | queued |
| 7 | Worker: Switch branch and Delete's check | a batch in one helper, with the working-copy checks | queued |
| 8 | Worker: Session Monitor | heartbeats, "in use elsewhere", `forget`, automatic stops | queued |
| 9 | Naming 1 | container short ID; Docker context named after the SSH host | queued |
| 10 | Naming 2 | readable image names with the reworked image checks | queued |

After steps 5–8: live checks on a real remote host (refresh time, first and later Start, heartbeats after sleep, Cancel during a Start), because CI has no SSH host.
