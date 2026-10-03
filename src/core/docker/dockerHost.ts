// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Docker on another computer (unit 7, user decisions 2026-09-27): the remote Docker host is the current Docker context.
// Docker, Docker Compose, the Dev Container CLI, the Dev Containers extension, and this extension all follow it by
// themselves. This module holds the pure rules: which endpoint counts as local, remote (ssh://), or not supported; the
// Docker host of an environment; the check of an SSH address; the plain reasons of a failed connection. No `vscode`.
import { namePair } from '../namePairs';
import type { Environment } from '../types';

/**
 * The description of the Docker contexts that "Use a Remote Docker Host…" creates (`docker context create --description`):
 * it marks a context as one of Dev Environments (isOwnContextDescription), whatever its name.
 */
export const OWN_CONTEXT_DESCRIPTION_PREFIX = 'Dev Environments: remote Docker host ';

/** The description of the context of `host` (OWN_CONTEXT_DESCRIPTION_PREFIX). */
export function ownContextDescription(host: string): string {
  return `${OWN_CONTEXT_DESCRIPTION_PREFIX}${host}`;
}

/** True for the description of a context that Dev Environments created (ownContextDescription). */
export function isOwnContextDescription(description: string | undefined): boolean {
  return description !== undefined && description.startsWith(OWN_CONTEXT_DESCRIPTION_PREFIX);
}

/**
 * The names that the Docker context of the remote host `host` (an alias or an address, as recorded) may get, in this
 * order (user decisions 2026-10-03): the alias of the SSH config, or the host name of an address (without the user and
 * the port), for example `htldvm`; on a clash with a context of that name that points elsewhere, the name with the pair
 * of the host (namePair), for example `htldvm-brave-noether`. Docker allows only `[a-zA-Z0-9_.+-]`, starting with a
 * letter or digit, and at least 2 characters, in the name of a context: every run of other characters becomes `-`, and a
 * name of one character gets the prefix `remote-`.
 */
export function remoteContextNames(host: string): [string, string] {
  const target = sshTargetOf(host)?.host ?? host;
  const base = target.replace(/[^a-zA-Z0-9_.+-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '').replace(/-+$/, '');
  // Review round 3 of PR #88 (A-R3-2): Docker needs at least 2 characters (`^[a-zA-Z0-9][a-zA-Z0-9_.+-]+$`).
  const name = base === '' || base === DEFAULT_CONTEXT_NAME ? 'remote' : base.length < 2 ? `remote-${base}` : base;
  return [name, `${name}-${namePair(host)}`];
}
/** The context of the Docker CLI that stands for DOCKER_HOST or the default endpoint. */
export const DEFAULT_CONTEXT_NAME = 'default';

/**
 * Where Docker runs, as the current Docker context (or DOCKER_HOST) says:
 * - `local`: the Docker of this computer (Docker Desktop, the default Unix socket, a named pipe, a rootless socket of
 *   this user, or TCP to this computer's loopback).
 * - `remote`: `ssh://…`, the Docker of another computer, reached through SSH.
 * - `unsupported`: any other endpoint (TCP to another computer, an unknown scheme): refused with a message.
 */
export type DockerTargetKind = 'local' | 'remote' | 'unsupported';

export interface DockerTarget {
  kind: DockerTargetKind;
  /**
   * The Docker host that environments record (`Environment.dockerHost`): empty for `local`; for `remote` the part after
   * `ssh://` (an alias of the SSH config or `user@host[:port]`); for `unsupported` the endpoint.
   */
  host: string;
  /** The endpoint of the context, for example `unix:///var/run/docker.sock` or `ssh://build-box`. Empty when unknown. */
  endpoint: string;
  /**
   * The name of the current Docker context, when a context decides the endpoint. Undefined when DOCKER_HOST decides it,
   * or when it could not be read.
   */
  context?: string;
}

/** The Docker of this computer, when nothing else is known (for example without a Docker CLI). */
export const LOCAL_DOCKER_TARGET: DockerTarget = { kind: 'local', host: '', endpoint: '' };

/** Host names of this computer's loopback: a TCP endpoint there is the Docker of this computer. */
const LOOPBACK_HOSTS = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

/** Classifies a Docker endpoint (see DockerTargetKind). */
export function classifyDockerEndpoint(endpoint: string): { kind: DockerTargetKind; host: string } {
  const value = endpoint.trim();
  if (value === '') return { kind: 'local', host: '' };
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value);
  if (!match) return { kind: 'unsupported', host: value };
  const scheme = match[1].toLowerCase();
  const rest = match[2];
  if (scheme === 'unix' || scheme === 'npipe') return { kind: 'local', host: '' };
  if (scheme === 'ssh') {
    const host = rest.replace(/\/+$/, '');
    return host === '' ? { kind: 'unsupported', host: value } : { kind: 'remote', host };
  }
  if (scheme === 'tcp' || scheme === 'http' || scheme === 'https') {
    const authority = rest.split('/')[0];
    const hostPart = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0];
    if (LOOPBACK_HOSTS.test(hostPart)) return { kind: 'local', host: '' };
  }
  return { kind: 'unsupported', host: value };
}

