// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Plan step 11E3a (decision C1 of 2026-10-05): the outbound HTTPS requests of the worker go through the proxy of the Docker
// daemon of its engine (`docker info`: HttpsProxy and NoProxy), as Go's net/http reads HTTPS_PROXY and NO_PROXY: a
// tunnel (`CONNECT host:port`) through an `http://` or `https://` proxy, then TLS to the host with its certificate checked
// as without a proxy. A host of NoProxy is reached directly. Docker shows a proxy password as `xxxxx`, so the worker
// never sends a proxy sign-in (a proxy that asks for one refuses with 407, which the error says). No `vscode`.
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import type { Duplex } from 'stream';
import * as tls from 'tls';
import { httpsRequest, type HttpTransport } from './http';

/** The proxy settings that the transport follows (the daemon's, EngineProxy). */
export interface ProxySettings {
  httpsProxy?: string;
  noProxy?: string;
}

/** The time limit of the tunnel through the proxy (the request has its own signal as well). */
export const PROXY_CONNECT_TIMEOUT_MS = 30_000;

/**
 * True when `host` (a name or an IP address, without brackets) on `port` is reached without the proxy, as Go's httpproxy
 * decides (review round 1 of PR #109, A-L1, A-L2): `localhost` and a loopback address always; else an entry of `noProxy`
 * (comma or space separated, case does not matter) that is `*`, an IP address, a CIDR block, `example.com` (the domain
 * and its subdomains) or `.example.com` / `*.example.com` (its subdomains only), a name or an address optionally with
 * `:port` (an IPv6 address with a port in brackets, `[::1]:443`).
 */
