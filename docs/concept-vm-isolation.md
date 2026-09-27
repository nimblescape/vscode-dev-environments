# Concept: a Docker in a VM per account, locally and on a remote machine (not planned yet)

Status: idea, kept for later, for local and remote Docker hosts. Nothing here is implemented. The facts about the VM tools below come from general
knowledge and were not checked when this was written; check them before any work starts.

## Why

All environments share one Docker. A repository can therefore reach what that Docker holds for other environments:
their local images (including private images pulled with another account's credentials), their build cache, and,
through tricks in the build, more of the same. The host access checks cannot close this reliably: they would have to
predict how the Dev Container CLI, Compose, and BuildKit read and rewrite a configuration, and these change with
every version (see the trust model in the README and docs/container-restrictions.md).

A boundary does not need that prediction. If each GitHub account has its own Docker, inside its own virtual
machine, the images, containers, volumes, and build cache of other accounts are not reachable, whatever the
configuration says. GitHub Codespaces works this way: each codespace runs in its own virtual machine with its own
network, and the configuration is not judged.

## Idea

- Dev Environments talks to Docker only through an endpoint (`DOCKER_HOST` or a Docker context). Each GitHub account
  gets its own endpoint: the shared local Docker (today), a local VM, or a remote host.
- For a local VM, Dev Environments creates the VM at first use, starts it when needed, stops it after some idle time,
  and limits its CPU, memory, and disk.
- Every Docker call for that account goes to its endpoint: the workspace helper, the build, the volumes, the Session
  Monitor. The repositories already live in volumes, so nothing of the computer needs to be shared into the VM.
- VS Code attaches to the container through that endpoint (the Dev Containers extension supports remote Docker
  endpoints).

## Possible VM providers (to be checked)

| Computer | Provider | Notes |
|---|---|---|
| macOS | Lima or Colima (Apple Virtualization framework) | One instance or profile per VM, each with its own Docker behind a forwarded socket. |
| Linux | Lima with QEMU/KVM | The same tool as on macOS. Lighter alternatives: rootless Docker in a separate user account, or Kata Containers (a small VM per container, needs KVM). |
| Windows | A separate WSL 2 distribution with its own Docker | Simple, but all WSL 2 distributions share one VM and kernel: files and Docker are separate, the kernel is not. A real VM needs Hyper-V; Lima on Windows may still be experimental. |

## What it protects, and what not

- Protected: the files and the Docker of the computer, and the images, containers, volumes, and build cache of other
  accounts. The image and Dockerfile checks become a second line; the host access checks stay as a guard rail.
- Not protected: the channels that VS Code opens from the container to the computer (SSH and GPG agents, the
  credential socket, opening URLs, clipboard, X11). The window runs on the computer, so these stay. Only a separate
  user account on the computer, or a browser-based editor, closes them.

## Costs

- Memory: about 1 to 2 GB for each running VM; disk: every VM stores its own images.
- A slower first start, a VM image to keep up to date, and port forwarding through the VM.

## The remote case: VMs on the remote machine

With a remote Docker host (unit 7) there is one machine, and today one shared Docker on it. The same boundary can be
built on that machine: instead of one Docker, the machine runs one VM (or one separated Docker) per GitHub account,
and Dev Environments reaches each through SSH.

**How Dev Environments would use it.** Dev Environments already talks to Docker only through an endpoint. For a
remote machine, the endpoint of an account becomes `ssh://<user>@<machine>` plus the Docker socket of that account's
VM. Dev Environments asks the machine over SSH to create or start that VM, then points `DOCKER_HOST` (or a Docker
context) at it; the VS Code window attaches through the same endpoint.

**Ways to run a VM per account on the remote machine (to be checked):**

| Way | What the machine needs | Isolation |
|---|---|---|
| Lima on Linux (`limactl create/start/stop`), each instance with its own Docker | KVM: a physical machine, or a cloud VM with nested virtualization | A VM per account, as locally. The same tool as on macOS and Linux computers. |
| libvirt/QEMU (`virsh`) with a small VM image that runs Docker | KVM | The same, with more setup; fits machines that already use libvirt or Proxmox. |
| Kata Containers or gVisor as the runtime of the one Docker | KVM (Kata) or nothing extra (gVisor) | Each container gets its own small VM or user-space kernel. It isolates containers from the machine, but images and build cache stay shared between accounts. |
| One Linux user per account, each with its own rootless Docker (`ssh://devenv-<account>@<machine>`) | Nothing extra | No VM: the kernel is shared. The images, containers, volumes, and build cache of the accounts are separate, and none of them runs as root. The lightest and most portable way. |

**A small agent on the machine.** Creating users or VMs needs rights on the machine. Dev Environments should not get
a root shell for this. A small, audited helper on the machine (for example a command allowed in `authorized_keys` or
`sudoers`) can offer exactly "create, start, stop, remove the VM or Docker of account X" and nothing else.

**If the remote machine is itself a cloud VM**, nested virtualization must be switched on for Lima, libvirt, and
Kata; otherwise only gVisor or the rootless Docker per user work.

**Costs and open points:** memory and disk per VM on the machine; starting VMs on demand and stopping idle ones;
updates of the VM images; how the machine's owner limits accounts (quotas); and how ports reach the computer through
SSH. Until one of these ways is built, the remote machine keeps one shared Docker and the trust model applies.
