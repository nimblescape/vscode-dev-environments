# Install Docker Desktop on macOS

Dev Environments runs your environments in Docker Desktop.

**Install Docker** first shows you what runs, and runs nothing without your confirmation:

- **With Homebrew:** this command runs in a terminal of VS Code, where you can follow it:

  ```
  brew install --cask docker-desktop
  ```

  Homebrew installs Docker Desktop from its official cask `docker-desktop`. It may ask for your password in the terminal.

  If Homebrew still lists Docker Desktop but the app is missing from the Applications folder, Homebrew first removes its old entry with `brew uninstall --cask --force docker-desktop` (your Docker data stays), then installs Docker Desktop.

- **Without Homebrew:** the installer `Docker.dmg` is downloaded over HTTPS from Docker (desktop.docker.com) into your Downloads folder, for Apple silicon or for an Intel processor. Then it opens: drag **Docker** to the **Applications** folder. The installer is signed and notarized by Docker.

This step checks itself off when the Docker command line tool is found.

## License of Docker Desktop

Docker Desktop is subject to the [Docker Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement/). It is free for personal use, education, non-commercial open source projects, and small businesses (fewer than 250 employees and less than 10 million US dollars in annual revenue). Larger companies need a paid subscription.
