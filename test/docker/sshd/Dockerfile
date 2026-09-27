# SPDX-License-Identifier: MIT
# © 2026 Hannes Stauss (scalarion@nimblescape.com)
# Licensed under the MIT License. See LICENSE in the repository root for details.

# The "remote computer" of the Docker tests of unit 7 (test/docker/remoteHost.test.ts): an SSH server with the Docker CLI,
# whose Docker socket is the socket of the engine of the runner (mounted by the test). Key authentication only; the
# public key comes from the variable AUTHORIZED_KEY at the start.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apk add --no-cache openssh-server docker-cli \
 && ssh-keygen -A \
 && sed -i 's/^root:[^:]*:/root:*:/' /etc/shadow \
 && printf '%s\n' 'PermitRootLogin prohibit-password' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PubkeyAuthentication yes' 'AllowTcpForwarding no' 'X11Forwarding no' 'LogLevel VERBOSE' >> /etc/ssh/sshd_config
LABEL devenv-test.purpose=remote-docker-host
EXPOSE 22
CMD ["sh", "-c", "mkdir -p /root/.ssh && printf '%s\\n' \"$AUTHORIZED_KEY\" > /root/.ssh/authorized_keys && chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e"]