/**
 * The output of `docker context inspect --format '{{json .}}'` for the current context: its name and its Docker
 * endpoint. `undefined` when the output is not such an object.
 */
export function parseContextInspect(stdout: string): { name: string; endpoint: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  // `docker context inspect` without --format prints a list; with `{{json .}}` one object.
  if (Array.isArray(value)) value = value[0];
  if (!isRecord(value) || typeof value.Name !== 'string') return undefined;
  const endpoints = isRecord(value.Endpoints) ? value.Endpoints : undefined;
  const docker = endpoints && isRecord(endpoints.docker) ? endpoints.docker : undefined;
  const endpoint = docker && typeof docker.Host === 'string' ? docker.Host : '';
  return { name: value.Name, endpoint };
}

/** The target of an endpoint read from the context `context` (undefined: DOCKER_HOST decides). */
export function dockerTargetOf(endpoint: string, context: string | undefined): DockerTarget {
  const { kind, host } = classifyDockerEndpoint(endpoint);
  return context === undefined ? { kind, host, endpoint } : { kind, host, endpoint, context };
}

// ---------------------------------------------------------------------------------------------------------------------
// The Docker host of an environment

/** The Docker host that an environment records; a missing field is the local Docker (greenfield, no migration). */
export function dockerHostOf(environment: Pick<Environment, 'dockerHost'>): string {
  return environment.dockerHost ?? '';
}

/**
 * True when two Docker hosts are the same. The comparison is exact: two SSH aliases of the same computer count as two
 * hosts (documented), because only the names are known here.
 */
export function sameDockerHost(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '') === (b ?? '');
}

/** True when `environment` is on the Docker host `host` ('' = the local Docker). */
export function isOnDockerHost(environment: Pick<Environment, 'dockerHost'>, host: string): boolean {
  return sameDockerHost(dockerHostOf(environment), host);
}

/** The environments on the Docker host `host`, in their order. Environments of other hosts are hidden and never acted on. */
export function environmentsOfHost<T extends Pick<Environment, 'dockerHost'>>(environments: readonly T[], host: string): T[] {
  return environments.filter((environment) => isOnDockerHost(environment, host));
}

/** The field `dockerHost` of a new environment on `host`: absent for the local Docker. */
export function dockerHostField(host: string): Pick<Environment, 'dockerHost'> {
  return host === '' ? {} : { dockerHost: host };
}

/** The Docker host for the user: the name of a remote host, or "the local Docker". */
export function describeDockerHost(host: string): string {
  return host === '' ? 'the local Docker' : host;
}

// ---------------------------------------------------------------------------------------------------------------------
// SSH addresses

/** A name that can be passed to `ssh` and to `docker -H ssh://…` as it is: no option, no shell or URL character. */
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$/;
const IPV6 = /^[0-9A-Fa-f:.]+$/;

/** True for an alias of the SSH config that Dev Environments offers: a plain name (no pattern, no leading `-`). */
export function isUsableSshAlias(alias: string): boolean {
  return SAFE_NAME.test(alias) && alias.length <= 255;
}

export type SshAddressProblem = 'empty' | 'spaces' | 'option' | 'path' | 'user' | 'host' | 'ipv6' | 'port';

export interface SshAddress {
  user?: string;
  /** The host name, IPv4 address, or IPv6 address (without brackets). */
  host: string;
  port?: number;
}

/**
 * Checks an SSH address `user@host[:port]` that the user typed (the user and the port are optional; an IPv6 address in
 * brackets, `[::1]:2222`). `ssh://` in front is accepted and dropped. The result `address` is the canonical text that
 * the Docker context gets after `ssh://`.
 */
