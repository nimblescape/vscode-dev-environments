// GitHub GraphQL API over an HttpTransport (concept 7.4). The token is used only for the Authorization header:
// it never appears in a log line or in an error message (concept section 9).
import type { HttpResponse, HttpTransport } from '../http';
import { abortError, isAbortError, silentLogger, type Logger } from '../ports';

export const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
export const GITHUB_USER_AGENT = 'vscode-dev-environments';
/** Time limit of one request. The HttpTransport has no time limit of its own. */
export const DEFAULT_GITHUB_TIMEOUT_MS = 30_000;

/** One entry of the `errors` array of a GraphQL response. */
export interface GraphQLError {
  message: string;
  /** GitHub sets it for some errors, for example `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMITED`. */
  type?: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

/** The API answered with an HTTP status other than 200. A 401 means that the session is not valid anymore. */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

/** GitHub did not answer within the time limit of the request. */
export class GitHubTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`GitHub did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = 'GitHubTimeoutError';
  }
}

export interface GitHubApiOptions {
  /** Time limit of one request. Default: 30 seconds. */
  timeoutMs?: number;
}

export class GitHubApi {
  private readonly timeoutMs: number;

  constructor(
    private readonly transport: HttpTransport,
    private readonly logger: Logger = silentLogger,
    options: GitHubApiOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS;
  }

  /**
   * Runs a GraphQL query. Resolves with `data` and `errors` of the response: GitHub can return partial data together
   * with errors, for example for organizations with SAML single sign-on.
   * Throws `GitHubApiError` for an HTTP status other than 200 or a response that is not GraphQL,
   * `GitHubTimeoutError` after the time limit, an `AbortError` when the signal aborts,
   * and the error of the transport when the connection fails.
   */
  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ data?: T; errors?: GraphQLError[] }> {
    const response = await this.post(JSON.stringify({ query, variables }), token, signal);
    if (response.status !== 200) {
      throw new GitHubApiError(
        `GitHub API request failed with HTTP status ${response.status}${describeBody(response.body)}.`,
        response.status,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      this.logger.warn(`GitHub API: the response is not valid JSON (${response.body.length} characters).`);
      throw new GitHubApiError('GitHub API returned a response that is not valid JSON.', response.status);
    }
    if (!isRecord(body)) {
      throw new GitHubApiError('GitHub API returned an unexpected response.', response.status);
    }
    const result: { data?: T; errors?: GraphQLError[] } = {};
    if (isRecord(body.data)) result.data = body.data as T;
    const errors = normalizeErrors(body.errors);
    if (errors.length > 0) result.errors = errors;
    if (result.data === undefined && result.errors === undefined) {
      throw new GitHubApiError('GitHub API returned a response without data and without errors.', response.status);
    }
    return result;
  }

  private async post(body: string, token: string, signal?: AbortSignal): Promise<HttpResponse> {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.transport.request(
        {
          method: 'POST',
          url: GITHUB_GRAPHQL_URL,
          headers: {
            Authorization: `bearer ${token}`,
            'User-Agent': GITHUB_USER_AGENT,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Content-Length': String(Buffer.byteLength(body, 'utf8')),
          },
          body,
        },
        controller.signal,
      );
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (timedOut) throw new GitHubTimeoutError(this.timeoutMs);
      // The transport error of a failed connection does not contain the headers, so it cannot contain the token.
      if (isAbortError(error)) throw abortError();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keeps only well-formed error entries. An entry without a message gets a generic one. */
function normalizeErrors(value: unknown): GraphQLError[] {
  if (!Array.isArray(value)) return [];
  const errors: GraphQLError[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const error: GraphQLError = {
      message: typeof entry.message === 'string' ? entry.message : 'Unknown GraphQL error.',
    };
    if (typeof entry.type === 'string') error.type = entry.type;
    if (Array.isArray(entry.path)) {
      error.path = entry.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number');
    }
    if (isRecord(entry.extensions)) error.extensions = entry.extensions;
    errors.push(error);
  }
  return errors;
}

/** `: <message>` from a JSON error body of GitHub, for example `{"message":"Bad credentials"}`. */
function describeBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.message === 'string' && parsed.message.trim() !== '') {
      return `: ${parsed.message.trim().slice(0, 500)}`;
    }
  } catch {
    // Not JSON, for example an HTML page of a proxy.
  }
  return '';
}

/** Short text of GraphQL errors for a log line or an error message. Identical messages are listed once. */
export function describeGraphQLErrors(errors: readonly GraphQLError[] | undefined): string {
  if (!errors || errors.length === 0) return 'no details';
  const messages = [...new Set(errors.map((error) => (error.type ? `${error.type}: ${error.message}` : error.message)))];
  const shown = messages.slice(0, 5).join(' | ');
  return messages.length > 5 ? `${shown} | … (${messages.length - 5} more)` : shown;
}
