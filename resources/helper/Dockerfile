# SPDX-License-Identifier: MIT
# © 2026 Hannes Stauss (scalarion@nimblescape.com)
# Licensed under the MIT License. See LICENSE in the repository root for details.

# Workspace helper of the Dev Environments extension (implementation notes 7).
# The extension builds this image locally and tags it devenv-helper:<hash of this file and the CLI version>.
# It must build with BuildKit and with the classic builder: no syntax directive, no heredocs, no RUN --mount.
ARG BASE_IMAGE=node:24-trixie-slim
FROM ${BASE_IMAGE}

# Passed by the extension (DEVCONTAINER_CLI_VERSION in src/core/helper/helperImage.ts).
ARG DEVCONTAINER_CLI_VERSION

# Git, the Docker CLI with the buildx and the Compose plugins (from download.docker.com), and tini as init process,
# so that a stop signal reaches the Dev Container CLI and Git. The Compose plugin runs Docker Compose configurations
# (implementation notes, section "Docker Compose"). `flock` (util-linux) and `timeout` (coreutils) guard the heartbeats
# of the remote Session Monitor (heartbeatCommand; `flock` since review round 2 of PR #58, `timeout` since round 3).
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates coreutils curl git openssh-client tini util-linux; \
    flock --version; timeout --version; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    . /etc/os-release; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin; \
    docker compose version; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# The Dev Container CLI in a pinned version. The helper runs as root on files of another user, so Git must
# accept every repository folder.
RUN set -eux; \
    test -n "${DEVCONTAINER_CLI_VERSION}"; \
    npm install -g "@devcontainers/cli@${DEVCONTAINER_CLI_VERSION}"; \
    npm cache clean --force; \
    devcontainer --version; \
    git config --system --add safe.directory '*'

# Plan step 6, PR B (decision Q2 of 2026-10-01): the batch helper runs Git as this unprivileged user (BATCH_GIT_UID in
# src/core/helperChannel/batch.ts; no home, no login), and mounts the Docker socket in a folder that only root can
# enter (BATCH_SOCKET_FOLDER), so that Git and the programs that a repository names never reach it.
RUN set -eux; \
    groupadd --system --gid 52741 devenv-git; \
    useradd --system --uid 52741 --gid 52741 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin devenv-git; \
    install -d -m 0700 -o root -g root /run/devenv-docker; \
    setpriv --version

LABEL nimblescape.devenv.helper=true
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["sh"]
