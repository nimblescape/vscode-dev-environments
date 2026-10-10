#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# © 2026 Hannes Stauss (scalarion@nimblescape.com)
# Licensed under the MIT License. See LICENSE in the repository root for details.

# Purges the Docker engine of the current Docker context: removes ALL its containers (running ones too), volumes,
# images, unused networks and build cache, so that the next open of a dev environment starts from a clean engine (a
# fresh install: helper image, Session Monitor, shared VS Code server store, extension cache, environments).
#
# It deletes everything on that engine, not only what Dev Environments created. The volumes `devenv-*` hold the
# repositories of the dev environments: changes that are not pushed are lost. Close the VS Code windows that use the
# engine first (their worker and their containers go too).
#
#   bash scripts/purge-docker-context.sh                 # shows what it removes, then asks for the context name
#   bash scripts/purge-docker-context.sh --dry-run       # only shows what it would remove
#   bash scripts/purge-docker-context.sh --yes devenv    # no question; runs only when the current context is devenv
#
# The context is read once (`docker context show`, which follows DOCKER_CONTEXT) and every command runs with
# `--context <name>`, so a change of the context while it runs never redirects it. With DOCKER_HOST set it refuses (the
# engine would not be the one of the context). Works with the bash of macOS (3.2).
set -u

dry_run=0
confirmed=''
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --yes)
      shift
      if [ $# -eq 0 ]; then echo 'error: --yes needs the name of the context' >&2; exit 2; fi
      confirmed="$1"
      ;;
    -h|--help) awk 'NR >= 6 && !/^#/ { exit } NR >= 6 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "error: unknown argument $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

if ! command -v docker >/dev/null 2>&1; then echo 'error: the docker CLI is not on the PATH' >&2; exit 1; fi
if [ -n "${DOCKER_HOST:-}" ]; then
  echo "error: DOCKER_HOST is set ($DOCKER_HOST); unset it and choose the engine with a Docker context" >&2
  exit 1
fi
ctx=$(docker context show 2>/dev/null)
if [ -z "$ctx" ]; then echo 'error: the current Docker context could not be read' >&2; exit 1; fi

d() { docker --context "$ctx" "$@"; }

endpoint=$(docker context inspect "$ctx" --format '{{.Endpoints.docker.Host}}' 2>/dev/null)
engine=$(d info --format '{{.Name}}, Docker {{.ServerVersion}}, {{.OperatingSystem}}' 2>/dev/null)
if [ -z "$engine" ]; then echo "error: the engine of the context $ctx ($endpoint) does not answer" >&2; exit 1; fi

containers=$(d ps -aq)
running=$(d ps -q)
volumes=$(d volume ls -q)
images=$(d image ls -aq | sort -u)
count() { if [ -z "$1" ]; then echo 0; else printf '%s\n' "$1" | wc -l | tr -d ' '; fi; }

echo "Docker context: $ctx"
echo "Endpoint:       ${endpoint:-unknown}"
echo "Engine:         $engine"
echo
echo "It removes: $(count "$containers") container(s) ($(count "$running") running), $(count "$volumes") volume(s), $(count "$images") image(s), the unused networks and the build cache."
envs=$(printf '%s\n' "$volumes" | grep '^devenv-' | grep -v '^devenv-vscode$' || true)
if [ -n "$envs" ]; then
  echo
  echo 'Volumes of Dev Environments (repositories; changes that are not pushed are lost):'
  printf '  %s\n' $envs
fi
if [ -n "$running" ]; then
  echo
  echo 'Running containers:'
  d ps --format '  {{.Names}} ({{.Image}}, {{.Status}})'
fi
echo

if [ "$dry_run" -eq 1 ]; then
  echo 'Dry run: nothing removed.'
  exit 0
fi

if [ -n "$confirmed" ]; then
  if [ "$confirmed" != "$ctx" ]; then
    echo "error: --yes $confirmed does not name the current context $ctx; nothing removed" >&2
    exit 1
  fi
else
  if [ ! -r /dev/tty ]; then echo 'error: no terminal to ask; use --yes <context>' >&2; exit 1; fi
  printf 'Type the context name (%s) to delete ALL of the above: ' "$ctx"
  read -r answer </dev/tty
  if [ "$answer" != "$ctx" ]; then
    echo 'Nothing removed.'
    exit 1
  fi
fi

failed=0
step() {
  echo "== $1"
  shift
  "$@" || failed=1
}

# Containers first (also the Session Monitor with its restart policy), so that no volume or image is still in use.
if [ -n "$containers" ]; then step 'Removing the containers' d rm -f $containers; fi
remaining=$(d volume ls -q)
if [ -n "$remaining" ]; then step 'Removing the volumes' d volume rm -f $remaining; fi
remaining=$(d image ls -aq | sort -u)
if [ -n "$remaining" ]; then step 'Removing the images' d image rm -f $remaining; fi
step 'Removing the unused networks' d network prune -f
step 'Removing the build cache' d builder prune -af
# A last sweep for what the steps above left (an image that was in use while its container went, for example).
step 'Pruning the rest' d system prune -af --volumes

echo
echo "== What is left on $ctx"
d system df
left=$(( $(count "$(d ps -aq)") + $(count "$(d volume ls -q)") + $(count "$(d image ls -aq)") ))
if [ "$failed" -ne 0 ] || [ "$left" -ne 0 ]; then
  echo
  echo "Not everything was removed ($left container(s), volume(s) and image(s) left); run it again or look at the errors above." >&2
  exit 1
fi
echo
echo "The engine of $ctx is clean."