export function bypassesProxy(host: string, port: number, noProxy: string | undefined): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost') || isLoopback(name)) return true;
  if (noProxy === undefined) return false;
  for (const raw of noProxy.split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (entry === '') continue;
    if (entry === '*') return true;
    if (entry.includes('/')) {
      if (net.isIP(name) !== 0 && inCidr(name, entry)) return true;
      continue;
    }
    let entryPort: number | undefined;
    const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(entry);
    if (bracketed) {
      entry = bracketed[1];
      if (bracketed[2] !== undefined) entryPort = Number(bracketed[2]);
    } else if (net.isIP(entry) === 0) {
      const withPort = /^(.*):(\d{1,5})$/.exec(entry);
      if (withPort) {
        entry = withPort[1];
        entryPort = Number(withPort[2]);
      }
    }
    if (entryPort !== undefined && entryPort !== port) continue;
    if (net.isIP(entry) !== 0) {
      if (entry === name) return true;
      continue;
    }
    if (entry.startsWith('*.') || entry.startsWith('.')) {
      // Subdomains only.
      const domain = entry.replace(/^\*?\./, '');
      if (domain !== '' && name.endsWith(`.${domain}`)) return true;
      continue;
    }
    if (name === entry || name.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** True for an address of the loopback (127.0.0.0/8, ::1). */
function isLoopback(address: string): boolean {
  if (net.isIPv4(address)) return address.startsWith('127.');
  return net.isIPv6(address) && inCidr(address, '::1/128');
}

function inCidr(address: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const family = net.isIP(base);
  if (family === 0 || family !== net.isIP(address) || !Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) return false;
  const list = new net.BlockList();
  list.addSubnet(base, bits, family === 4 ? 'ipv4' : 'ipv6');
  return list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** The proxy URL of the settings for an `https:` request, or `undefined` for a direct one. Throws for an unusable proxy. */
export function proxyFor(url: URL, settings: ProxySettings): URL | undefined {
  if (settings.httpsProxy === undefined) return undefined;
  const port = url.port === '' ? 443 : Number(url.port);
  if (bypassesProxy(url.hostname.replace(/^\[|\]$/g, ''), port, settings.noProxy)) return undefined;
  let proxy: URL;
  try {
    // Docker accepts a proxy without a scheme as `http://`.
    proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(settings.httpsProxy) ? settings.httpsProxy : `http://${settings.httpsProxy}`);
  } catch {
    throw new Error('The proxy of the Docker engine is no valid URL.');
  }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') throw new Error(`The proxy of the Docker engine uses ${proxy.protocol}, which the worker does not support.`);
  return proxy;
}

/**
 * Review round 1 of PR #109 (A-M1, A-M2): the TLS options that check a certificate for `host`: its name as SNI (none for
 * an IP address, which SNI does not carry) and the check of the name or the address against the certificate.
 */
export function tlsNameOf(host: string): Pick<tls.ConnectionOptions, 'servername' | 'checkServerIdentity'> {
  return {
    ...(net.isIP(host) === 0 ? { servername: host } : {}),
    checkServerIdentity: (_name, certificate) => tls.checkServerIdentity(host, certificate),
  };
}

/** A tunnel to `host:port` through `proxy` (CONNECT); rejects when the proxy refuses or does not answer in time. */
function tunnel(proxy: URL, host: string, port: number, signal: AbortSignal | undefined): Promise<Duplex> {
  const limit = AbortSignal.timeout(PROXY_CONNECT_TIMEOUT_MS);
  const both = signal ? AbortSignal.any([signal, limit]) : limit;
  const target = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  return new Promise((resolve, reject) => {
    const proxyHost = proxy.hostname.replace(/^\[|\]$/g, '');
    const options: https.RequestOptions = {
      host: proxyHost,
      port: proxy.port === '' ? (proxy.protocol === 'https:' ? 443 : 80) : Number(proxy.port),
      method: 'CONNECT',
      path: target,
      headers: { host: target },
      signal: both,
      agent: false,
      // Review round 1 of PR #109 (A-M2): the TLS of an `https://` proxy is checked for the name of the proxy (Node would
      // take the name of the target from the Host header).
      ...(proxy.protocol === 'https:' ? tlsNameOf(proxyHost) : {}),
    };
    const req = proxy.protocol === 'https:' ? https.request(options) : http.request(options);
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) {
        resolve(socket);
        return;
      }
      socket.destroy();
      const why = res.statusCode === 407 ? 'it asks for a sign-in, which docker info does not show' : `HTTP ${res.statusCode ?? 0}`;
      reject(new Error(`The proxy ${proxy.host} of the Docker engine refused the connection to ${target}: ${why}.`));
    });
    req.on('error', (error) => reject(both.aborted && !signal?.aborted ? new Error(`The proxy ${proxy.host} of the Docker engine did not answer within ${PROXY_CONNECT_TIMEOUT_MS / 1000} seconds.`) : error));
    req.end();
  });
}

/**
 * The worker's HTTPS transport: through the proxy of `settings()` (read once, when the first request needs it), else
 * directly. Only `https:` URLs (a registry never gets credentials without TLS); the TLS of the host is checked as without a
 * proxy (its name, SNI).
 */
export function proxiedHttpsTransport(settings: () => Promise<ProxySettings>): HttpTransport {
  let read: Promise<ProxySettings> | undefined;
  return {
    async request(request, signal) {
      const url = new URL(request.url);
      if (url.protocol !== 'https:') throw new Error(`The worker sends no request without TLS (${url.protocol}//${url.host}).`);
      read ??= settings();
      const proxy = proxyFor(url, await read);
      if (proxy === undefined) return httpsRequest(request, signal);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const socket = await tunnel(proxy, host, url.port === '' ? 443 : Number(url.port), signal);
      // No agent: Node then uses createConnection (with `agent: false` it would make an agent of its own, which connects
      // directly).
      return httpsRequest(request, signal, {
        // Review round 1 of PR #109 (A-M1): checked for the host of the URL, also an IP address (Node would take the name
        // of the proxy from the socket).
        createConnection: () => tls.connect({ socket, ...tlsNameOf(host) }),
      });
    },
  };
}
