/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * `AudienceReader`: the member-side reader of one plaintext audience
 * collection in another owner's Space.
 *
 * An audience is one plaintext collection in its owner's Space, and membership
 * is a GET and HEAD zcap on that collection's container. A subscriber holds
 * one reader per audience and merges what the readers return by the app's own
 * stable post id, which lives in the post body; the resource id is not a
 * stable identity, since a post that changes audience moves.
 *
 * The reader takes a zcap directly rather than a `WasRemoteStore`: a
 * subscriber's capability comes from the subscription agent's own API, not
 * from a wallet presentation, and it reads another owner's Space, possibly on
 * another host. The client is therefore built from the zcap's own
 * `invocationTarget`.
 *
 * `pull()` follows the collection's `changes` feed through the read-only GET
 * form of the query endpoint, which is what a GET and HEAD grant reaches,
 * keeping a checkpoint per audience and skipping every entry whose `kind` is
 * not `resource`. A server that refuses the GET form (405) or has no feed at
 * all (501) is read through the listing and one GET per resource instead;
 * that fallback answers a full snapshot every time, since it has no
 * checkpoint to resume from.
 *
 * The cut contract: a generation replacement or an annex GC on the owner's
 * side cuts every subscriber child at once, so a denied invocation is the
 * routine path rather than an error. The reader then reports the feed as
 * paused, keeps its checkpoint, and resumes from it once `replaceCapability`
 * hands it a replacement zcap for the same audience. On the wire a denial is
 * a 401 or 403, or the masked 404 WAS answers an unauthorized caller with
 * (named `capability-revoked` or `capability-expired` when the request
 * itself verified, bare when the chain no longer verifies, which is what a
 * collected generation looks like). A collection deleted under the reader
 * is the same 404 and pauses it the same way; it just never resumes.
 *
 * was-client's body reads (`get`, `list`) answer `null` on any 404, the
 * masked denial included, so a null from one of them is ambiguous. The reader
 * settles it with one signed GET of the container through the `request`
 * escape hatch, which maps the denial to its typed error instead.
 *
 * `SharedCollectionReader` is deliberately not reused here: it requires an
 * `encryption` descriptor and its fast path walks the POST-form feed.
 */
import {
  NotFoundError,
  NotImplementedError,
  ValidationError,
  WasClient,
  allowsAction,
  isDenialError,
  mapError,
  type ChangesCheckpoint,
  type Collection,
  type ISigner,
  type IZcap,
  type Json
} from '@interop/was-client'
import {
  collectionPath,
  parseAbsoluteSpaceTarget,
  spacesUrl
} from '@interop/was-client/paths'
import { errorStatus } from '@interop/was-client/sync'
import { log } from '../log.js'

/**
 * The default `changes`-feed page size `pull()` asks for.
 */
export const AUDIENCE_CHANGES_PAGE_SIZE = 100

/**
 * One change of an audience: a live post with its plaintext body, or a
 * tombstone (`deleted: true`, no `data`). A resource rewritten to a non-JSON
 * type is reported as a tombstone too, since it is no longer a post.
 */
export interface AudienceChange {
  id: string
  deleted: boolean
  data?: Json
}

/**
 * What one `pull()` answers. `snapshot` is `true` when the changes are a full
 * read rather than a delta since the last checkpoint: every live post is in
 * it, and a post the consumer holds that is not is gone. That is the answer
 * on a server with no usable feed, and on a replay from the feed's start after
 * the server refused the reader's checkpoint. `paused` is `true` when the pull
 * was denied under the reader's current zcap; the changes collected before
 * the cut are still returned, the checkpoint covers exactly them, and such a
 * partial read is never a snapshot.
 */
export interface AudiencePull {
  changes: AudienceChange[]
  snapshot: boolean
  paused: boolean
}

export class AudienceReader {
  readonly serverUrl: string
  readonly #spaceId: string
  readonly #collectionId: string
  readonly #pageSize: number
  readonly #was: WasClient
  #zcap: IZcap
  #collection: Collection
  #checkpoint: ChangesCheckpoint | null
  #paused = false
  #feedUnsupported = false
  // Bumped by every `replaceCapability`, so a denial raised by a request that
  // left under the previous zcap cannot pause the reader after the
  // replacement landed.
  #generation = 0
  // Pulls are serialized: two overlapping walks from one checkpoint would
  // hand the consumer the same changes twice.
  #chain: Promise<unknown> = Promise.resolve()

