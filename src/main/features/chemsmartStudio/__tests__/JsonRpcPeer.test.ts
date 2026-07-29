import net from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { JsonRpcPeer } from '../JsonRpcPeer'

const sockets: net.Socket[] = []

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
})

async function peerPair() {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TCP test server has no port')
  const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve))
  const clientSocket = net.createConnection(address.port, '127.0.0.1')
  const serverSocket = await accepted
  server.close()
  sockets.push(clientSocket, serverSocket)
  return { clientSocket, serverSocket }
}

describe('JsonRpcPeer', () => {
  it('supports nested bidirectional requests without deadlock', async () => {
    const { clientSocket, serverSocket } = await peerPair()
    const clientRef: { current?: JsonRpcPeer } = {}
    clientRef.current = new JsonRpcPeer(clientSocket, async (method, params) => {
      if (method === 'outer') return { nested: await clientRef.current!.request('inner', params) }
      throw new Error('unknown method')
    })
    const server = new JsonRpcPeer(serverSocket, async (method, params) => {
      if (method === 'inner') return { echo: params }
      throw new Error('unknown method')
    })
    await expect(server.request('outer', { value: 7 })).resolves.toEqual({ nested: { echo: { value: 7 } } })
  })
})
