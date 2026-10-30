/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The fake `EncryptionDescriptorSource` the suites script, shaped like the one
 * the sync bootstrap installs (`PwsRemoteStore.descriptorSource`): it declares
 * `verifiesHistory: true` as the real log-governed source does, unless `plain`
 * withholds the flag, which is what a reader under `requireGoverned` must
 * refuse. The single `collectionEncryption` read is a spy, so refreshes can
 * be counted.
 */
import { vi } from 'vitest'
import type { CollectionEncryption } from '@interop/pws-client'

/**
 * @param options {object}
 * @param options.collectionEncryption {function}   the scripted read
 * @param [options.plain] {boolean}   withhold `verifiesHistory`
 * @returns {object}   the fake source
 */
export function fakeDescriptorSource({
  collectionEncryption,
  plain = false
}: {
  collectionEncryption: (options: {
    collectionId: string
  }) => Promise<CollectionEncryption | undefined>
  plain?: boolean
}) {
  return {
    ...(!plain && { verifiesHistory: true as const }),
    collectionEncryption: vi.fn(collectionEncryption)
  }
}
