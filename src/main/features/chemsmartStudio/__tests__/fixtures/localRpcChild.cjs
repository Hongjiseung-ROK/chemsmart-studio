const fs = require('node:fs')
const net = require('node:net')
const { spawn } = require('node:child_process')

const mode = process.argv[2]
const socketPath = process.argv[3]
const pidFile = process.env.CHEMSMART_TEST_PID_FILE
const descendantPidFile = process.env.CHEMSMART_TEST_DESCENDANT_PID_FILE

if (!mode || !socketPath) process.exit(64)
if (pidFile) fs.writeFileSync(pidFile, String(process.pid))
if (mode === 'exit-early') process.exit(23)
if (mode === 'ignore-term') process.on('SIGTERM', () => {})
if (mode === 'descendant') {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
  })
  if (descendantPidFile && descendant.pid) fs.writeFileSync(descendantPidFile, String(descendant.pid))
}

try {
  fs.rmSync(socketPath, { force: true })
} catch {}

const send = (socket, payload) => {
  socket.write(`${JSON.stringify(payload)}\n`)
}

const server = net.createServer((socket) => {
  let authenticated = false
  let buffer = ''

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line) continue

      const request = JSON.parse(line)
      if (request.method === 'system.authenticate') {
        if (mode === 'reject-auth' || request.params?.token !== process.env.CHEMSMART_STUDIO_SESSION_TOKEN) {
          send(socket, {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32011, message: 'Authentication failed' }
          })
          continue
        }
        authenticated = true
        send(socket, { jsonrpc: '2.0', id: request.id, result: { authenticated: true } })
        continue
      }
      if (!authenticated) {
        send(socket, {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32011, message: 'Authentication required' }
        })
        continue
      }
      if (request.method === 'system.ping') {
        send(socket, { jsonrpc: '2.0', id: request.id, result: { ok: true, pid: process.pid } })
      } else if (request.method === 'system.protocol_hello') {
        const hello = JSON.parse(process.env.CHEMSMART_TEST_PROTOCOL_HELLO || '{}')
        if (mode === 'protocol-mismatch') hello.schemaSha256 = '0'.repeat(64)
        send(socket, { jsonrpc: '2.0', id: request.id, result: hello })
      } else if (request.method === 'test.exit') {
        setImmediate(() => process.exit(24))
      } else {
        send(socket, {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Method not found' }
        })
      }
    }
  })
})

server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600))
