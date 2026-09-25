import * as https from 'https';

export interface HttpRequest {
  method: 'GET' | 'HEAD' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  /** Body as text. Empty for HEAD. */
  body: string;
}

/**
 * HTTP client interface, so that tests can replace the network.
 * `request` rejects when the connection fails (for example a failed name resolution),
 * and with an `AbortError` when the signal aborts.
 */
export interface HttpTransport {
  request(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Transport with the Node.js `https` module. In the extension host, VS Code applies its proxy settings to this module
 * (implementation notes 9).
 */
export const nodeHttpsTransport: HttpTransport = {
  request(request, signal) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        request.url,
        { method: request.method, headers: request.headers, signal },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              req.destroy(new Error(`Response of ${request.url} is too large.`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
            }
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (request.body !== undefined) req.end(request.body);
      else req.end();
    });
  },
};
