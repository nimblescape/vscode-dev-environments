# Install Docker Engine on Linux

Dev Environments runs your environments in Docker Engine.

**Install Docker** installs Docker Engine from the official package repository of Docker (download.docker.com), with the commands of the [Docker documentation](https://docs.docker.com/engine/install/) for Ubuntu, Debian, Fedora, RHEL, and CentOS. First it shows you the exact commands. When you confirm them, they run in a terminal of VS Code, where you can follow them and enter your password for `sudo`.

At the end, your user is added to the group `docker`, so that you can use Docker without `sudo`:

```
sudo usermod -aG docker $USER
```

Sign out and sign in again afterwards (or run `newgrp docker` in a terminal), so that the new group applies.

For other distributions, the installation guide of Docker opens instead.

Docker Engine is open source software and free to use.

**Docker Desktop for Linux** is not installed by Dev Environments. To use it instead, follow the [installation guide of Docker Desktop for Linux](https://docs.docker.com/desktop/setup/install/linux/). Docker Desktop is subject to the [Docker Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement/): free for personal use, education, non-commercial open source projects, and small businesses; larger companies need a paid subscription.

This step checks itself off when the Docker command line tool is found.
