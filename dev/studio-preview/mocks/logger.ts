/** Harness logger: keeps a readable trail in the page instead of the renderer's log transport. */
const entries: string[] = []

function record(level: string, context: string, message: string): void {
  entries.push(`${level} ${context}: ${message}`)
}

export const loggerService = {
  initWindowSource: () => undefined,
  withContext: (context: string) => ({
    debug: (message: string) => record('debug', context, message),
    error: (message: string) => record('error', context, message),
    info: (message: string) => record('info', context, message),
    silly: (message: string) => record('silly', context, message),
    verbose: (message: string) => record('verbose', context, message),
    warn: (message: string) => record('warn', context, message)
  })
}

export const harnessLog = entries
