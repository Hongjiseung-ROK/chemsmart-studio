import type { ChildProcess } from 'node:child_process'

export class OwnedProcessTree {
  constructor(
    private readonly child: ChildProcess,
    private readonly name: string
  ) {}

  isAlive(): boolean {
    if (process.platform === 'win32' || this.child.pid === undefined) return !this.hasExited()
    try {
      process.kill(-this.child.pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  async terminate(gracefulTimeoutMs: number, forcedTimeoutMs: number): Promise<void> {
    if (!this.isAlive()) return

    const gracefulExit = this.waitForExit(gracefulTimeoutMs)
    this.signal('SIGTERM')
    if (await gracefulExit) return

    const forcedExit = this.waitForExit(forcedTimeoutMs)
    this.signal('SIGKILL')
    if (await forcedExit) return

    throw new Error(`${this.name} did not exit after SIGKILL`)
  }

  private hasExited(): boolean {
    return this.child.pid === undefined || this.child.exitCode !== null || this.child.signalCode !== null
  }

  private signal(signal: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && this.child.pid !== undefined) process.kill(-this.child.pid, signal)
      else this.child.kill(signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.isAlive()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs
      const poll = () => {
        if (!this.isAlive()) {
          resolve(true)
          return
        }
        if (Date.now() >= deadline) {
          resolve(false)
          return
        }
        const timeout = setTimeout(poll, 25)
        timeout.unref()
      }
      poll()
    })
  }
}
