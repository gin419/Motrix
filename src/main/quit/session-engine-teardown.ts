type TeardownStep = () => Promise<unknown>

export interface SessionEngineTeardown {
  /**
   * Work that still needs Session writes and engine RPC, awaited in order.
   * Neither Session nor the engine starts stopping until all of it settles.
   */
  dependents: readonly TeardownStep[]
  /** Teardown already in flight, joined alongside the final stops. */
  inFlight: Promise<unknown>
  stopSession: TeardownStep
  stopEngine: TeardownStep
}

/**
 * Stop Session persistence and the engine last. Media cancellation, for
 * example, force-removes aria2 segment gids and persists the parent task; if
 * either service stopped first, those gids could resume as orphans on the next
 * launch and the task would come back still marked active.
 */
export async function stopSessionAndEngineLast(
  teardown: SessionEngineTeardown
): Promise<void> {
  for (const dependent of teardown.dependents) await dependent()
  await Promise.all([
    teardown.inFlight,
    teardown.stopSession(),
    teardown.stopEngine(),
  ])
}
