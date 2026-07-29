#!/usr/bin/env node

const { spawn } = require('node:child_process')
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const firstFrame = `3
 energy: -5.070451354560 gnorm: 0.006457564538 xtb: 6.7.1
O            0.00000000000000        0.00000000000000       -0.38936110000000
H            0.76298440000000        0.00000000000000        0.19468060000000
H           -0.76298440000000        0.00000000000000        0.19468060000000
`
const secondFrame = `3
 energy: -5.070544443465 gnorm: 0.000075549242 xtb: 6.7.1
O           -0.00000000000000       -0.00000000000000       -0.37930107266932
H            0.77220778800220        0.00000000000000        0.18965058631045
H           -0.77220778806544        0.00000000000000        0.18965058635887
`

const mode = readFileSync(path.join('..', 'fixture-mode'), 'utf8').trim()
writeFileSync('fixture.pid', String(process.pid))
writeFileSync('fixture-args.json', JSON.stringify(process.argv.slice(2)))
if (process.env.XTBPATH === undefined || process.env.OMP_NUM_THREADS !== '1' || process.env.MKL_NUM_THREADS !== '1') {
  process.stderr.write('fixture environment invalid')
  process.exit(9)
}

const args = process.argv.slice(2)
if (args[0] !== 'input.xyz' || !readFileSync(args[0], 'utf8').startsWith('3\n')) {
  process.stderr.write('fixture input invalid')
  process.exit(8)
}

if (mode === 'reordered') {
  const reorderedLines = firstFrame.trimEnd().split('\n')
  ;[reorderedLines[2], reorderedLines[3]] = [reorderedLines[3], reorderedLines[2]]
  writeFileSync('xtbopt.log', `${reorderedLines.join('\n')}\n`)
  process.stdout.write('*** GEOMETRY OPTIMIZATION CONVERGED AFTER 1 ITERATIONS ***\n* finished run\n')
  writeFileSync('.xtboptok', '')
  process.exit(0)
}

writeFileSync('xtbopt.log', firstFrame)

if (mode === 'cancel') {
  const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {
    stdio: 'ignore'
  })
  writeFileSync('descendant.pid', String(descendant.pid))
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1_000)
} else {
  setTimeout(() => {
    if (mode === 'incomplete') {
      appendFileSync('xtbopt.log', secondFrame.slice(0, -40))
    } else {
      appendFileSync('xtbopt.log', secondFrame)
    }
    if (mode === 'final-elements-reordered') {
      const finalLines = secondFrame.trimEnd().split('\n')
      finalLines[2] = finalLines[2].replace(/^O/, 'H')
      finalLines[3] = finalLines[3].replace(/^H/, 'O')
      writeFileSync('xtbopt.xyz', `${finalLines.join('\n')}\n`)
    } else {
      writeFileSync('xtbopt.xyz', secondFrame)
    }
    if (mode === 'not-converged') {
      writeFileSync('NOT_CONVERGED', '')
      process.stdout.write('*** FAILED TO CONVERGE GEOMETRY OPTIMIZATION IN 20 ITERATIONS ***\n* finished run\n')
    } else {
      writeFileSync('.xtboptok', '')
      process.stdout.write('*** GEOMETRY OPTIMIZATION CONVERGED AFTER 2 ITERATIONS ***\n* finished run\n')
    }
    process.exit(0)
  }, 100)
}
