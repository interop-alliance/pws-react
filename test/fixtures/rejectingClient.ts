/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * A `PwsClient` stand-in whose every wire path fails with one HTTP status,
 * shared by the sync-port and standing-credential suites. One copy, so a
 * change to the paths the port walks lands in both suites at once.
 */
import type { PwsClient } from '@interop/pws-client'

/**
 * A fake `PwsClient` whose raw `request` and whose `resourceChanges` feed walk
 * both reject with an error carrying the given HTTP status, so a test can
 * assert how the port maps that status on either path (the wire failure a
 * collected annex generation produces on a grant that has not expired).
 *
 * @param status {number}
 * @returns {PwsClient}
 */
export function rejectingClient(status: number): PwsClient {
  const reject = async (): Promise<never> => {
    throw Object.assign(new Error(`HTTP ${status}`), { status })
  }
  // The feed walk is an async iterable whose first page rejects.
  const rejectingWalk = () => ({
    [Symbol.asyncIterator]: () => ({ next: reject })
  })
  return {
    request: reject,
    spaceAt: () => ({ collection: () => ({ resourceChanges: rejectingWalk }) })
  } as unknown as PwsClient
}
