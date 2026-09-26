# Start Docker Engine

**Start Docker** checks whether Docker Engine runs.

If it does not run, it shows you this command. When you confirm it, the command runs in a terminal of VS Code, where you enter your password:

```
sudo systemctl enable --now docker
```

It starts the Docker service now and whenever the computer starts. Then select **Start Docker** again to check.

If Docker runs but refuses access, your user is not yet in the group `docker`: sign out and sign in again (or run `newgrp docker` in a terminal).

This step checks itself off when Docker answers.
