export type RuntimeFailure = {
  component: string
  state: 'unavailable'
  consecutiveFailures: number
  retryAfterMs: number
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>(resolveWait => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolveWait()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })
}

export async function runSupervisedRuntime(input: {
  component: string
  signal: AbortSignal
  run: () => Promise<void>
  onFailure?: (failure: RuntimeFailure) => void
  minimumRetryMs?: number
  maximumRetryMs?: number
}) {
  let failures = 0
  const minimumRetryMs = input.minimumRetryMs ?? 1_000
  const maximumRetryMs = input.maximumRetryMs ?? 60_000
  while (!input.signal.aborted) {
    try {
      await input.run()
      if (input.signal.aborted) return
      throw new Error('runtime_stopped_unexpectedly')
    } catch {
      if (input.signal.aborted) return
      failures += 1
      const retryAfterMs = Math.min(maximumRetryMs, minimumRetryMs * 2 ** Math.min(6, failures - 1))
      const failure: RuntimeFailure = {
        component: input.component,
        state: 'unavailable',
        consecutiveFailures: failures,
        retryAfterMs,
      }
      input.onFailure?.(failure)
      console.error(JSON.stringify(failure))
      await wait(retryAfterMs, input.signal)
    }
  }
}
