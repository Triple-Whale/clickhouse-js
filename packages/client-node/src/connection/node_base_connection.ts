import type {
  BaseQueryParams,
  ClickHouseSummary,
  ConnBaseQueryParams,
  ConnCommandResult,
  Connection,
  ConnectionParams,
  ConnExecResult,
  ConnInsertParams,
  ConnInsertResult,
  ConnOperation,
  ConnPingResult,
  ConnQueryResult,
  LogWriter,
} from '@tw/clickhouse-client-common'
import {
  isSuccessfulResponse,
  parseError,
  toSearchParams,
  transformUrl,
  withHttpSettings,
} from '@tw/clickhouse-client-common'
import crypto from 'crypto'
import type Http from 'http'
import Stream from 'stream'
import type { URLSearchParams } from 'url'
import Zlib from 'zlib'
import { getAsText, getUserAgent, isStream } from '../utils'
import { decompressResponse, isDecompressionError } from './compression'
import { drainStream } from './stream'

export type NodeConnectionParams = ConnectionParams & {
  tls?: TLSParams
  agent?: Http.Agent
  keep_alive: {
    enabled: boolean
    idle_socket_ttl: number
  }
}

export type TLSParams =
  | {
      ca_cert: Buffer
      type: 'Basic'
    }
  | {
      ca_cert: Buffer
      cert: Buffer
      key: Buffer
      type: 'Mutual'
    }

export interface RequestParams {
  method: 'GET' | 'POST'
  url: URL
  headers: Http.OutgoingHttpHeaders
  body?: string | Stream.Readable
  // provided by the user and wrapped around internally
  abort_signal: AbortSignal
  decompress_response?: boolean
  compress_request?: boolean
  parse_summary?: boolean
}

