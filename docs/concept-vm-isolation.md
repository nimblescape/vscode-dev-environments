# Concept: a Docker in a VM per account (not planned yet)

Status: idea, kept for later. Nothing here is implemented. The facts about the VM tools below come from general
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

## Limit: the remote case

This does not help when the Docker runs on one remote machine that all accounts share (unit 7, a remote Docker
host). There is only one Docker there. Separating accounts on that machine would need something on the machine
itself, for example one rootless Docker per user account there, a container runtime that runs each container in its
own small VM (Kata Containers, gVisor), or VMs on that machine; each of these needs control over the remote machine.
Until then, the remote case keeps the shared Docker and the trust model applies.
