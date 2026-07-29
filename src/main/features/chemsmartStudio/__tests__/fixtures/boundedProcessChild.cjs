const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')

const mode = process.argv[2]
const pidFile = process.env.CHEMSMART_TEST_PID_FILE
const descendantPidFile = process.env.CHEMSMART_TEST_DESCENDANT_PID_FILE

if (pidFile) writeFileSync(pidFile, String(process.pid))

if (mode === 'normal') {
  process.stdout.write(
    JSON.stringify({
      allowed: process.env.CHEMSMART_TEST_ALLOWED ?? null,
      blocked: process.env.CHEMSMART_TEST_BLOCKED ?? null
    })
  )
  process.exit(0)
}

if (mode === 'nonzero') {
  process.stderr.write('bounded fixture failure')
  process.exit(7)
}

if (mode === 'oversize') {
  process.stdout.write('x'.repeat(16 * 1024))
  setInterval(() => {}, 1_000)
}

if (mode === 'sleep') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1_000)
}

if (mode === 'descendant-timeout' || mode === 'leader-exit') {
  const descendant = spawn(process.execPath, [__filename, 'sleep'], {
    detached: false,
    stdio: 'ignore'
  })
  if (descendantPidFile) writeFileSync(descendantPidFile, String(descendant.pid))
  if (mode === 'leader-exit') process.exit(0)
  setInterval(() => {}, 1_000)
}
