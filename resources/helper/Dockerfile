# Workspace helper of the Dev Environments extension (implementation notes 7).
# The extension builds this image locally and tags it devenv-helper:<hash of this file and the CLI version>.
# It must build with BuildKit and with the classic builder: no syntax directive, no heredocs, no RUN --mount.
ARG BASE_IMAGE=node:24-trixie-slim
FROM ${BASE_IMAGE}

# Passed by the extension (DEVCONTAINER_CLI_VERSION in src/core/helper/helperImage.ts).
ARG DEVCONTAINER_CLI_VERSION

# Git, the Docker CLI with the buildx plugin (from download.docker.com), and tini as init process,
# so that a stop signal reaches the Dev Container CLI and Git.
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl git openssh-client tini; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    . /etc/os-release; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin; \
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

LABEL devenv.helper=true
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["sh"]
