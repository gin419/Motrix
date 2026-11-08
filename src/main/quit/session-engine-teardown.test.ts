import { describe, expect, it, vi } from 'vitest'
import { stopSessionAndEngineLast } from './session-engine-teardown'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('stopSessionAndEngineLast', () => {
  it('starts Session and engine stops only after every dependent settles', async () => {
    const order: string[] = []
    const tracker = deferred()
    const media = deferred()
    const stopSession = vi.fn(async () => {
      order.push('session')
    })
    const stopEngine = vi.fn(async () => {
      order.push('engine')
    })

    const done = stopSessionAndEngineLast({
      dependents: [
        async () => {
          await tracker.promise
          order.push('tracker')
        },
        async () => {
          await media.promise
          order.push('media')
        },
      ],
      inFlight: Promise.resolve(),
      stopSession,
      stopEngine,
    })

    tracker.resolve()
    await vi.waitFor(() => expect(order).toEqual(['tracker']))
    expect(stopSession).not.toHaveBeenCalled()
    expect(stopEngine).not.toHaveBeenCalled()

    media.resolve()
    await done
    expect(order).toEqual(['tracker', 'media', 'session', 'engine'])
  })

  it('waits for in-flight teardown without delaying the final stops on it', async () => {
    const inFlight = deferred()
    const stopSession = vi.fn(async () => {})
    const stopEngine = vi.fn(async () => {})
    let settled = false

    const done = stopSessionAndEngineLast({
      dependents: [],
      inFlight: inFlight.promise,
      stopSession,
      stopEngine,
    }).then(() => {
      settled = true
    })

    await vi.waitFor(() => expect(stopEngine).toHaveBeenCalledOnce())
    expect(stopSession).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    inFlight.resolve()
    await done
    expect(settled).toBe(true)
  })
})
