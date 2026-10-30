/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Unit tests for the glue this package still owns over the client's own sync
 * port: that it is built with `mapAuthErrors` on, so a `401` / `403` / the
 * `404` a WAS server masks a failed capability invocation as arrive as a
 * {@link WasSyncAuthError} the sync controller can match -- on the pull path as
 * well as the push path -- while `412` stays a {@link WasSyncConflictError}, a
 * `404` on delete stays the already-absent success, and every other status
 * propagates unchanged. The requests themselves (paths, headers, ETag parsing)
 * are the client's, and are tested there.
 */
import { describe, it, expect } from 'vitest'
import { rejectingClient } from '../../test/fixtures/rejectingClient.js'
import { createWasSyncPort } from './wasSyncPort.js'
import {
  WasSyncAuthError,
  WasSyncConflictError
} from '@interop/was-client/sync'

function makePort(status: number) {
  return createWasSyncPort({
    was: rejectingClient(status),
    spaceUrl: 'https://was.example/space/space-1/',
    collectionId: 'notes'
  })
}

describe('createWasSyncPort error mapping', () => {
  it('maps a 401 on the query (pull) path to WasSyncAuthError', async () => {
    const port = makePort(401)
    await expect(port.query({ limit: 10 })).rejects.toBeInstanceOf(
      WasSyncAuthError
    )
  })

  it('maps a 403 on a conditional write to WasSyncAuthError', async () => {
    const port = makePort(403)
    await expect(
      port.putContent({ id: 'a', data: { x: 1 } })
    ).rejects.toBeInstanceOf(WasSyncAuthError)
  })

  it('carries the offending status on the WasSyncAuthError', async () => {
    const port = makePort(401)
    await expect(port.putMeta({ id: 'a', custom: {} })).rejects.toMatchObject({
      name: 'WasSyncAuthError',
      status: 401
    })
  })

  it('maps a 412 conditional write to WasSyncConflictError', async () => {
    const port = makePort(412)
    await expect(port.deleteContent({ id: 'a' })).rejects.toBeInstanceOf(
      WasSyncConflictError
    )
  })

  it('treats a 404 on delete as success (resource already gone)', async () => {
    const port = makePort(404)
    await expect(port.deleteContent({ id: 'a' })).resolves.toBeUndefined()
  })

  it('maps a 404 on a content write to WasSyncAuthError (masked denial)', async () => {
    const port = makePort(404)
    await expect(
      port.putContent({ id: 'a', data: { x: 1 } })
    ).rejects.toMatchObject({ name: 'WasSyncAuthError', status: 404 })
  })

  it('maps a 404 on the query (pull) path to WasSyncAuthError', async () => {
    const port = makePort(404)
    await expect(port.query({ limit: 10 })).rejects.toBeInstanceOf(
      WasSyncAuthError
    )
  })

  it('passes a non-mapped status (500) through unchanged', async () => {
    const port = makePort(500)
    await expect(port.query({ limit: 10 })).rejects.not.toBeInstanceOf(
      WasSyncAuthError
    )
    await expect(port.query({ limit: 10 })).rejects.toMatchObject({
      status: 500
    })
  })
})
