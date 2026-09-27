# Concept: a Docker in a VM per account, locally and on a remote machine (not planned yet)

Status: idea, kept for later, for local and remote Docker hosts. Nothing here is implemented. The facts about the VM
tools below were checked against their documentation sources in September 2026; check them again before any work
starts.

## Why

All environments share one Docker. A repository can therefore reach what that Docker holds for other environments:
their local images (including private images pulled with another account's credentials), their build cache, and,
through tricks in the build, more of the same. The host access checks cannot close this reliably: they would have to
predict how the Dev Container CLI, Compose, and BuildKit read and rewrite a configuration, and these change with
every version (see "Known limits" and "Hardening your computer" in the README, and docs/container-restrictions.md).

A boundary does not need that prediction. If each GitHub account has its own Docker, inside its own virtual
machine, the images, containers, volumes, and build cache of other accounts are not reachable, whatever the
configuration says. GitHub Codespaces works this way: each codespace runs in its own newly built virtual machine with
its own isolated network, and the configuration is not judged.

## Idea

- Each GitHub account gets its own Docker endpoint: the shared local Docker (today), a local VM, or a remote host.
- For a local VM, Dev Environments creates the VM at first use, starts it when needed, stops it after some idle time,
  and limits its CPU, memory, and disk.
- Every Docker call for that account goes to its endpoint: the workspace helper, the build, the volumes, the Session
  Monitor. The repositories already live in volumes, so nothing of the computer needs to be shared into the VM. Lima
  and Colima share the home folder into the VM by default (Lima read-only, Colima writable): the VM must be created
  with these shares switched off, or the files of the computer are not protected.
- VS Code attaches to the container through that endpoint (the Dev Containers extension supports remote Docker
  endpoints: `DOCKER_HOST` with `ssh://` or `tcp://`, Docker contexts, `containers.environment`).

**What this needs in Dev Environments (today there is one endpoint per process):**

- Dev Environments talks to Docker through the one endpoint of its environment (`DOCKER_HOST` or the current Docker
  context); the Session Monitor uses its own process environment.
- The workspace helper also mounts the engine's socket by path, guessed as `/var/run/docker.sock` (a `unix://` path
  from `DOCKER_HOST` only on Linux). A rootless Docker has its socket at `/run/user/<uid>/docker.sock`, so the socket
  path must come from the endpoint.
- The Dev Containers extension chooses one endpoint for all of VS Code, not per window. A way to make each window
  attach through its account's endpoint has to be found first (to be checked).

## Possible VM providers

| Computer | Provider | Notes |
|---|---|---|
| macOS | Lima or Colima (Apple Virtualization framework, the default on current macOS) | One instance or profile per VM, each with its own Docker behind a forwarded socket. Switch off the default home-folder share. |
| Linux | Lima with QEMU/KVM | The same tool as on macOS. Lighter alternatives: rootless Docker in a separate user account, or Kata Containers (a small VM per container, needs KVM). |
| Windows | A separate WSL 2 distribution with its own Docker | Simple, but all WSL 2 distributions run in one VM: they share the kernel, the network (localhost), and the devices; only files, processes, and Docker are separate. Windows drives are mounted into each distribution unless automount is switched off in `wsl.conf`. A real VM needs Hyper-V: Lima's usual Windows driver (`wsl2`, experimental) is only another WSL distribution; a separate VM is possible with Lima's `hcs` driver (Hyper-V, experimental, Lima 2.3 or later, Windows 11) or with QEMU. |

## What it protects, and what not

- Protected (with the home-folder share switched off): the files and the Docker of the computer, and the images,
  containers, volumes, and build cache of other accounts. The image and Dockerfile checks become a second line; the
  host access checks stay as a guard rail.
- Not protected:
  - the channels that VS Code opens from the container to the computer (SSH and GPG agents, the credential socket,
    opening URLs, clipboard, X11). The window runs on the computer, so these stay. Only a separate user account on the
    computer, or a browser-based editor, closes them;
  - the network: from the VM, a container can reach the ports on the computer's localhost (Lima:
    `host.lima.internal`), including ports forwarded for other accounts' environments, and the local network, unless
    the VM's network is restricted.

## Costs

- Memory: 2 to 4 GB for each running VM with the defaults of Colima and Lima (it can be set lower, about 1 to 2 GB for
  small projects); disk: every VM stores its own images.
- A slower first start, a VM image to keep up to date, and port forwarding through the VM.

## The remote case: VMs on the remote machine

With a remote Docker host (unit 7) there is one machine, and today one shared Docker on it. The same boundary can be
built on that machine: instead of one Docker, the machine runs one VM (or one separated Docker) per GitHub account,
and Dev Environments reaches each through SSH.

**How Dev Environments would use it.** For a remote machine, the endpoint of an account becomes
`ssh://<user>@<machine>` plus the Docker socket of that account's VM or user (for example
`ssh://devenv-<account>@<machine>/run/user/<uid>/docker.sock`; without a path, the remote side uses its default
socket). Dev Environments asks the machine over SSH to create or start that VM, then points `DOCKER_HOST` (or a Docker
context) at it; the VS Code window attaches through the same endpoint (see the open point on per-window endpoints
above).

**Ways to isolate accounts on the remote machine:**

| Way | What the machine needs | Isolation |
|---|---|---|
| Lima on Linux (`limactl create/start/stop`), each instance with its own Docker | KVM: a physical machine, or a cloud VM with nested virtualization | A VM per account, as locally. The same tool as on macOS and Linux computers. |
| libvirt/QEMU (`virsh`) with a small VM image that runs Docker | KVM | The same, with more setup; fits machines that already use libvirt or Proxmox. |
| Kata Containers or gVisor as the runtime of the one Docker | KVM (Kata) or no virtualization (gVisor) | Each container gets its own small VM or user-space kernel. It isolates containers from the machine, but images and build cache stay shared between accounts; whether build steps also run under that runtime is to be checked. |
| One Linux user per account, each with its own rootless Docker | No virtualization; per user: the rootless setup (uidmap, subuid/subgid ranges, systemd lingering) and an endpoint that names that user's socket | No VM: the kernel is shared. The images, containers, volumes, and build cache of the accounts are separate, and none of them runs as root. The lightest and most portable way. |

**Docker inside the environment (docker-in-docker, docker-outside-of-docker).** With a VM per account, both work as
today inside the VM. With a rootless Docker per user, mounting the socket gives control of that account's Docker only;
docker-in-docker needs `--privileged`, which then covers only the user's namespace, and works only on hosts with
cgroup v2 delegation and a rootless storage driver (to be tested).

**A small agent on the machine.** Creating users or VMs needs rights on the machine. Dev Environments should not get
a root shell for this. A small, audited helper on the machine (for example a command allowed in `authorized_keys` or
`sudoers`) can offer exactly "create, start, stop, remove the VM or Docker of account X" and nothing else.

**If the remote machine is itself a cloud VM**, nested virtualization must be available for its machine type and
switched on for Lima, libvirt, and Kata (for example only certain instance families on AWS; others need a bare-metal
instance). Otherwise only gVisor or the rootless Docker per user work.

**Costs and open points:** memory and disk per VM on the machine; starting VMs on demand and stopping idle ones;
updates of the VM images; how the machine's owner limits accounts (quotas); and how ports reach the computer through
SSH. Until one of these ways is built, the remote machine keeps one shared Docker, and repositories must be trusted.
