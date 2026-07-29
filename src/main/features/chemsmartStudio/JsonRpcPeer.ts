import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024

type JsonRpcId = number | string
type IncomingHandler = (method: string, params: unknown) => Promise<unknown>

export class JsonRpcFault extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown
  ) {
    super(message)
    this.name = 'JsonRpcFault'
  }
}

export class JsonRpcPeer extends EventEmitter {
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  >()

  constructor(
    private readonly socket: Socket,
    private readonly incomingHandler: IncomingHandler
  ) {
    super()
    socket.on('data', (chunk) => this.receive(chunk))
    socket.once('close', () => this.close(new JsonRpcFault(-32001, 'RPC peer closed')))
    socket.once('error', (error) => this.close(error))
  }

  request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new JsonRpcFault(-32002, `RPC request timed out: ${method}`))
      }, timeoutMs)
      timeout.unref()
      this.pending.set(id, { resolve, reject, timeout })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  destroy(): void {
    this.socket.destroy()
    this.close(new JsonRpcFault(-32001, 'RPC peer destroyed'))
  }

  private send(payload: object): void {
    const encoded = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
    if (encoded.byteLength > MAX_MESSAGE_BYTES) throw new JsonRpcFault(-32600, 'RPC message exceeds size limit')
    this.socket.write(encoded)
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.byteLength > MAX_MESSAGE_BYTES && !this.buffer.includes(0x0a)) {
      this.destroy()
      return
    }
    let newline = this.buffer.indexOf(0x0a)
    while (newline >= 0) {
      if (newline >= MAX_MESSAGE_BYTES) {
        this.destroy()
        return
      }
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (line.byteLength > 0) void this.receiveLine(line)
      newline = this.buffer.indexOf(0x0a)
    }
  }

  private async receiveLine(line: Buffer): Promise<void> {
    let payload: any
    try {
      payload = JSON.parse(line.toString('utf8'))
    } catch {
      this.sendError(null, -32700, 'Parse error')
      return
    }
    if (!payload || typeof payload !== 'object' || payload.jsonrpc !== '2.0') {
      this.sendError(payload?.id ?? null, -32600, 'Invalid Request')
      return
    }
    if (typeof payload.method === 'string') {
      try {
        const result = await this.incomingHandler(payload.method, payload.params)
        if (payload.id !== undefined) this.send({ jsonrpc: '2.0', id: payload.id, result })
      } catch (error) {
        if (payload.id !== undefined) {
          const fault = error instanceof JsonRpcFault ? error : new JsonRpcFault(-32603, 'Internal error')
          this.sendError(payload.id, fault.code, fault.message, fault.data)
        }
      }
      return
    }
    if (payload.id === undefined) return
    const pending = this.pending.get(payload.id)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(payload.id)
    if (payload.error) {
      pending.reject(new JsonRpcFault(payload.error.code, payload.error.message, payload.error.data))
    } else {
      pending.resolve(payload.result)
    }
  }

  private sendError(id: JsonRpcId | null, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
  }

  private close(error: Error): void {
    if (this.pending.size === 0) return
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
    this.emit('closed', error)
  }
}