export abstract class NodeBaseConnection
  implements Connection<Stream.Readable>
{
  protected readonly defaultAuthHeader: string
  protected readonly defaultHeaders: Http.OutgoingHttpHeaders
  protected readonly additionalHTTPHeaders: Record<string, string>

  private readonly logger: LogWriter

  protected constructor(
    protected readonly params: NodeConnectionParams,
    protected readonly agent: Http.Agent,
  ) {
    this.additionalHTTPHeaders = params.http_headers ?? {}
    this.defaultAuthHeader = `Basic ${Buffer.from(
      `${params.username}:${params.password}`,
    ).toString('base64')}`
    this.defaultHeaders = {
      ...this.additionalHTTPHeaders,
      // KeepAlive agent for some reason does not set this on its own
      Connection: this.params.keep_alive.enabled ? 'keep-alive' : 'close',
      'User-Agent': getUserAgent(this.params.application_id),
    }
    this.logger = params.log_writer
  }

  async ping(): Promise<ConnPingResult> {
    const abortController = new AbortController()
    try {
      const { stream } = await this.request(
        {
          method: 'GET',
          url: transformUrl({ url: this.params.url, pathname: '/ping' }),
          abort_signal: abortController.signal,
          headers: this.buildRequestHeaders(),
        },
        'Ping',
      )
      await drainStream(stream)
      return { success: true }
    } catch (error) {
      // it is used to ensure that the outgoing request is terminated,
      // and we don't get an unhandled error propagation later
      abortController.abort('Ping failed')
      // not an error, as this might be semi-expected
      this.logger.warn({
        message: this.httpRequestErrorMessage('Ping'),
        err: error as Error,
      })
      return {
        success: false,
        error: error as Error, // should NOT be propagated to the user
      }
    }
  }

  async query(
    params: ConnBaseQueryParams,
  ): Promise<ConnQueryResult<Stream.Readable>> {
    const query_id = this.getQueryId(params.query_id)
    const clickhouse_settings = withHttpSettings(
      params.clickhouse_settings,
      this.params.compression.decompress_response,
    )
    const searchParams = toSearchParams({
      database: this.params.database,
      clickhouse_settings,
      query_params: params.query_params,
      session_id: params.session_id,
      query_id,
    })
    const decompressResponse = clickhouse_settings.enable_http_compression === 1
    const { controller, controllerCleanup } = this.getAbortController(params)
    try {
      const { stream } = await this.request(
        {
          method: 'POST',
          url: transformUrl({ url: this.params.url, searchParams }),
          body: params.query,
          abort_signal: controller.signal,
          decompress_response: decompressResponse,
          // @ts-expect-error fix
          headers: this.buildRequestHeaders(params),
        },
        'Query',
      )
      return {
        stream,
        query_id,
      }
    } catch (err) {
      controller.abort('Query HTTP request failed')
      this.logRequestError({
        op: 'Query',
        query_id: query_id,
        query_params: params,
        search_params: searchParams,
        err: err as Error,
        extra_args: {
          decompress_response: decompressResponse,
          clickhouse_settings,
        },
      })
      throw err // should be propagated to the user
    } finally {
      controllerCleanup()
    }
  }

  async insert(
    params: ConnInsertParams<Stream.Readable>,
  ): Promise<ConnInsertResult> {
    const query_id = this.getQueryId(params.query_id)
    const searchParams = toSearchParams({
      database: this.params.database,
      clickhouse_settings: params.clickhouse_settings,
      query_params: params.query_params,
      query: params.query,
      session_id: params.session_id,
      query_id,
    })
    const { controller, controllerCleanup } = this.getAbortController(params)
    try {
      const { stream, summary } = await this.request(
        {
          method: 'POST',
          url: transformUrl({ url: this.params.url, searchParams }),
          body: params.values,
          abort_signal: controller.signal,
          compress_request: this.params.compression.compress_request,
          parse_summary: true,
          // @ts-expect-error fix
          headers: this.buildRequestHeaders(params),
        },
        'Insert',
      )
      await drainStream(stream)
      return { query_id, summary }
    } catch (err) {
      controller.abort('Insert HTTP request failed')
      this.logRequestError({
        op: 'Insert',
        query_id: query_id,
        query_params: params,
        search_params: searchParams,
        err: err as Error,
        extra_args: {
          clickhouse_settings: params.clickhouse_settings ?? {},
        },
      })
      throw err // should be propagated to the user
    } finally {
      controllerCleanup()
    }
  }

  async exec(
    params: ConnBaseQueryParams,
  ): Promise<ConnExecResult<Stream.Readable>> {
    return this.runExec({
      ...params,
      op: 'Exec',
    })
  }

  async command(params: ConnBaseQueryParams): Promise<ConnCommandResult> {
    const { stream, query_id, summary } = await this.runExec({
      ...params,
      op: 'Command',
    })
    // ignore the response stream and release the socket immediately
    await drainStream(stream)
    return { query_id, summary }
  }

  async close(): Promise<void> {
    if (this.agent !== undefined && this.agent.destroy !== undefined) {
      this.agent.destroy()
    }
  }

  protected buildRequestHeaders(
    params?: BaseQueryParams,
  ): Http.OutgoingHttpHeaders {
    return {
      ...this.defaultHeaders,
      Authorization:
        params?.auth !== undefined
          ? `Basic ${Buffer.from(`${params.auth.username}:${params.auth.password}`).toString('base64')}`
          : this.defaultAuthHeader,
    }
  }

  protected abstract createClientRequest(
    params: RequestParams,
  ): Http.ClientRequest

  private getQueryId(query_id: string | undefined): string {
    return query_id || crypto.randomUUID()
  }

  // a wrapper over the user's Signal to terminate the failed requests
  private getAbortController(params: ConnBaseQueryParams): {
    controller: AbortController
    controllerCleanup: () => void
  } {
    const controller = new AbortController()
    function onAbort() {
      controller.abort()
    }
    params.abort_signal?.addEventListener('abort', onAbort)
    return {
      controller,
      controllerCleanup: () => {
        params.abort_signal?.removeEventListener('abort', onAbort)
      },
    }
  }

  private logResponse(
    op: ConnOperation,
    request: Http.ClientRequest,
    params: RequestParams,
    response: Http.IncomingMessage,
    startTimestamp: number,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { authorization, host, ...headers } = request.getHeaders()
    const duration = Date.now() - startTimestamp
    this.params.log_writer.debug({
      module: 'HTTP Adapter',
      message: `${op}: got a response from ClickHouse`,
      args: {
        request_method: params.method,
        request_path: params.url.pathname,
        request_params: params.url.search,
        request_headers: headers,
        response_status: response.statusCode,
        response_headers: response.headers,
        response_time_ms: duration,
      },
    })
  }

  private logRequestError({
    op,
    err,
    query_id,
    query_params,
    search_params,
    extra_args,
  }: LogRequestErrorParams) {
    this.logger.error({
      message: this.httpRequestErrorMessage(op),
      err: err as Error,
      args: {
        query: query_params.query,
        search_params: search_params?.toString() ?? '',
        with_abort_signal: query_params.abort_signal !== undefined,
        session_id: query_params.session_id,
        query_id: query_id,
        ...extra_args,
      },
    })
  }

  private httpRequestErrorMessage(op: ConnOperation): string {
    return `${op}: HTTP request error.`
  }

  private parseSummary(
    op: ConnOperation,
    response: Http.IncomingMessage,
  ): ClickHouseSummary | undefined {
    const summaryHeader = response.headers['x-clickhouse-summary']
    if (typeof summaryHeader === 'string') {
      try {
        return JSON.parse(summaryHeader)
      } catch (err) {
        this.logger.error({
          message: `${op}: failed to parse X-ClickHouse-Summary header.`,
          args: {
            'X-ClickHouse-Summary': summaryHeader,
          },
          err: err as Error,
        })
      }
    }
  }

  private async runExec(
    params: RunExecParams,
  ): Promise<ConnExecResult<Stream.Readable>> {
    const query_id = this.getQueryId(params.query_id)
    const searchParams = toSearchParams({
      database: this.params.database,
      clickhouse_settings: params.clickhouse_settings,
      query_params: params.query_params,
      session_id: params.session_id,
      query_id,
    })
    const { controller, controllerCleanup } = this.getAbortController(params)
    try {
      const { stream, summary } = await this.request(
        {
          method: 'POST',
          url: transformUrl({ url: this.params.url, searchParams }),
          body: params.query,
          abort_signal: controller.signal,
          parse_summary: true,
          // @ts-expect-error fix
          headers: this.buildRequestHeaders(params),
        },
        params.op,
      )
      return {
        stream,
        query_id,
        summary,
      }
    } catch (err) {
      controller.abort(`${params.op} HTTP request failed`)
      this.logRequestError({
        op: params.op,
        query_id: query_id,
        query_params: params,
        search_params: searchParams,
        err: err as Error,
        extra_args: {
          clickhouse_settings: params.clickhouse_settings ?? {},
        },
      })
      throw err // should be propagated to the user
    } finally {
      controllerCleanup()
    }
  }

  private async request(
    params: RequestParams,
    op: ConnOperation,
  ): Promise<RequestResult> {
    return new Promise((resolve, reject) => {
      const start = Date.now()
      const request = this.createClientRequest(params)

      request.on('error', onError)
      function onError(err: Error): void {
        reject(err)
      }

      const onResponse = async (
        _response: Http.IncomingMessage,
      ): Promise<void> => {
        _response.on('error', onError)
        this.logResponse(op, request, params, _response, start)

        const decompressionResult = decompressResponse(_response)
        if (isDecompressionError(decompressionResult)) {
          return reject(decompressionResult.error)
        }
        if (isSuccessfulResponse(_response.statusCode)) {
          return resolve({
            stream: decompressionResult.response,
            summary: params.parse_summary
              ? this.parseSummary(op, _response)
              : undefined,
          })
        } else {
          reject(parseError(await getAsText(decompressionResult.response)))
        }
      }

      request.on('response', onResponse)

      function onAbort(): void {
        // Prefer 'abort' event since it always triggered unlike 'error' and 'close'
        // see the full sequence of events https://nodejs.org/api/http.html#httprequesturl-options-callback
        request.once('error', function () {
          /**
           * catch "Error: ECONNRESET" error which shouldn't be reported to users.
           * see the full sequence of events https://nodejs.org/api/http.html#httprequesturl-options-callback
           * */
        })
        reject(new Error('The user aborted a request.'))
      }

      function pipeStream(): void {
        // if request.end() was called due to no data to send
        if (request.writableEnded) {
          return
        }

        const bodyStream = isStream(params.body)
          ? params.body
          : Stream.Readable.from([params.body])

        const callback = (err: NodeJS.ErrnoException | null): void => {
          if (err) {
            reject(err)
          }
        }

        if (params.compress_request) {
          Stream.pipeline(bodyStream, Zlib.createGzip(), request, callback)
        } else {
          Stream.pipeline(bodyStream, request, callback)
        }
      }

      pipeStream()

      if (params.abort_signal !== undefined) {
        params.abort_signal.addEventListener('abort', onAbort, { once: true })
      }

      if (!params.body) return request.end()
    })
  }
}

interface RequestResult {
  stream: Stream.Readable
  summary?: ClickHouseSummary
}

interface LogRequestErrorParams {
  op: ConnOperation
  err: Error
  query_id: string
  query_params: ConnBaseQueryParams
  search_params: URLSearchParams | undefined
  extra_args: Record<string, unknown>
}

type RunExecParams = ConnBaseQueryParams & {
  op: 'Exec' | 'Command'
}
