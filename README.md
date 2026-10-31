# @interop/pws-react _(@interop/pws-react)_

[![NPM Version](https://img.shields.io/npm/v/@interop/pws-react.svg)](https://npm.im/@interop/pws-react)

> React library for building "Bring Your Own Everything" (BYOE) apps on Portable
> Web Spaces: DID-Auth login via a CHAPI wallet, local-first encrypted storage,
> and background sync to a PWS server.

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Quick start](#quick-start)
- [Login flow](#login-flow)
- [Session lifecycle](#session-lifecycle)
- [Sync architecture](#sync-architecture)
- [Entry points](#entry-points)
- [Logging](#logging)
- [Dev tooling](#dev-tooling)
- [Testing](#testing)
- [Contribute](#contribute)
- [License](#license)

## Background

"Bring Your Own Everything" (BYOE) is a way to build web apps with no backend
that the app owns. The user brings their own identity (a wallet) and their own
storage (Portable Web Spaces, PWS), and the app stores everything encrypted in
that user-owned space. The app is a requester: the party (an app, service, or
agent) that asks a wallet for grants. It authenticates via "Login With Wallet"
(CHAPI) and reads and writes the user's PWS space using wallet-delegated
authorization capabilities (zcaps). It never owns the space, never holds the
wallet's root key, and invokes only the zcaps the wallet grants it.

"Bring Your Own Storage" (BYOS) is the storage half of that model. Every
application collection is encrypted client-side as an Encrypted Data Vault
(EDV): the PWS server only ever sees opaque JWE envelopes and can neither read
nor search the plaintext. Data is local-first -- a local RxDB (IndexedDB)
database holds the encrypted envelopes and replicates them to PWS in the
background. The app works fully offline; sync resumes on reconnect.

`@interop/pws-react` is the reusable plumbing for that model, extracted from a
production BYOE app. It wraps
[`@interop/pws-client`](https://npm.im/@interop/pws-client) and owns identity
derivation, the CHAPI login flow, the session lifecycle store, the encrypted
local replica, PWS replication, and a small set of React hooks and optional MUI
components. An app supplies its configuration, its collection registry, and its
own domain and UI; the library owns everything in between.

## Install

Node.js 24+ is recommended. The package is ESM-only.

```
pnpm add @interop/pws-react
```

Peer dependencies (install the ones you use):

```
pnpm add react zustand rxdb
```

`react >= 19` and `zustand ^5` are required peers. `rxdb ^17.5` is an optional
peer: every app that keeps a local replica (anything rendering
`PwsSessionProvider`) needs it, while an app that only reads wallet-owned shared
collections through `SharedCollectionReader` builds no replica and can leave it
out. `LocalStore` and `SyncController` load `rxdb` (and the replication driver's
`@interop/pws-sync/rxdb` entry) on first use rather than at import, so the root
entry resolves without it; a missing `rxdb` surfaces at the first replica
operation.

The optional `@interop/pws-react/mui` entry additionally needs `@mui/material`,
`@mui/icons-material`, and `react-router`; the core entry never imports them.

No particular bundler is required: the library reads `import.meta.env.MODE` (a
Vite convention) only defensively, so webpack / Rspack / Parcel builds and Node
SSR imports work; without it, non-production-only affordances (the e2e CHAPI
bridge) simply stay off.

```
pnpm add @mui/material @mui/icons-material @emotion/react @emotion/styled react-router
```

## Quick start

An app builds one `PwsAppConfig`, a `StoreRegistry` (per-collection hydrate and
patch handlers), wraps its tree in `<PwsSessionProvider>`, and drives the
session through the hooks. The example below wires a single `notes` collection.

### 1. Configuration

```ts
// app.config.ts
import type { PwsAppConfig } from '@interop/pws-react'

export const config: PwsAppConfig = {
  appName: 'Notes',
  appOrigin: 'https://notes.example',
  appUrl: 'https://notes.example/app',
  collections: [{ key: 'notes', id: 'notes' }]
}
```

`collections` maps each app-side `key` (the local RxDB collection handle) to a
PWS collection `id` (a deliberately unprefixed, generic name shared across
interoperable apps). `appUrl` is this application's canonical URL -- absolute,
fragment-less, and same-origin with the browser origin the app runs on -- and
identifies it among the applications on that origin: the app-key identity is
scoped to the triple (user, origin, `appUrl`). Everything downstream compares
the parsed URL's serialization. All other fields (`mediatorBase`, `dbName`,
`storageKeyPrefix`, `sync`, `expiry`) are optional with documented defaults.

A collection may also declare `visibility: 'public'`
(`{ key: 'posts', id: 'microblog-posts', visibility: 'public' }`); the default
is `'private'`. A public collection is world-readable and therefore PLAINTEXT:
no encryption key is involved at all, payloads are stored as-is locally and
remotely, and the stored resource id is the payload's own logical `id`, so a
public document keeps a stable, shareable resource URL across edits. Be aware
that everything in a public payload is world-readable -- including the LWW
bookkeeping fields `updatedAt` and `writerId` (`writerId` is a random
per-install identifier, but still a linkability handle across a user's public
documents). Changing a collection's visibility after first use is a
data-migration event, not a config tweak: rows written in the other mode stop
being readable. A registry that maps one PWS collection id to both visibilities
is rejected at store open. Two payload constraints on public collections: a
top-level object-valued `jwe` field is reserved (the read path uses it to
recognize a stray encrypted envelope and refuses the row), and rows carry the
`updatedAt` / `writerId` LWW fields like any other collection -- world-readable
along with the rest of the payload.

At login, a public collection is requested from the wallet with the distinct
`https://w3id.org/byoe#public-collection` descriptor type (private collections
use `https://w3id.org/byoe#private-collection`): the wallet provisions it
plaintext with a public-read policy, shows a world-readable consent warning, and
delegates the usual read/write capability (public covers only unauthenticated
reads; writes stay capability-only). A wallet that predates the descriptor
reports the request unsatisfiable rather than silently provisioning a private
collection, so the feature fails closed with older wallets. Publicness is
granted at consent time by the wallet -- the app itself can never escalate an
existing private collection to public.

#### Shared (wallet-owned) collections

`collections` above are collections this app OWNS: the wallet provisions them,
the app writes them, and they replicate into the local replica. A third kind is
read-only and belongs to the wallet -- one of the wallet's own encrypted
collections (`private-credentials`, `wallet-activity`, `contacts`,
`contacts-history`) that the user chooses to share with this app. Declare those
separately:

```ts
sharedCollections: [{ key: 'walletCredentials', id: 'private-credentials' }]
```

A shared collection is read-only by construction. It is never replicated into
RxDB, never written to, has no local replica, and is excluded from the sync
bootstrap's collection-description writes. Reads go straight to the server
through a `SharedCollectionReader`, looked up by its `key`:

```ts
const shared = useSharedCollection('walletCredentials')
const items = (await shared?.list()) ?? []
const one = await shared?.get(items[0].id)
```

`list()` reads the collection through pws-client's `Collection.documents()` walk
over the PWS `changes` feed, which returns whole pages of documents with their
bodies -- and on an encrypted collection those bodies are the opaque EDV
envelopes the reader wants, since the feed does not decrypt. That is one request
per page rather than one per credential. The walk keeps only the feed's live
JSON `kind: 'resource'` entries. The Collection's own records
(`collection-metadata`, `log`), unknown kinds, tombstones (`deleted`), and
binary or `text/jsonl` resources are skipped, so the result is the live set of
JSON resources. A backend that does not support the `changes-query` feature
answers 501; the reader then falls back to listing the resource summaries and
fetching each body, warning once that the collection is being read the slow way.
`SharedCollectionReader.open` takes an optional `pageSize` (default
`SHARED_CHANGES_PAGE_SIZE`, 100).

A collection may be app-owned or shared, never both; a registry that declares
the same `key` or `id` in each is rejected at store open
(`validateSharedCollections`).

At login each shared collection is requested with the distinct
`https://w3id.org/byoe#shared-wallet-collection` descriptor type and the
read-only action set `SHARED_ACTIONS` (`GET`/`HEAD`) -- an app never asks to
write a wallet collection. As with `https://w3id.org/byoe#public-collection`, a
wallet that predates the type reports the request unsatisfiable and the feature
fails closed, which is the point: a share fuses two axes -- the read zcap AND an
entry in the collection's key-epoch roster -- and a wallet that granted only the
zcap would hand the app ciphertext it cannot decrypt, surfacing as corrupt data
rather than as a wallet that needs updating.

Decryption uses the app's **identity** key-agreement key: the X25519 twin of its
`did:key` controller (`IdentityAgents.keyAgreementKey`), which is exactly what
the wallet derives from the controller DID when it writes the app into the
roster, so the recipient key never travels on the wire. It is the same key the
app's own collections are encrypted with -- an epoch-roster recipient is always
the X25519 twin of a controller did:key, whoever owns the collection.

Two honest limits, the same ones the wallet's consent screen states. Access can
be removed later, which stops future reads but cannot take back what has already
been read. And resources written BEFORE the collection was first shared are
sealed to the owner alone and are never re-encrypted -- they will not decrypt
here. Both `list()` and `get()` skip such a resource with a warning rather than
failing; a collection this app is not a recipient of at all fails at open time
with a `SharedCollectionUnavailableError`, and the session continues without
that reader.

Every encrypted collection, shared or app-owned, is read through a verifying
descriptor source: the collection's `meta/log`, checked against the Space
owner's did:webvh account log (published world-readable in the Space's `id`
collection). A collection with no governing log stays unreadable, and a source
that does not verify is refused with pws-client's `UnverifiedDescriptorError`,
surfaced as itself.

#### Audiences

An audience is one plaintext collection in another user's Space that this user
has been granted a GET and HEAD zcap on. The zcap comes from the subscription
agent's API rather than from a wallet login, so it is read through an
`AudienceReader` opened on the zcap directly, with the app's own signer:

```ts
import { AudienceReader } from '@interop/pws-react'

const reader = AudienceReader.open({ zcap, signer, checkpoint: saved })
const { changes, paused, snapshot } = await reader.pull()
persist(reader.checkpoint)
```

`pull()` follows the collection's `changes` feed from the checkpoint and returns
the live posts (with their bodies) and tombstones since then; the checkpoint
moves only with the changes a pull returns. When the server has no usable feed,
or refuses the stored checkpoint, it returns a full read instead
(`snapshot: true`): every live post is in it, and a post you hold that is not is
gone. A denied pull (`paused: true`) keeps the checkpoint; hand the reader a
replacement zcap with `replaceCapability({ zcap })` and the next pull resumes
from it. Merge audiences by the stable post id in the post body, not by resource
id.

### 2. Entity stores and the registry

```ts
// stores.ts
import { createEntityStore, type StoreRegistry } from '@interop/pws-react'

export interface Note {
  id: string
  title: string
  body: string
  createdAt: string
  updatedAt: string
  writerId: string
}

export const useNotes = createEntityStore<Note>('notes')

export const registry: StoreRegistry = {
  notes: {
    hydrate: () => useNotes.getState().hydrate(),
    upsert: doc => useNotes.getState().patch(doc as Note),
    drop: uuid => useNotes.getState().drop(uuid),
    clear: () => useNotes.getState().replaceAll([])
  }
}
```

`createEntityStore` returns a zustand hook holding the decrypted payloads as a
`Map<uuid, Note>`; its `insert` / `update` / `upsert` / `remove` verbs persist
through the encrypted local store (the write verbs stamping the LWW fields
`updatedAt` / `writerId` themselves), while `hydrate` / `patch` / `drop` /
`replaceAll` are the handlers the rehydrate mechanism drives on login, remote
sync, and logout.

### 3. Provider

```tsx
// main.tsx
import { PwsSessionProvider } from '@interop/pws-react'
import { config } from './app.config.js'
import { registry } from './stores.js'

export function Root() {
  return (
    <PwsSessionProvider config={config} registry={registry}>
      <App />
    </PwsSessionProvider>
  )
}
```

### 4. Login page

```tsx
// LoginPage.tsx
import { useLogin } from '@interop/pws-react'

export function LoginPage() {
  const { login, authenticating: busy, phase, error } = useLogin()

  return (
    <div>
      <button onClick={() => void login()} disabled={busy}>
        {busy ? 'Connecting your wallet...' : 'Login with wallet'}
      </button>
      {busy && phase && <p>{phase}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
```

### 5. Reading and writing

```tsx
import { uuidv7 } from 'uuidv7'
import { useNotes } from './stores.js'

export function Notes() {
  const notes = useNotes(state => [...state.byId.values()])
  const insert = useNotes(state => state.insert)

  async function addNote() {
    await insert({
      id: uuidv7(),
      title: 'Untitled',
      body: '',
      createdAt: new Date().toISOString()
    })
  }

  return (
    <div>
      <button onClick={() => void addNote()}>Add note</button>
      <ul>
        {notes.map(note => (
          <li key={note.id}>{note.title}</li>
        ))}
      </ul>
    </div>
  )
}
```

Entity payloads carry `updatedAt` and `writerId`, the last-write-wins pair that
settles concurrent multi-client edits of the same entity -- but stamping them is
the library's job, not yours: `insert`, `update`, and `upsert` stamp a fresh
pair on every write, overwriting anything the caller supplied, so a payload can
never reach the replica unstamped. Keep the two fields in your payload type (the
stored rows carry them), and simply omit them at the call site.

`useSession().writerId` exposes the resolved id for display or debugging;
outside React, `getWriterId({ storageKeyPrefix })` resolves it under the same
prefix your config declares. Neither is needed to write.

The same id is declared to the server on every push as the `Writer-Id` header,
so the host can tell this install's writes apart from another install of the
same app under the same grant. Set `sync: { declareWriterId: false }` to keep it
off the wire; the payload stamp still carries it for LWW.

A collection can additionally answer server-side equality queries, on either
visibility. Declare the queryable content attributes in the collection config:

```ts
{ key: 'posts', id: 'microblog-posts', visibility: 'public',
  indexes: ['author', 'inReplyTo'] }
```

The sync bootstrap announces the declaration (the server rejects filters on
undeclared attributes fail-closed), and the entity store's `query` verb runs the
query:

```ts
const page = await usePosts.getState().query({
  equals: { author: 'did:key:z6Mk...' }
})
// page.docs: the matching payloads
// page.hasMore / page.cursor: pass cursor back in to fetch the next page
```

`query` is a read verb against the server (signed with the granted collection
capability, so it needs a wallet-connected session), not a sync path: it never
touches the in-memory Map. Multiple `equals` attributes AND together; values are
string equality only.

On a public collection the declaration goes into the collection description, and
on the wire the query is the collection list endpoint's cacheable
`filter[attr]=value` GET form. Filter attributes are emitted in sorted order, so
identical queries produce identical URLs. The same URL also answers anonymously
for non-app consumers.

#### Queries on a private collection

A private collection answers the same `query` call through the blinded-index
query profile. Two things have to be true. Declare `indexes` on the collection
as above, and provision the collection with a blinded-index key. That key
installs with the collection's first key epoch or never, so the choice belongs
to whoever provisions the collection -- the wallet in production. In dev, ask
the provisioner for it:

```ts
await provisionDevGrants({
  baseServerUrl: 'http://localhost:3002/',
  seed: mySeedBytes,
  collections: [{ id: 'notes', visibility: 'private', blindedIndex: true }]
})
```

The sync bootstrap then declares the attributes in the collection's own
encrypted metadata, so every recipient of the collection discovers what is
queryable without out-of-band coordination. Only attributes not already declared
are written, so a returning session declares nothing. A collection provisioned
without the key is warned about and keeps replicating in full; only its queries
are unavailable.

The bootstrap also installs that persisted schema on the collection's own
document cipher, so documents this app writes carry the same blinded index
entries as a write through `@interop/pws-client`'s `Collection.add` -- a
document created or edited here is findable by an equality query, on this client
and on every other recipient.

On the wire, attribute names and values are blinded in the browser with the
collection's blinding key before the request is sent. The server matches opaque
tokens and never sees the names or the values, and the returned envelopes are
decrypted locally.

One limitation to plan around: index entries are stamped at write time, so they
are prospective. A document written before its attribute was declared -- or
before the sync bootstrap installed the schema, which covers anything written
offline before the first connect, including data carried in by the login-time
adoption merge -- carries no blinded entry and stays unfindable until it is
rewritten.

### Share links (publish-copy)

A public collection also gives every document a stable, world-readable resource
URL, which is the basis for share links. The pattern is publish-copy: declare
one public collection for shared documents,

```ts
{ key: 'sharedNotes', id: 'shared-notes', visibility: 'public' }
```

to share a document, copy it into that store, and the share URL is that copy's
resource URL:

```ts
import { publicUrlFor } from '@interop/pws-react'
import { useSharedNotes } from './stores.js'

// Share: copy the doc into the public collection.
await useSharedNotes.getState().insert(doc)
const url = publicUrlFor({ collectionKey: 'sharedNotes', id: doc.id })

// Unshare: remove the copy; replication pushes the delete and the URL stops
// resolving.
await useSharedNotes.getState().remove(doc.id)
```

The URL is stable across edits because a public collection stores the payload
under its own logical uuid. Whether a share is a copy (which survives later
unsharing edits of the original) or a move is an app product decision;
content-addressed ids (hashing immutable content so identical content shares one
URL) are likewise an app-level choice.

Anyone on the web can read the URL -- there is no auth. A consumer can fetch it
with `PwsClient.publicRead` from `@interop/pws-client` or a plain GET. The URL
resolves only after the document has synced to the server (a locally-inserted
doc shares after the next sync push). Expiring or time-boxed share links are not
supported: sharing IS public-collection membership, so a share lasts until the
copy is removed.

The MUI entry supplies a router gate and status UI on top of this; see
[Entry points](#entry-points).

## Login flow

Login is a single CHAPI exchange -- App Connect. The `useLogin().login()` action
(backed by `loginWithWallet`) runs the flow, with a `phase` string surfaced for
a progress line (`connecting` to `verifying`):

1. **CHAPI polyfill loads lazily.** The `credential-handler-polyfill` is loaded
   on demand the first time a wallet request is made, not at import time.
2. **One popup.** A VPR carrying a `DIDAuthentication` query plus one
   `AppConnectQuery` -- the app's display name and canonical `appUrl`, a
   `capabilityQuery` entry per configured collection, and a
   `https://w3id.org/byoe#shared-wallet-collection` entry per shared collection
   -- is sent via `navigator.credentials.get` (`buildAppConnectVpr`). A `null`
   response is a user cancel (`LoginCancelledError`), not an error.
3. **The wallet matches or mints.** On a first run the wallet generates the
   32-byte seed itself, self-issues the origin-bound app-key credential, and
   stores it in its own credential store under the same consent; on a returning
   visit it matches the stored credential by the shared `AppKeyCredential`
   marker type, the `credentialSubject.appUrl` claim, the requesting origin, and
   the seed-to-subject binding. The app never mints, and there is no second
   popup.
4. **Verify the response.** `verifyLoginPresentation` checks the VP and embedded
   proofs (purpose `authentication`, matching domain and challenge). A
   presentation that verifies but carries no seed credential means the wallet
   predates App Connect: the flow fails closed with `WalletUnsupportedError`
   rather than degrading into a partial generic flow.
5. **Recover the seed.** `parseSeedCredential` verifies the returned credential
   carries the `AppKeyCredential` marker type and is self-issued, origin-bound,
   and seed-to-DID bound, then recovers the seed.
6. **Derive identity.** The stable `did:key` controller and its signer are
   derived deterministically from the seed via `CapabilityAgent.fromSeed`
   (`deriveIdentity`). The same seed yields the same identity on every device.
7. **Check grants.** The delegated zcaps ride in the same presentation's
   top-level `zcap` array. `checkGrants` asserts every zcap is controlled by the
   app DID, shares one space on a single PWS host, covers each configured
   collection's required actions, and is unexpired. A declined shared-collection
   grant never fails the login. The wallet decides where the user's Space lives;
   the sync layer derives its target from the grants. The wallet-provided
   `appConnect: { firstRun }` member surfaces as the `{ firstRun }` the
   `login()` promise resolves with.
8. **Activate.** The session (seed, grants, earliest expiry) is persisted to
   IndexedDB, the encrypted local store is opened, the entity stores hydrate,
   and background PWS sync starts.

## Session lifecycle

The session is owned by a zustand auth store built once per app by the provider
(`createAuthStore`). Its `status` is `boot` to `local` / `connected` /
`reconnect`, and it is the router gate: a protected route waits for the restore
attempt to settle before choosing between the app and the login page. A login in
flight is NOT a status -- it is the `phase` field, which `useSession()` /
`useLogin()` also surface as the derived boolean `authenticating`.

- **Restore (zero popups).** On mount, `boot()` reads the persisted session from
  IndexedDB and, if present and consistent, re-derives the identity, opens the
  local store, hydrates, and starts sync with no wallet interaction. A record
  whose grants have expired opens the same store but starts no sync and lands
  `reconnect`. A missing or corrupt record falls through to `local`.
- **Login.** `useLogin().login()` runs the full [login flow](#login-flow).
- **Reconnect.** Grants are expiry-only. The store watches the earliest grant
  expiry and, once within the warning window (`expiry.warningMs`, default 1h) or
  after a live 401/403, moves the status to `reconnect` (which `useReconnect()`
  surfaces as the derived `accessExpired`). `useReconnect().reconnect()`
  re-requests grants with the existing seed (one wallet popup, same identity,
  same data) and restarts sync.
- **Logout.** `useLogout()` stops sync, closes and forgets the local store,
  clears the entity stores, and clears the persisted session.
- **Expiry.** Because the seed survives grant expiry and the derived DID and
  vault keys are stable, an expired session re-grants in place; previously
  stored data stays readable.

Hooks:

| Hook              | Returns                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `useSession()`    | `status`, `phase`, `authenticating`, `error`, `controllerDid`, `expires`, `accessExpired`, `reconnecting` |
| `useLogin()`      | `{ login, authenticating, status, phase, error }`                                                         |
| `useLogout()`     | `() => Promise<void>`                                                                                     |
| `useReconnect()`  | `{ accessExpired, reconnecting, reconnect }`                                                              |
| `useSyncStatus()` | `{ state, label, title }` (see below)                                                                     |
| `useAppReady()`   | `{ ready, error }` -- the hydration gate                                                                  |
| `useAuthStore()`  | the bound vanilla store (for `getState().restore()`, etc.)                                                |

## Sync architecture

- **Local-first replica.** An always-on local encrypted RxDB (Dexie/IndexedDB)
  database (`LocalStore`) holds one collection per app collection. Every at-rest
  row is `{ id, updatedAt, data }`, where `data` is an EDV envelope
  `{ id, sequence, jwe }`. The app reads exclusively from the in-memory entity
  stores hydrated from this replica, so it works fully offline.
- **Envelope encryption.** Every private collection is encrypted with the app's
  identity X25519 key-agreement key -- the twin of its `did:key` controller,
  derived once per session and shared by all of them, which is also the key a
  wallet writes into a roster when it shares one of its OWN collections. One key
  therefore reads everything this app touches (earlier versions derived a
  separate HKDF key per collection; see "One key identity" in ARCHITECTURE.md
  for why that separation was given up). The PWS server never sees plaintext. A
  collection declared `visibility: 'public'` opts out entirely: payloads are
  stored plaintext (no key, no envelope) behind the same storage seam. A SHARED
  (wallet-owned) collection is outside the replica: it never replicates and has
  no local rows, and its envelopes are decrypted on demand with that same
  identity key through the collection's key-epoch roster.
- **Replication.** A per-session `SyncController` runs RxDB replication per
  collection over a sync port (signed requests authorized by the granted zcaps).
  Pull is driven by the PWS `changes` feed; a low-frequency periodic re-sync
  (`sync.pollMs`, default 15s) keeps open sessions converging.
- **Conflict resolution.** Last-writer-wins on the payload's own
  `(updatedAt, writerId)` (ISO lexical compare, with a per-install random
  `writerId` tiebreaker). Updates re-encrypt in place under the same envelope id
  with `sequence`+1 (a mutable-head model); deletes are soft-delete tombstones.
- **Status.** `useSyncStatus()` rolls the per-collection replication states up
  to an aggregate: `offline` (no replication running / local-only), or
  `error > syncing > synced`. The `SyncStatusChip` MUI component renders it. The
  underlying per-session status store (`storageContext.syncStatus` on the auth
  store's state) keys its `statuses` map by the registry's logical collection
  `key`, like every other layer (two entries may share one PWS collection `id`,
  so the id is not a unique status key).

## Entry points

The package exposes three entry points. `./mui` and `./dev` are never
re-exported from the root, so an app that does not use them pays no dependency
cost.

| Import                   | Contents                                                                             | Extra peers                                            |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `@interop/pws-react`     | Core: config, identity, auth, sync, storage, session store, React provider and hooks | `react`, `zustand`; `rxdb` to keep a local replica     |
| `@interop/pws-react/mui` | Optional `ProtectedRoute`, `ReconnectBanner`, `SyncStatusChip`                       | `@mui/material`, `@mui/icons-material`, `react-router` |
| `@interop/pws-react/dev` | Node-only `provisionDevGrants`                                                       | (none; Node only)                                      |

MUI usage:

```tsx
import { Routes, Route } from 'react-router'
import {
  ProtectedRoute,
  ReconnectBanner,
  SyncStatusChip
} from '@interop/pws-react/mui'
import { LoginPage } from './LoginPage.js'

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute loginPath="/login" />}>
        <Route
          path="/"
          element={
            <>
              <SyncStatusChip />
              <ReconnectBanner />
              <Notes />
            </>
          }
        />
      </Route>
    </Routes>
  )
}
```

`ProtectedRoute` calls `restore()` on mount, shows a spinner while the session
restores and the stores hydrate, redirects an unauthenticated visitor to
`loginPath`, and renders the routed `<Outlet />` once ready.

## Logging

The package logs through a structural `Logger` port (four two-arg methods:
`debug`, `info`, `warn`, `error`, each taking a static message and an optional
`data` object, with `data.err` reserved for an Error). An app that never wires
one gets a console fallback prefixed `[pws-react]`. To route the package's
events into the app's own sinks, install a logger once at bootstrap:

```ts
import { createLogger } from '@interop/logger'
import { setLogger } from '@interop/pws-react'

setLogger(createLogger('pr'))
```

`setLogger` returns the previously installed logger, so a test can restore it in
`afterEach`. `@interop/logger` is not a dependency of this package; any object
with the four methods works. The call also installs the logger into
`@interop/pws-sync`, the replication driver this package runs on, so the
driver's diagnostics arrive under the same namespace.

## Dev tooling

The `./dev` entry provisions a Space, collections, and delegated read/write
grants against a running web-spaces-server, so an app can dev-sync without a
CHAPI wallet in the loop. It is Node-only (uses `node:fs`).

```ts
import { provisionDevGrants } from '@interop/pws-react/dev'

const result = await provisionDevGrants({
  baseServerUrl: 'http://localhost:3002/',
  seed: mySeedBytes,
  collections: ['notes'],
  outFile: './public/dev-grants.local.json'
})
// result.grants, result.spaceId, result.spaceUrl, result.appDid
```

A throwaway "provisioner" identity owns the created Space, as a did:webvh whose
account log is published in the Space's `id` collection (a genuine
cross-identity delegation, as in the real wallet-to-requester flow), every
private collection is log-governed from its first epoch, and a per-collection RW
zcap is delegated to the app DID derived from `seed`. The grants live seven days
(`DEV_GRANT_TTL_MS`); the `expires` option of the `provisionDevGrants` call sets
another lifetime (the example CLI exposes no flag for it). The server URL must
be one did:webvh accepts: `https://`, or `http://` on the literal host
`localhost`. Pass `--probe` (or `probe: true`) to check whether the delegated
zcap authorizes PUTting the Collection Metadata object.

## Testing

The repo runs three test tiers:

```
pnpm run test:node       # Vitest unit tests (test/node/), Node
pnpm run test:browser    # Playwright tests (test/browser/), real Chromium
pnpm test                # fix + lint + typecheck + node + browser
```

`pnpm run test:coverage` runs the Vitest suite with V8 coverage. The Playwright
tier runs against a Vite dev server that serves and transforms the TypeScript
source on the fly; there is no standalone browser app.

## Contribute

PRs accepted. If editing the Readme, please conform to the
[standard-readme](https://github.com/RichardLitt/standard-readme) specification.

See:

- [ARCHITECTURE.md](ARCHITECTURE.md) -- the directory map and the Login With
  Wallet (App Connect) protocol.
- [CONTRIBUTING.md](CONTRIBUTING.md) -- editor setup and code style conventions.

## License

[MIT License](LICENSE.md) © 2026 Interop Alliance. </content> </invoke>
