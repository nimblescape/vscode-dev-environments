# Install Docker Desktop on Windows

Dev Environments runs your environments in Docker Desktop.

**Install Docker** first shows you what runs, and runs nothing without your confirmation:

- **With winget:** this command runs in a terminal of VS Code, where you can follow it:

  ```
  winget install --exact --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
  ```

  winget installs Docker Desktop from its official package `Docker.DockerDesktop`. Windows may ask for administrator permission.

- **Without winget:** the installer `Docker Desktop Installer.exe` is downloaded over HTTPS from Docker (desktop.docker.com) into your Downloads folder, for x64 or Arm processors. Then it starts. The installer is signed by Docker. Windows may ask for administrator permission.

This step checks itself off when the Docker command line tool is found. If it is not found after the installation, restart VS Code.

## License of Docker Desktop

Docker Desktop is subject to the [Docker Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement/). It is free for personal use, education, non-commercial open source projects, and small businesses (fewer than 250 employees and less than 10 million US dollars in annual revenue). Larger companies need a paid subscription.