  private constructor({
    serverUrl,
    spaceId,
    collectionId,
    zcap,
    signer,
    checkpoint,
    pageSize
  }: {
    serverUrl: string
    spaceId: string
    collectionId: string
    zcap: IZcap
    signer: ISigner
    checkpoint: ChangesCheckpoint | null
    pageSize: number
  }) {
    this.serverUrl = serverUrl
    this.#spaceId = spaceId
    this.#collectionId = collectionId
    this.#zcap = zcap
    this.#was = WasClient.fromSigner({ serverUrl, signer })
    this.#collection = this.#was.fromCapability(zcap) as Collection
    this.#checkpoint = checkpoint
    this.#pageSize = pageSize
  }

  /**
   * Opens a reader over the audience collection `zcap` names. Sends nothing:
   * the first request is the first `pull()`.
   *
   * @param options {object}
   * @param options.zcap {IZcap}   the GET and HEAD zcap on the audience's
   *   container; its `invocationTarget` must name a collection and its
   *   `allowedAction` must include `GET`
   * @param options.signer {ISigner}   the subscriber's invocation signer (the
   *   zcap's controller)
   * @param [options.checkpoint] {ChangesCheckpoint}   a checkpoint a previous
   *   reader of the same audience left off at, to resume strictly after it
   * @param [options.pageSize] {number}   the feed page size (default
   *   `AUDIENCE_CHANGES_PAGE_SIZE`)
   * @returns {AudienceReader}
   */
  static open({
    zcap,
    signer,
    checkpoint = null,
    pageSize = AUDIENCE_CHANGES_PAGE_SIZE
  }: {
    zcap: IZcap
    signer: ISigner
    checkpoint?: ChangesCheckpoint | null
    pageSize?: number
  }): AudienceReader {
    const target = zcap.invocationTarget
    const parsed = parseAbsoluteSpaceTarget(target)
    if (parsed === null || parsed.path.kind !== 'collection') {
      throw new Error(
        `An audience zcap's invocationTarget must name a collection on a ` +
          `WAS server (an absolute URL); got "${target}".`
      )
    }
    assertAllowsGet(zcap)
    return new AudienceReader({
      serverUrl: spacesUrl({ baseUrl: parsed.baseUrl }),
      spaceId: parsed.path.spaceId,
      collectionId: parsed.path.collectionId,
      zcap,
      signer,
      checkpoint,
      pageSize
    })
  }

  /**
   * The audience collection's URL: the current zcap's `invocationTarget`,
   * which every replacement must name too.
   *
   * @returns {string}
   */
  get target(): string {
    return this.#zcap.invocationTarget
  }

  /**
   * The position the next `pull()` resumes after: opaque, scoped to the server
   * and collection that issued it. It moves only together with the changes a
   * pull returns, so it never runs ahead of what the consumer received.
   * Persist it beside the audience and hand it back to `open()` to resume
   * across sessions. `null` before the first pull; unchanged by the listing
   * fallback, which has no checkpoint of its own.
   *
   * @returns {ChangesCheckpoint | null}
   */
  get checkpoint(): ChangesCheckpoint | null {
    return this.#checkpoint
  }

  /**
   * Whether the feed is cut: the last pull was denied and the reader waits
   * for `replaceCapability`.
   *
   * @returns {boolean}
   */
  get paused(): boolean {
    return this.#paused
  }

  /**
   * Resumes a paused reader under a replacement zcap for the same audience,
   * from the checkpoint the cut left it at. Accepted on a live reader too (a
   * renewal ahead of expiry); a request in flight under the previous zcap
   * cannot pause the reader after this. Refuses a zcap for another target,
   * since the checkpoint belongs to this collection alone, and one that does
   * not allow `GET`, which could only pause the reader again.
   *
   * @param options {object}
   * @param options.zcap {IZcap}
   */
  replaceCapability({ zcap }: { zcap: IZcap }): void {
    if (zcap.invocationTarget !== this.target) {
      throw new Error(
        `A replacement audience zcap must target "${this.target}"; got ` +
          `"${zcap.invocationTarget}".`
      )
    }
    assertAllowsGet(zcap)
    this.#zcap = zcap
    this.#collection = this.#was.fromCapability(zcap) as Collection
    this.#generation += 1
    this.#paused = false
  }

