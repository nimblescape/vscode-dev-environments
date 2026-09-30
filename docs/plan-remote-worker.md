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
| 2026-09-29 | **The worker is used for the local Docker too**, not only for a remote host: one worker per window and engine, with the same routing, fallback and engine check (plan step 5, PR A). |
| 2026-09-29 | **One mechanism fills the containers: the pipe.** The container runs a small loader; the extension (or the worker, for its helpers) writes the bundle from the `.vsix` as the first line of stdin; the loader stores it in the container and starts it. Communication goes over stdin/stdout of `docker … -a -i`. |
| 2026-09-29 | **Steps run inside the worker.** The worker is the trusted boundary. Exception: steps that need an environment's volume are delegated to **one helper container per operation**, which the worker starts locally with that volume. The helper is loaded through the same pipe and runs the operation's **whole batch** (for example clone, configuration reads, build, `up`, lifecycle commands, token write, Git config, ownership fix) — never one container per step. |
| 2026-09-29 | Inside a helper, Git runs as a user without access to the Docker socket; the token is sent only with the request that needs it and stays in memory. |
| 2026-09-29 | **Concurrency**: an environment lock on the Docker host (a `flock` per environment in the monitor's state volume) for the whole operation, released when the process ends; the local busy mark stays as the first stage. Operations that change the working copy check for Git lock files and uncommitted changes and refuse instead of forcing; read-only Git steps use `--no-optional-locks`. |
| 2026-09-28 | The **remote Session Monitor** stays one container per engine and never accepts connections. Heartbeats, the "in use elsewhere" check and `forget` become operations of the local Session Monitor's own worker, which runs `docker exec` on the monitor container locally. After a restart the monitor resumes from its stored script. |
| 2026-09-29 | **A helper failure during an update fails the open** (the build, the Git setup before `up`, `up`, the lifecycle commands, the restore): the environment is never opened as it is after the helper was prepared. When the helper cannot be prepared at the start while the container already runs and need not be created again, it still opens as it is (not a container whose lifecycle commands did not run: the registry marks it, `lifecycleIncomplete`; when that cannot be written, the window remembers it and the user is told to stop or rebuild before working in it). A step without a busy mark (Step 9, and the withdrawal after a failed helper) sets one before it stops, removes, or renames a container, and changes nothing while another window is connected, opening, or busy, or when that cannot be checked (review round 4 of PR #68). The window files are read with that mark held, after a fresh listing of all containers of the environment: when none runs, a status file of another window (whose connection is lost) does not count, only its pending file, a busy mark, or files that cannot be read; while one runs, a live window whose status file is late but not stale by the Session Monitor's rule counts as "not known". The recreate question is asked without the mark of Step 9, and the recreation checks the other windows again after the answer (review round 5 of PR #68). |
| 2026-09-29 | **No previous helper image.** There shall be no case in which an open needs an older helper image: the previous-helper fallback of PR #64 is removed again. The current helper image is built ahead of time (in the background after an extension update, before an open needs it); an open that still finds no helper image fails with "The workspace helper could not be prepared." Pinning the image of an open by its ID stays. |
| 2026-09-28 | **Names**: container named by its 8-hex short ID; the Docker context named after the SSH profile or host; image `devenv-<owner>-<repo>-<adjective>-<scientist>:<n>`. No compatibility for old names. |
| 2026-09-29 | **Versions**: no migration code for files, windows, names or data until release; all container upgrade mechanisms stay and are exercised now (container version label and recreate, monitor label, local monitor protocol version, registry version). |
| 2026-09-28 | Not planned: a Go agent on the host, Remote Tunnels, credential helpers that read the token through the worker, SSH ControlMaster settings. |
| 2026-09-30 | **D1: a consistent state before every operation** (a general rule for every operation and every phase). Before any operation runs, the extension checks that the state is consistent and repairs it if not (for example, it builds a missing helper image and opens the worker). If it cannot be repaired, the operation is refused with a clear message that names the cause. The extension never works around an inconsistent state: no fallback to the direct path, no proceeding without the lock, and no treating unreadable state as "nothing there". This replaces the fallback to the direct path of the decision of 2026-09-28. Step 5, PR B applies it to Stop and Delete (the helper image, then the worker with the lock; the open backoff is cleared for this attempt; "Docker is not running" stays its own refusal); PR D applies it to the code that is already merged (section 5). |
| 2026-09-30 | **D2: the lock in step 5 covers Stop and Delete only.** Start, Rebuild, Select configuration and Clone again take it in step 6, Switch branch in step 7, and the automatic stops in step 8, as each is moved into the worker. Until step 6, a Start from another computer is not locked against a Delete here. |
| 2026-09-30 | **D3: a lock held by another window or computer** is waited for 10 s (`flock -w 10`); then the operation is refused with "…is busy with an operation from another window or computer; try again in a moment". No retry loop. |
| 2026-09-30 | **Local and remote work the same.** "There is no reason why the remote and local environments shall work differently. All remote functionality is the same locally. Just targeting a different docker engine, that is switched via the context." The lock, the ensure-or-refuse step and the worker behave the same for the local and a remote Docker; the only difference is the Docker context and the engine that it points to. |

## 3. Steps

Every step is its own pull request: local checks, CI (`test`, `docker`), review rounds until a round finds nothing new, squash merge.

| # | Step | Content | Status |
|---|---|---|---|
| 1 | Cleanup of old monitor data | old records, leftover files, capped monitor log | merged (PR #63) |
| 2 | No `docker start` fallback | pinned helper image per open, build label; the previous-helper fallback is removed again | merged (PR #64) |
| 3 | Pipe loading | one loader for the worker, its helpers and the monitor; the script size limit goes away | merged (PR #69) |
| 4 | Hanging `docker stop` | measure the gap between monitor ticks from the end of the previous tick | merged (PR #70) |
| 5 | Worker: operations and environment lock | every plain Docker call, the batched refresh (containers and branches), Stop, the Docker part of Delete; the `flock` per environment | in progress: PR A routing merged (PR #71), PR C batched refresh merged (PR #72), PR B environment lock in review; PR D follows: it applies the rule D1 of 2026-09-30 to the merged code (section 5) |
| 6 | Worker: Start batch | one helper per operation runs the bootstrap batch; covers Start, Rebuild, Select configuration, Clone again | queued |
| 7 | Worker: Switch branch and Delete's check | a batch in one helper, with the working-copy checks | queued |
| 8 | Worker: Session Monitor | heartbeats, "in use elsewhere", `forget`, automatic stops | queued |
| 9 | Naming 1 | container short ID; Docker context named after the SSH host | queued |
| 10 | Naming 2 | readable image names with the reworked image checks | queued |

After steps 5–8: live checks on a real remote host (refresh time, first and later Start, heartbeats after sleep, Cancel during a Start), because CI has no SSH host.

Also merged outside this table: PR #68, a helper failure during an update fails the open (decision of 2026-09-29).

## 4. Open decisions

None. D1, D2 and D3 were decided on 2026-09-30 (section 2).

Assumption to confirm (no change planned): the "hard deadline" of the 2026-09-28 decision is the worker's existing shutdown deadline (40 s) and exit timer (45 s); there is no absolute lifetime. A held lock operation has a 2-hour limit as a backstop.

## 5. Known gaps left to later steps

Found in review and left on purpose, because the named step replaces the code (user rule: do not fix what a later phase replaces).

| Gap | Effect | Replaced by |
|---|---|---|
| A session folder that cannot be read (permissions, disk error) reads as "no other window" | The other-window checks can pass when they should refuse | Step 5, PR D (rule D1 of 2026-09-30: unreadable state is never "nothing there") |
| The routing of PR A takes the direct path when no worker is available | Plain Docker calls of an operation run without the worker | Step 5, PR D (rule D1 of 2026-09-30: ensure the worker, or refuse) |
| The refresh of PR C reads directly when no worker is available | The refresh runs without the worker | Step 5, PR D (rule D1 of 2026-09-30: ensure the worker, or refuse) |
| A remote monitor restarted by Docker whose stored-script check is cut off by its exit is kept | The monitor stays in an exit-3 loop until the next open | Step 8 (the Session Monitor's work in the worker) |

