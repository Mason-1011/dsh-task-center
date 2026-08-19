/**
 * Single RPC chokepoint for the kanban client. SRC payload discipline lives
 * here: keys whose value is undefined are dropped before send (the gateway
 * rejects extra keys and undefined values), and transport failures fold into
 * the same `{ok:false,code,message}` vocabulary the host methods return, so
 * callers never see a second error shape.
 * @module @task-center/task-web/client/api
 */

import type { RpcError } from '../wire.ts'
import type { ConnectionService } from './context.ts'

/**
 * One typed call into a task-family RPC namespace over the /api channel.
 * @param connection - the client connection service.
 * @param method - endpoint method, e.g. `board` / `act` / `schedCreate`.
 * @param args - business arguments; undefined-valued keys are stripped.
 * @param namespace - the service namespace; defaults to this board's own.
 * @returns the host method's return value, or one folded RpcError.
 */
export async function callApi<T>(
  connection: ConnectionService,
  method: string,
  args: Readonly<Record<string, unknown>>,
  namespace = 'task-board',
): Promise<T | RpcError> {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) clean[key] = value
  }
  let envelope
  try {
    envelope = await connection.rpc.call('/api', `${namespace}/${method}`, { args: clean })
  } catch (cause) {
    return { ok: false, code: 'RPC_TRANSPORT', message: String(cause) }
  }
  if (!envelope.ok) {
    const error = envelope.error ?? { code: 'RPC_TRANSPORT', message: '未知传输错误' }
    return { ok: false, code: error.code, message: error.message }
  }
  return envelope.value as T
}
