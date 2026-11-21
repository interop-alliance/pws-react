/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Log capture for the suites that assert on what the library logged.
 */
import { captureLogger } from '@interop/logger'
import { setLogger } from '../../src/log.js'

/**
 * Runs `run` with the library's logger captured, restoring the previous one
 * afterwards.
 *
 * @param run {() => Promise<T>}   the work to capture the logs of
 * @returns {Promise<object>}   `run`'s result and the captured events
 */
export async function withCapturedLogs<T>(
  run: () => Promise<T>
): Promise<{ result: T; events: ReturnType<typeof captureLogger>['events'] }> {
  const capture = captureLogger('pr')
  const previous = setLogger(capture.logger)
  try {
    return { result: await run(), events: capture.events }
  } finally {
    setLogger(previous)
  }
}