  /**
   * Reads every change since the checkpoint, to the end of the feed. On a
   * server without a usable feed, reads the whole live set instead
   * (`snapshot: true`), as it does when the server refuses the checkpoint it
   * holds (a retired feed layout), replaying the feed from its start. A
   * denial pauses the reader and answers what was collected before the cut,
   * with the checkpoint kept; a paused reader answers an empty pull without a
   * request until `replaceCapability`. Any other failure rejects with the
   * checkpoint left where the pull began, so the next pull re-reads what this
   * one could not deliver.
   *
   * @returns {Promise<AudiencePull>}
   */
  async pull(): Promise<AudiencePull> {
    const run = this.#chain.then(() => this.#pull())
    this.#chain = run.catch(() => undefined)
    return run
  }

  async #pull(): Promise<AudiencePull> {
    if (this.#paused) {
      return { changes: [], snapshot: false, paused: true }
    }
    if (this.#feedUnsupported) {
      return this.#pullSnapshot()
    }
    try {
      return await this.#pullFeed({ checkpoint: this.#checkpoint })
    } catch (err) {
      if (
        !(err instanceof ValidationError) ||
        errorStatus(err) !== 400 ||
        this.#checkpoint === null
      ) {
        throw err
      }
      // A 400 with a checkpoint in hand is the server refusing it (one it did
      // not issue, or one from a retired layout). Replay from the start once;
      // a 400 the replay raises too is the genuine failure and propagates,
      // and the stored checkpoint is dropped only once the replay returns.
      log.warn(
        'The audience feed refused the stored checkpoint; replaying the ' +
          'feed from its start.',
        { collectionId: this.#collectionId, err }
      )
      const replay = await this.#pullFeed({ checkpoint: null })
      return { ...replay, snapshot: !replay.paused }
    }
  }

