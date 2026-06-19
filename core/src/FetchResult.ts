/**
 * The complete result of a single HTTP fetch.
 *
 * Always returned — never thrown. Network errors are represented as
 * `statusCode = 0` with `error` set.
 */
export interface FetchResult {
  readonly requestUri:     string;
  readonly finalUri:       string;
  readonly statusCode:     number;
  readonly statusMessage:  string;
  readonly responseHeaders: Readonly<Record<string, string[]>>;
  /** Raw response body bytes. Empty for HEAD or network errors. */
  readonly body:           Uint8Array;
  /** True when the body exceeded `maxBodyBytes` and was truncated. */
  readonly bodyTruncated:  boolean;
  readonly fetchDurationMs: number;
  /** Intermediate URLs followed during redirect resolution (not including finalUri). */
  readonly redirectChain:  readonly string[];
  readonly contentType:    string;
  readonly charset:        string;
  readonly error:          Error | null;
}

export namespace FetchResult {
  /** True when no network error and status is 2xx. */
  export function isSuccess(r: FetchResult): boolean {
    return r.error === null && r.statusCode >= 200 && r.statusCode < 300;
  }

  /** True when a network-level error occurred. */
  export function isFetchError(r: FetchResult): boolean {
    return r.error !== null || r.statusCode === 0;
  }

  /** True for 3xx responses. */
  export function isRedirect(r: FetchResult): boolean {
    return r.statusCode >= 300 && r.statusCode < 400;
  }

  /** True for 4xx or 5xx responses. */
  export function isHttpError(r: FetchResult): boolean {
    return r.statusCode >= 400;
  }

  /** Content-type media type without parameters, lowercased (e.g. `"text/html"`). */
  export function contentTypeBase(r: FetchResult): string {
    const semi = r.contentType.indexOf(';');
    return (semi >= 0 ? r.contentType.slice(0, semi) : r.contentType).trim().toLowerCase();
  }

  export function isHtml(r: FetchResult): boolean {
    return contentTypeBase(r) === 'text/html';
  }

  /** Returns the first value of a response header (case-insensitive). */
  export function header(r: FetchResult, name: string): string | undefined {
    const lower = name.toLowerCase();
    return r.responseHeaders[lower]?.[0];
  }

  /** Decodes the response body using the result's charset. */
  export function bodyText(r: FetchResult): string {
    return new TextDecoder(r.charset || 'utf-8').decode(r.body);
  }

  export function builder(requestUri: string): Builder {
    return new Builder(requestUri);
  }

  export class Builder {
    private _finalUri       = '';
    private _statusCode     = 0;
    private _statusMessage  = '';
    private _responseHeaders: Record<string, string[]> = {};
    private _body: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    private _bodyTruncated  = false;
    private _fetchDurationMs = 0;
    private _redirectChain: string[] = [];
    private _contentType    = '';
    private _charset        = 'utf-8';
    private _error: Error | null = null;

    constructor(private readonly _requestUri: string) {}

    finalUri(v: string):                       this { this._finalUri = v;          return this; }
    statusCode(v: number):                     this { this._statusCode = v;        return this; }
    statusMessage(v: string):                  this { this._statusMessage = v;     return this; }
    responseHeaders(v: Record<string, string[]>): this { this._responseHeaders = v; return this; }
    body(v: Uint8Array):                       this { this._body = v;              return this; }
    bodyTruncated(v: boolean):                 this { this._bodyTruncated = v;     return this; }
    fetchDurationMs(v: number):                this { this._fetchDurationMs = v;   return this; }
    redirectChain(v: string[]):                this { this._redirectChain = v;     return this; }
    contentType(v: string):                    this { this._contentType = v;       return this; }
    charset(v: string):                        this { this._charset = v;           return this; }
    error(v: Error):                           this { this._error = v;             return this; }

    build(): FetchResult {
      return Object.freeze({
        requestUri:      this._requestUri,
        finalUri:        this._finalUri || this._requestUri,
        statusCode:      this._statusCode,
        statusMessage:   this._statusMessage,
        responseHeaders: Object.freeze(this._responseHeaders),
        body:            this._body,
        bodyTruncated:   this._bodyTruncated,
        fetchDurationMs: this._fetchDurationMs,
        redirectChain:   Object.freeze(this._redirectChain),
        contentType:     this._contentType,
        charset:         this._charset || 'utf-8',
        error:           this._error,
      });
    }
  }

  /** Convenience: build a zero-status error result. */
  export function fromError(requestUri: string, error: Error): FetchResult {
    return builder(requestUri).error(error).build();
  }
}
