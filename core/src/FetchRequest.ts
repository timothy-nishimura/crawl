/**
 * Immutable description of a single HTTP request.
 *
 * Use the static factories for common cases, or the builder for
 * custom headers, timeouts, or redirect behaviour.
 */
export interface FetchRequest {
  readonly uri:             string;
  readonly method:          'GET' | 'HEAD' | 'POST';
  readonly headers:         Readonly<Record<string, string>>;
  readonly timeoutMs:       number;
  readonly maxRedirects:    number;
  readonly followRedirects: boolean;
  readonly maxBodyBytes:    number;
  /** Optional request body. Only used when method is POST. */
  readonly body?:                  string;
  /** Whether to render JavaScript using a browser. */
  readonly renderJs?:              boolean;
  /** Delay after navigation to wait for async content (ms). */
  readonly postNavigationDelayMs?: number;
}

export namespace FetchRequest {
  /** Default response body limit: 5 MB. */
  export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
  /** Default maximum redirect depth. */
  export const DEFAULT_MAX_REDIRECTS  = 10;
  /** Default per-request timeout (ms). */
  export const DEFAULT_TIMEOUT_MS     = 10_000;

  /** Standard GET with defaults. */
  export function get(uri: string, timeoutMs = DEFAULT_TIMEOUT_MS): FetchRequest {
    return builder(uri).timeoutMs(timeoutMs).build();
  }

  /** HEAD request — zero-byte body, used for external link checking. */
  export function head(uri: string, timeoutMs = DEFAULT_TIMEOUT_MS): FetchRequest {
    return builder(uri).method('HEAD').timeoutMs(timeoutMs).maxBodyBytes(0).build();
  }

  export function builder(uri: string): Builder {
    return new Builder(uri);
  }

  export class Builder {
    private _method:         'GET' | 'HEAD' | 'POST' = 'GET';
    private _headers:        Record<string, string>   = {};
    private _timeoutMs       = DEFAULT_TIMEOUT_MS;
    private _maxRedirects    = DEFAULT_MAX_REDIRECTS;
    private _followRedirects = true;
    private _maxBodyBytes    = DEFAULT_MAX_BODY_BYTES;
    private _body?:          string;
    private _renderJs?:      boolean;
    private _postNavigationDelayMs?: number;

    constructor(private readonly _uri: string) {}

    method(m: 'GET' | 'HEAD' | 'POST'): this { this._method = m;          return this; }
    headers(h: Record<string, string>): this { this._headers = { ...h };  return this; }
    header(k: string, v: string):       this { this._headers[k] = v;      return this; }
    timeoutMs(ms: number):              this { this._timeoutMs = ms;      return this; }
    maxRedirects(n: number):            this { this._maxRedirects = n;    return this; }
    followRedirects(v: boolean):        this { this._followRedirects = v; return this; }
    maxBodyBytes(n: number):            this { this._maxBodyBytes = n;    return this; }
    body(b: string):                    this { this._body = b;            return this; }
    renderJs(v: boolean):               this { this._renderJs = v;        return this; }
    postNavigationDelayMs(ms: number):  this { this._postNavigationDelayMs = ms; return this; }

    build(): FetchRequest {
      return Object.freeze({
        uri:             this._uri,
        method:          this._method,
        headers:         Object.freeze({ ...this._headers }),
        timeoutMs:       this._timeoutMs,
        maxRedirects:    this._maxRedirects,
        followRedirects: this._followRedirects,
        maxBodyBytes:    this._maxBodyBytes,
        ...(this._body !== undefined && { body: this._body }),
        ...(this._renderJs !== undefined && { renderJs: this._renderJs }),
        ...(this._postNavigationDelayMs !== undefined && { postNavigationDelayMs: this._postNavigationDelayMs }),
      });
    }
  }
}