  /**
   * Walks the feed from `checkpoint` to its end. The reader's checkpoint is
   * committed only on a return, together with the changes it covers: on a cut
   * it is the last fully read page's, and on any other failure it does not
   * move.
   */
  async #pullFeed({
    checkpoint
  }: {
    checkpoint: ChangesCheckpoint | null
  }): Promise<AudiencePull> {
    const generation = this.#generation
    const collection = this.#collection
    const changes: AudienceChange[] = []
    let reached = checkpoint
    try {
      // was-client's walk drops every entry whose `kind` is not `resource`
      // (decision 0013), follows a page the filter emptied, ends only on a
      // null checkpoint, and fails on a checkpoint the server repeats.
      for await (const page of collection.resourceChanges({
        checkpoint: checkpoint ?? undefined,
        limit: this.#pageSize
      })) {
        for (const doc of page.documents) {
          if (!doc.deleted && doc.data !== undefined) {
            changes.push({ id: doc.id, deleted: false, data: doc.data as Json })
            continue
          }
          if (!doc.deleted) {
            // A live non-JSON resource (binary, `text/jsonl`) carries no
            // inline body and is not a post; reported as gone, so a consumer
            // holding an earlier JSON version converges.
            log.warn('Reporting a non-JSON resource in an audience as gone.', {
              collectionId: this.#collectionId,
              resourceId: doc.id,
              contentType: doc.contentType
            })
          }
          changes.push({ id: doc.id, deleted: true })
        }
        if (page.checkpoint !== null) {
          reached = page.checkpoint
        }
      }
    } catch (err) {
      if (this.#cut({ err, generation })) {
        this.#checkpoint = reached
        return { changes, snapshot: false, paused: this.#paused }
      }
      if (!feedUnavailable(err)) {
        throw err
      }
      log.warn(
        'The audience collection has no usable changes feed; reading it ' +
          'through the listing instead.',
        { collectionId: this.#collectionId, status: errorStatus(err) }
      )
      this.#feedUnsupported = true
      return this.#pullSnapshot()
    }
    this.#checkpoint = reached
    return { changes, snapshot: false, paused: false }
  }

  /**
   * Reads one post by resource id. `undefined` when it is missing, and when
   * the reader is paused: a denial pauses the reader, like a pull.
   *
   * @param resourceId {string}
   * @returns {Promise<Json | undefined>}
   */
  async get(resourceId: string): Promise<Json | undefined> {
    if (this.#paused) {
      return undefined
    }
    const generation = this.#generation
    try {
      const body = await this.#collection.get(resourceId)
      if (body === null) {
        // Missing, or the masked denial: settled by one container read.
        await this.#assertVisible({ generation })
        return undefined
      }
      return postBody(body)
    } catch (err) {
      if (this.#cut({ err, generation })) {
        return undefined
      }
      throw err
    }
  }

  /**
   * The listing path: every resource summary, then one GET per resource. A
   * null listing is the collection missing or the masked denial, both the
   * cut; a null body for a listed resource is a deletion racing the walk or
   * the masked denial, settled by one container read.
   */
  async #pullSnapshot(): Promise<AudiencePull> {
    const generation = this.#generation
    const collection = this.#collection
    const changes: AudienceChange[] = []
    try {
      const listing = await collection.list()
      if (listing === null) {
        throw new NotFoundError(
          `The audience collection "${this.#collectionId}" is missing or ` +
            'not visible.'
        )
      }
      const bodies = await Promise.all(
        listing.items.map(async item => ({
          id: item.id,
          body: await collection.get(item.id)
        }))
      )
      if (bodies.some(({ body }) => body === null)) {
        await this.#assertVisible({ generation })
      }
      for (const { id, body } of bodies) {
        const data = postBody(body)
        if (data !== undefined) {
          changes.push({ id, deleted: false, data })
        }
      }
    } catch (err) {
      if (this.#cut({ err, generation })) {
        return { changes: [], snapshot: false, paused: this.#paused }
      }
      throw err
    }
    return { changes, snapshot: true, paused: false }
  }

  /**
   * One signed GET of the container through the escape hatch, which maps a
   * 404 to its typed error rather than to `null`. Resolves when the
   * collection is still readable and throws the mapped denial otherwise.
   */
  async #assertVisible({ generation }: { generation: number }): Promise<void> {
    if (generation !== this.#generation) {
      return
    }
    try {
      await this.#was.request({
        capability: this.#zcap,
        path: collectionPath(this.#spaceId, this.#collectionId),
        method: 'GET'
      })
    } catch (err) {
      throw mapError(err)
    }
  }

  /**
   * Pauses the reader when `err` is a denial (a 401 or 403, or the masked
   * 404 and its named `capability-revoked` / `capability-expired` causes)
   * raised under the current zcap. A denial of a request that left under a
   * zcap since replaced is logged as the cut it was, but pauses nothing, and
   * the pull it ends reports `paused: false`.
   */
  #cut({ err, generation }: { err: unknown; generation: number }): boolean {
    if (!isDenialError(err)) {
      return false
    }
    if (generation === this.#generation) {
      this.#paused = true
    }
    log.warn('The audience feed is cut; waiting for a replacement zcap.', {
      collectionId: this.#collectionId,
      status: errorStatus(err),
      cause: (err as Error).name,
      stale: generation !== this.#generation
    })
    return true
  }
}

/**
 * Refuses a zcap that names its actions and leaves `GET` out: every read the
 * reader makes is a `GET`, so such a zcap could only pause it.
 */
function assertAllowsGet(zcap: IZcap): void {
  if (!allowsAction({ zcap, action: 'GET' })) {
    throw new Error(
      `An audience zcap must allow GET; got ` +
        `${JSON.stringify(zcap.allowedAction)}.`
    )
  }
}

/**
 * The JSON body of a post, or `undefined` for a missing resource and for a
 * binary one, which is not a post.
 */
function postBody(body: Json | Blob | null): Json | undefined {
  if (body === null || body instanceof Blob) {
    return undefined
  }
  return body
}

/**
 * Whether the GET-form feed is unavailable on this server: refused outright
 * (405) or not implemented (501).
 */
function feedUnavailable(err: unknown): boolean {
  return err instanceof NotImplementedError || errorStatus(err) === 405
}
