/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The logging seam: the library port of the sibling logging package
 * (decision 0004 in its repo). This module deliberately declares its own
 * `Logger` type rather than importing it (even as a type-only import) from
 * that package, so the published artifact -- the emitted `dist/log.d.ts`
 * included -- carries no reference to its specifier; the
 * mutual-assignability check against the package's own `Logger` type lives
 * in `test/node/log.test.ts` instead. Call sites elsewhere in `src/` still
 * take it as a type-only import where useful (enforced by the eslint
 * `no-restricted-imports` rule); this one file is the stated exception.
 *
 * A consumer that never calls {@link setLogger} keeps a console fallback:
 * same channel and level as a bare `console.*` call, but with a
 * `'[pws-react]'` prefix and the call's `data` passed as a single trailing
 * argument (present only when supplied). An app wires a real logger once at
 * bootstrap, e.g. `setLogger(createLogger('pr'))`.
 *
 * {@link setLogger} also installs the same logger into `@interop/pws-sync`,
 * the replication driver this package runs on, so one call wires both and the
 * driver's diagnostics arrive under the app's `pr` namespace.
 */
import { setLogger as setPwsSyncLogger } from '@interop/pws-sync'

/**
 * The structural logging port every call site in this package logs
 * through. Frozen at four two-arg methods (decision 0004 in the sibling
 * logging package's repo): a static message plus optional structured
 * context, with `data.err` reserved for an Error-ish value.
 */
export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

const consoleFallback: Logger = {
  debug: (msg, data) =>
    console.debug('[pws-react]', msg, ...(data === undefined ? [] : [data])),
  info: (msg, data) =>
    console.info('[pws-react]', msg, ...(data === undefined ? [] : [data])),
  warn: (msg, data) =>
    console.warn('[pws-react]', msg, ...(data === undefined ? [] : [data])),
  error: (msg, data) =>
    console.error('[pws-react]', msg, ...(data === undefined ? [] : [data]))
}

let logger: Logger = consoleFallback

/**
 * Installs `next` as the logger every call site in this package logs
 * through, forwards it to `@interop/pws-sync` as well, and returns the
 * PREVIOUS logger of this package -- so a test (or an app reconfiguring at
 * runtime) can restore it.
 *
 * @param next {Logger}
 * @returns {Logger} the logger that was installed before this call.
 */
export function setLogger(next: Logger): Logger {
  const previous = logger
  logger = next
  setPwsSyncLogger(next)
  return previous
}

/**
 * The package-wide logger. Each method forwards to whichever logger is
 * currently installed, so call sites bound at import time still observe a
 * later {@link setLogger}.
 */
export const log: Logger = {
  debug: (msg, data) => logger.debug(msg, data),
  info: (msg, data) => logger.info(msg, data),
  warn: (msg, data) => logger.warn(msg, data),
  error: (msg, data) => logger.error(msg, data)
}