export function parseSshAddress(text: string): { ok: true; address: string; parts: SshAddress } | { ok: false; problem: SshAddressProblem } {
  let value = text.trim();
  if (value === '') return { ok: false, problem: 'empty' };
  if (/\s/.test(value)) return { ok: false, problem: 'spaces' };
  if (/^ssh:\/\//i.test(value)) value = value.slice('ssh://'.length);
  if (value.startsWith('-')) return { ok: false, problem: 'option' };
  if (/[/?#\\]/.test(value)) return { ok: false, problem: 'path' };
  let user: string | undefined;
  const at = value.lastIndexOf('@');
  if (at >= 0) {
    user = value.slice(0, at);
    value = value.slice(at + 1);
    if (!USER.test(user)) return { ok: false, problem: 'user' };
  }
  let host: string;
  let portText: string | undefined;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0) return { ok: false, problem: 'ipv6' };
    host = value.slice(1, close);
    const rest = value.slice(close + 1);
    if (!IPV6.test(host) || !host.includes(':')) return { ok: false, problem: 'ipv6' };
    if (rest !== '') {
      if (!rest.startsWith(':')) return { ok: false, problem: 'port' };
      portText = rest.slice(1);
    }
  } else {
    const parts = value.split(':');
    if (parts.length > 2) return { ok: false, problem: 'ipv6' };
    host = parts[0];
    portText = parts[1];
    if (host.startsWith('-') || !HOST_NAME.test(host)) return { ok: false, problem: 'host' };
  }
  let port: number | undefined;
  if (portText !== undefined) {
    if (!/^\d{1,5}$/.test(portText)) return { ok: false, problem: 'port' };
    port = Number(portText);
    if (port < 1 || port > 65535) return { ok: false, problem: 'port' };
  }
  const hostText = host.includes(':') ? `[${host}]` : host;
  const address = `${user !== undefined ? `${user}@` : ''}${hostText}${port !== undefined ? `:${port}` : ''}`;
  const parts: SshAddress = { host };
  if (user !== undefined) parts.user = user;
  if (port !== undefined) parts.port = port;
  return { ok: true, address, parts };
}

/**
 * The parts of a remote Docker host (an alias or an address), for `ssh`; `undefined` when it is neither a usable alias
 * nor a valid address (for example a host that a context of the user names with a path).
 */
export function sshTargetOf(host: string): SshAddress | undefined {
  if (isUsableSshAlias(host)) return { host };
  const parsed = parseSshAddress(host);
  return parsed.ok && parsed.address === host ? parsed.parts : undefined;
}

/**
 * The command line that opens an SSH connection to the remote host `host` in a terminal (for the advice about an unknown
 * host key): `ssh <alias>` for an alias of the SSH config, `ssh [-p <port>] [<user>@]<host>` for an address (an IPv6
 * address without brackets, which ssh does not take there). Review, C4: `ssh me@box:2222` is no valid command line.
 */
export function sshCommandLine(host: string): string {
  const target = sshTargetOf(host);
  if (!target) return `ssh ${host}`;
  const port = target.port !== undefined ? `-p ${target.port} ` : '';
  const user = target.user !== undefined ? `${target.user}@` : '';
  return `ssh ${port}${user}${target.host}`;
}

/** The Docker endpoint of a remote host: `ssh://<alias-or-address>`. */
export function sshEndpoint(host: string): string {
  return `ssh://${host}`;
}

/**
 * The arguments of `ssh` that run `remoteCommand` (one string that the remote shell runs) on `target` without any
 * question: BatchMode (no password or passphrase prompt, no host key question: an unknown key fails), a time limit for
 * the connection, no terminal. The destination comes after `--`, so it can never be an option.
 */
export function sshCommandArgs(target: SshAddress, remoteCommand: string, connectTimeoutSeconds = 15): string[] {
  const args = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeoutSeconds}`, '-T'];
  if (target.port !== undefined) args.push('-p', String(target.port));
  if (target.user !== undefined) args.push('-l', target.user);
  args.push('--', target.host, remoteCommand);
  return args;
}

/** The remote command that prints the folder of the user's runtime files (XDG_RUNTIME_DIR), for a rootless engine. */
export const RUNTIME_DIR_COMMAND = 'printf %s "$XDG_RUNTIME_DIR"';

/**
 * The socket of a rootless Docker engine in the runtime folder `runtimeDir` of the remote user, as the rootless setup of
 * Docker places it (`$XDG_RUNTIME_DIR/docker.sock`). `undefined` for a value that is not an absolute plain path.
 */
export function rootlessSocketPath(runtimeDir: string): string | undefined {
  const dir = runtimeDir.trim().replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9._/-]*$/.test(dir) || dir.split('/').includes('..')) return undefined;
  return `${dir}/docker.sock`;
}

/** True when `docker info` names the security option `name=rootless` (a rootless engine). */
export function isRootlessEngine(securityOptions: unknown): boolean {
  if (!Array.isArray(securityOptions)) return false;
  return securityOptions.some(
    (option) => typeof option === 'string' && option.split(',').some((part) => part.trim().toLowerCase() === 'name=rootless'),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Failures of the connection

/**
 * A line of ssh's error when the SSH server closed or reset the connection before the login, without any other reason:
 * the client of OpenSSH 9.6 (Ubuntu 24.04) prints only "Connection closed by <address> port <port>"; 9.2 prints
 * "kex_exchange_identification: Connection closed by remote host" (or "…: read: Connection reset by peer") before it.
 */
const SSH_CLOSED_LINE =
  /^(?:(?:kex|ssh)_exchange_identification: .*|Connection (?:closed|reset) by \S+ port \d+|Connection (?:closed|reset) by remote host)$/;

/**
 * True when ssh's error (alone, or as `stderr=…` at the end of the Docker CLI's error) says only that the SSH server
 * closed the connection before the login: no banner, no key exchange, so no command ran on that computer. sshd does so
 * when it limits new connections: MaxStartups (by default it drops new connections at random while more than 10 are not
 * logged in yet) and PerSourcePenalties (OpenSSH 9.8 and later: after failed or unfinished logins from an address, its
 * new connections are refused for a while).
 */
export function isSshClosedBeforeLogin(detail: string): boolean {
  const marker = detail.lastIndexOf('stderr=');
  const stderr = marker >= 0 ? detail.slice(marker + 'stderr='.length) : detail;
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length > 0 && lines.every((line) => SSH_CLOSED_LINE.test(line)) && lines.some((line) => line.startsWith('Connection '));
}

/** Why a remote Docker host could not be used, from the error of `docker info` (the Docker CLI passes on ssh's error). */
export type DockerHostProblem =
  | 'unreachable'
  | 'closedBeforeLogin'
  | 'login'
  | 'hostKey'
  | 'dockerMissing'
  | 'dockerNotRunning'
  | 'dockerPermission'
  | 'sshMissing'
  | 'unknown';

/** Maps the error text of `docker -H ssh://… info` (or of `ssh`) to a DockerHostProblem. */
export function dockerHostProblem(detail: string): DockerHostProblem {
  const text = detail;
  if (/executable file not found|ssh: (?:command )?not found|No such file or directory.*\bssh\b|\bssh\b.*ENOENT/i.test(text)) {
    return 'sshMissing';
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .*(?:not known|is unknown|mismatch)|No \S+ host key is known/i.test(text)) {
    return 'hostKey';
  }
  if (/permission denied.*docker(?:\.sock| daemon)|docker(?:\.sock| daemon).*permission denied/i.test(text)) return 'dockerPermission';
  if (/Permission denied \(|Permission denied, please try again|Too many authentication failures|Authentication failed|no supported authentication methods/i.test(text)) {
    return 'login';
  }
  if (/docker: (?:command )?not found|command not found: docker|docker: No such file or directory|exec: "?docker"?: executable/i.test(text)) {
    return 'dockerMissing';
  }
  if (/Cannot connect to the Docker daemon|Is the docker daemon running|dial unix [^\s]*docker\.sock: connect: (?:no such file|connection refused)/i.test(text)) {
    return 'dockerNotRunning';
  }
  if (isSshClosedBeforeLogin(text)) return 'closedBeforeLogin';
  if (
    /Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution|Connection refused|Connection timed out|Operation timed out|timed out|No route to host|Network is unreachable|Connection closed by|Connection reset|kex_exchange_identification|did not answer/i.test(
      text,
    )
  ) {
    return 'unreachable';
  }
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
