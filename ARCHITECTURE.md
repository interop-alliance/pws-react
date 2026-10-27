# Architecture

How `@interop/was-react` is laid out: the session state machine, how Login With
Wallet works, the storage and sync layers, and the app-facing facades. For
contribution conventions see [CONTRIBUTING.md](CONTRIBUTING.md); for
agent-facing rules (toolchain, tests, repo-specific dos and don'ts) see
[AGENTS.md](AGENTS.md).

## Directory map

- `src/config.ts` -- the central `WasAppConfig` + `StoreRegistry` contract: the
  app identity (`appName`, `appOrigin`, `appUrl`), the `{ key, id }` collection
  registry the storage layer routes on, the separate read-only
  `sharedCollections` registry, the `onboarding` knob, the `seedLocal` fixtures
  hook, and the sync/expiry tuning. `validateCollections` and
  `validateSharedCollections` are the fail-closed registry checks the storage
  layer runs before any replica opens.
- `src/grants.ts` -- parses granted zcaps into server URL / space id /
  per-collection routing (`ParsedGrants`), over was-client's own
  `parseSpaceTarget`.
- `src/identity/` -- seed-derived agents (`deriveIdentity`, which enforces the
  32-byte seed rule and yields the identity key-agreement key every encrypted
  collection is read with), the app-key credential (issue/locate/parse), seed
  and descriptor persistence (`createSeedStore`, `createDescriptorCache`), the
  persisted app-session record, the Space owner resolution (`resolveSpaceOwner`,
  the did:webvh a Space's published account log resolves to), and the JSON-LD
  document loader.
- `src/auth/` -- the requester side of Login With Wallet (App Connect): CHAPI
  wrappers, VPR construction, response verification, and the login/reconnect
  orchestration. The requester (an app, service, or agent) is the party that
  asks a wallet for grants; here it is the app running this library.
- `src/storage/` -- the encrypted `LocalStore`, the session-scoped
  `StorageContext` (`storageContext.ts`: the open replica, the remote store, the
  writer id, the sync status store, and the rehydrate mechanism), the
  active-context pointer and its app-facing facades (`storageManager.ts`), the
  per-install `writerId` binding (`writerId.ts`), generic entity stores, the
  delegated remote store, the read-only `SharedCollectionReader`, the
  replication bootstrap (`wasSync.ts`), the session's encryption-descriptor
  policy (`descriptorManager.ts`), the governed descriptor acquisition
  (`governedDescriptors.ts`), the per-collection document cipher
  (`docCipher.ts`) and the WAS sync port over it (`wasSyncPort.ts`), the sync
  controller binding, sync status, the local-to-connected adoption merge
  (`adopt.ts`), and the public share-URL helper (`publicUrl.ts`).

The replication driver itself is not in this repo. It lives in
`@interop/was-sync`: the changes-feed pull handler, the conditional-write push
handler, the `replicateRxCollection` wiring, the synced-document schema, the
conflict-handler seam, the writer-id mint, and the controller core. Its root
entry carries no `rxdb`; the driver and the controller core are on its `./rxdb`
subpath. What stays here is everything app-shaped: the document cipher and the
key handling around it, the session binding over the controller core, the
Zustand status store, and the browser bindings the core takes as ports.

- `src/session/` -- the session auth store factory (`createAuthStore`): the
  four-state machine described below.
- `src/react/` -- the `WasSessionProvider`, the hooks (`useSession`, `useLogin`,
  `useLogout`, `useClearData`, `useHasLocalData`, `useReconnect`,
  `useSharedCollection`, `useSyncStatus`), and the `defineDocumentApp` facade.
- `src/mui/` -- optional MUI + react-router components (`ProtectedRoute`,
  `ReconnectBanner`, `SyncStatusChip`, and the `LogoutDialog` /
  `ClearDataDialog` / `AdoptDialog` confirmations over `ConfirmDialog`).
- `src/dev/` -- Node-only dev-grant provisioner (`provisionDevGrants`).

## The session state machine

`createAuthStore` (`src/session/authStore.ts`) is a factory rather than a
module-level store: the library cannot bind a store to an app's config, so the
React provider calls it once with the app's `WasAppConfig` and `StoreRegistry`
and shares the returned vanilla zustand store through context. It owns the whole
session lifecycle -- boot, login, the non-CHAPI `connectWithGrants` path,
logout, clear-data, reconnect -- and the open/hydrate/sync ordering.

Four states (`SessionStatus`):

- `boot` -- attempting a zero-popup hot restore. Both successors finish
  open-and-hydrate before this status is left, so "app ready" is exactly
  `status !== 'boot'`.
- `local` -- an encrypted, anonymous-seed replica with no remote. A restore miss
  (or any error during restore) lands here rather than on a dead login screen.
- `connected` -- a wallet-derived identity, parsed grants, running replication.
- `reconnect` -- connected but access expired or revoked; the replica stays
  usable and remote invocations are paused until a re-grant.

### The anonymous local-first replica

`local` is a fully usable product state, not a degraded one. The store mints (or
reloads) a persisted anonymous 32-byte seed in its own IndexedDB database
(`<dbName>-anon`, so it can never collide with a wallet session or a connected
replica), derives an ordinary `IdentityAgents` from it, and opens the same
encrypted `LocalStore` a connected session uses. Epoch-from-birth applies
locally too: with no wallet to provision an encryption descriptor, the app mints
one at the collection's local birth -- a one-epoch roster sealed to the
anonymous identity's key-agreement key alone -- and persists it beside the anon
seed, so a reload decrypts what the previous session sealed. `seedLocal` (an
optional config hook) is called exactly once, only when a brand-new anonymous
replica is created, which is why it never re-runs on reload.

The `onboarding` config knob decides only what the router does with this state:
`'local-first'` renders the app immediately over the anonymous replica
(connecting a wallet is a bonus), `'login-gated'` redirects to the login path
until a wallet is connected. It is read by `ProtectedRoute` and never affects
the store's own transitions -- boot always opens a replica either way. The
default is `'login-gated'`, preserving the historical behavior for apps that do
not opt in.

### Adoption (`adopt: 'merge' | 'leave'`)

Logging in tears the anonymous replica down and opens the connected replica
under the wallet-derived seed. Both keys derive from different seeds, so
envelopes are not portable between the two replicas: adoption is necessarily a
decrypt-and-re-encrypt copy (`src/storage/adopt.ts`).

`adopt: 'merge'` (the default for `login` and for `connectWithGrants`) first
detaches the anonymous replica, then re-derives its identity from the persisted
seed and collects the decrypted payloads through a fresh store handle -- the
ordering is load-bearing: holding the live store and the collect handle at once
would double the open-collection count and trip RxDB's process-wide cap. The
payloads are LWW-merged into the connected replica before its first hydrate and
before sync starts -- so they enter the entity stores by ordinary hydration and
reach the server as ordinary creates -- and the anonymous replica is discarded
once the activation lands: its database first, through the wipe executor at a
one-name grade, and its seed last, only when the removal reported no failure.
The database is named through the seed, so a seed cleared ahead of a failed
removal would orphan it; kept, it re-opens as the next `local` replica and a
later merge login collects it again. The merge policy is per logical uuid and
deterministic: insert when the connected replica holds nothing under that uuid;
otherwise replace only when the adopted payload wins the same
`remotePayloadWins` last-write-wins rule replication runs (owned by
`@interop/social-core`, so every wallet and app converges on one rule), with a
connected doc carrying no LWW fields always losing to a stamped adopted one.
Adopted payloads missing `updatedAt` / `writerId` are stamped at adoption time
with the session's resolved `writerId` (the storage context's, the same value
the write verbs stamp from), so the repair carries the same attribution identity
as the app's own writes; payloads that already carry them keep their original
values. That preserve-if-present rule is deliberately unlike the write verbs'
fresh-always one: adoption repairs an edit already made, rather than recording a
new one.

`adopt: 'leave'` sets the anonymous replica aside untouched instead; it returns
after a logout. A cancelled or failed login leaves `local` intact either way.
`hasLocalData()` is the check a login screen runs to decide whether to offer the
choice at all (`AdoptDialog` is the shipped affordance).

`logout({ wipe })` returns to a fresh `local`, optionally deleting the connected
replica's database. It clears the persisted session record before the anonymous
replica re-opens, so a re-open that fails (an anonymous replica whose stored
schema hash no longer matches after an upgrade) never leaves the wallet seed on
disk for a reload to hot-restore. A failed re-open, there or in a connected
activation's fallback, still lands `local`, with no replica attached and the
failure on `error`, rather than keeping a status that names a session whose
replica is gone; a boot-time failure keeps `boot` with `error`, the fatal state
`ProtectedRoute` reads. `clearLocalData()` deletes every database this app wrote
here, mints a brand-new anonymous seed and replica, and drops any persisted
connected session, so clearing while connected fully disconnects (both grades
are enumerated below). `destroy()` tears the live replica down without wiping
the persisted session record, and boot/destroy are serialized through one
promise chain so a React dev-mode remount cannot race two bring-up or teardown
sequences.

### Logout and clear-data wipes

`logout({ wipe })` and `clearLocalData()` share one wipe module
(`src/session/localWipe.ts`), enumerated at two grades:

- Logout, keep data (the default): nothing is removed.
- Logout, erase data (`logout({ wipe: true })`): the connected replica and the
  session store are deleted by name. RxDB's own removal clears each collection's
  table but leaves its IndexedDB database standing, so the wipe deletes those
  shells too. The anonymous replica and the writer id deliberately survive: a
  local-first app keeps working logged out.
- Clear data (`clearLocalData()`): everything this library ever wrote on the
  browser -- both replicas, both seed stores, and the writer id -- leaving the
  browser as it was before first run. On top of the named targets it runs a
  prefix sweep, which also reaps anonymous replicas that earlier versions of
  this library orphaned on the same browser.

The module rests on three rules. Snapshot every target from live state before
deleting anything: the anonymous DID is re-derived from its seed while that seed
still exists, because a name derived after the seed is discarded can never be
reached again. Delete by known name, computed through `dbNameForController`,
rather than relying on enumeration. Treat `indexedDB.databases()` as discovery
and verification, not as the deletion gate, since some engines do not implement
it; what a wipe could not confirm removed is reported on its `unverified` list
rather than counted toward a result that reads clean.

`clearLocalData()` resolves with that report (`LocalWipeReport`), and
`useClearData()` passes it through unchanged.

### The storage context

Everything a session's storage layer shares across its async consumers lives on
one `StorageContext` (`src/storage/storageContext.ts`), created by
`createAuthStore` beside the session store and exposed as
`useAuthStore().getState().storageContext`: the open `LocalStore` replica, the
connected session's `WasRemoteStore`, the resolved `writerId`, the sync status
store, and the debounced re-hydrate timers. The auth store attaches and detaches
the replica, the sync controller reports into the context's status store, and
the per-doc change patches run on it. Nothing in the library reaches for a
module global to find any of these.

Staleness is one mechanism. Every attach and detach bumps the context's
generation, and `whileAttached(op)` runs an async operation against the replica
attached at its start and reports the result only if that same replica is still
attached when the operation settles. A replica detached or swapped meanwhile
turns the result into `undefined`, and a rejection raised after the swap is
swallowed with it, since a read torn by its own teardown is expected noise. The
per-doc change patch (`patchFromChange`, which decrypts an envelope floating off
the RxDB change stream), the scheduled re-hydrates (timers bound to the
generation that scheduled them, and cancelled wholesale on detach), and the
`hasLocalData` probe (which runs off the serialized lifecycle chain) all rest on
it; none carries a guard of its own.

One process-wide pointer remains, deliberately: the active context
(`src/storage/storageManager.ts`). Entity stores are created at module level,
before any session exists, so their verbs cannot hold a context of their own;
they and the other app-facing facades (`requireStore`, `requireRemoteStore`,
`stampLww`, `requireWriterId`, `publicUrlFor`) resolve the active context on
every call. Activation is fail-loud about two live sessions: the auth store
claims the pointer right before it opens a replica, and the claim throws while a
different context still has a replica attached, so a second provider in one
process fails its boot (with no half-opened database left behind) instead of
silently taking the facades over. `createAuthStore` also claims the pointer at
creation, so the facades resolve before any replica opens, but that early claim
is skipped rather than refused while another session is live: a keyed provider
remount runs the new provider's `useState` initializer before the old provider's
cleanup has torn its session down, and a throw there would be a throw inside a
React render. A context without a replica (created but not booted, or torn down)
is inert and is replaced without complaint, which is what a React dev-mode
double `useState` initializer needs. The pointer is also released, not just left
inert, whenever a session detaches its replica (`destroy`, logout, clear-data,
the connected activation's fallback to `local`): from that moment until the next
`openAndHydrate` claims, the facades throw rather than resolve a retired
session. That closes the keyed-remount window, where the new store had skipped
its creation-time claim and the old context would otherwise have kept answering
the entity-store verbs after its own teardown.

The one detach that keeps the pointer is the connect transition's replica swap
(`StorageContext.beginSwap` / `endSwap`, opened by `completeConnect`). The
session is not retiring, it is trading its anonymous replica for the connected
one, and an app write that arrives in between (a click landing while
`connectWithGrants` runs at mount) must not reject. The entity-store write verbs
resolve their replica through `awaitStore`, which waits for the swap to end: the
swap ends after the new replica is attached, merged, and hydrated, so the queued
write lands in the connected replica and after the adoption merge (or in the
re-opened anonymous replica when the activation failed). The activation's
network half (owner log, collection logs, descriptor reads) runs before the swap
opens, so the swap holds only local work. Library-driven reads (`hydrate`) stay
on `requireStore`: they run inside the swap and must not wait on it.

Only a merge that carries anonymous data over opens a swap: `adopt: 'merge'`
from `local`, the one case the adoption collect returns anything for. Under
`adopt: 'leave'` the anonymous data is set aside, and a write composed against
it must not follow it over: an update of a set-aside document would find no
envelope in the connected replica and be resurrected there as a create. A login
from `reconnect` collects nothing either, and a write composed against the
expired account's replica must not be written into the newly connected account's
as a create. A write that arrives mid-transition in either case rejects, as
every such write did before the swap existed.

The swap is serialized with the rest of the lifecycle. `login` keeps its wallet
popup await off the lifecycle chain, but its connect epilogue (the swap) rides
the chain once the popup has answered, so a `destroy` or a `connectWithGrants`
queued meanwhile runs to completion first rather than tearing the swap apart.
`connectWithGrants` is a no-op while a Login With Wallet flow is in flight
(`phase` is non-null), for the mirror case.

The epilogue also checks that the session it left is still the live one, by
comparing the live `status` and `controllerDid` to the pre-login snapshot. The
StrictMode destroy/boot pair re-opens the same session and passes. A bare
`destroy`, a `clearLocalData`, a `connectWithGrants`, or a boot that restored a
different session fails it. The epilogue then bails with a warning, clears
`phase`, and `login` resolves `null`, leaving whatever session the change
produced as it is. Otherwise it would bring a connected session up with nothing
left to tear it down, or on top of a session the login never started from.
Teardown is best-effort (a sync-controller stop that throws is logged and the
rest runs), and `destroy` resets the session state even if it throws, so a
failed destroy cannot leave the old session readable to this check.

`reconnect` follows the same split. Its re-grant popup await is off the chain,
and its epilogue (stopping the controller, persisting the renewed record,
restarting sync, the `connected` transition) rides it. The epilogue re-checks
the session first and bails with a warning unless the status is still
`reconnect` for the same `controllerDid` it started with. A logout, clear-data,
or destroy that completed while the popup was open therefore stands: the record
is not written back over it, no sync starts over the replica attached by then,
and no expiry watch is armed on a torn-down store.

### `writerId`

The per-install LWW attribution label, resolved once at store creation from
`WasAppConfig.storageKeyPrefix` and exposed as `useSession().writerId`. It is an
unkeyed, clearable, unrecoverable stamp whose only jobs are attribution and
breaking last-write-wins ties -- never an identity. (The keyed client identity
of an (app, user) pair is the app-key credential's subject DID.) Where
`localStorage` cannot answer, `getWriterId` mints a fresh id per call and
remembers nothing: a shared module-level fallback would stamp one label into two
accounts' histories in the same tab.

The mint is `@interop/was-sync`'s, which takes the key prefix and the storage as
required inputs. `src/storage/writerId.ts` is the browser binding that supplies
`DEFAULT_STORAGE_KEY_PREFIX` and `localStorage`, so `getWriterId` and
`clearPersistedWriterId` keep their names and their optional-prefix signature.

Stamping is the library's job, not the app's. The resolved id lives on the
session's `StorageContext` (constructed with it at store creation, before any
replica opens), and `StorageContext.stampLww` -- the one place a payload's
`updatedAt` / `writerId` are minted -- reads it from there. The `stampLww` and
`requireWriterId` facades resolve the active context and throw when there is
none, rather than falling back to a default-prefix resolution that would stamp a
second id. The entity store's persisted write verbs (`insert`, `update`,
`upsert`) call it on every write, always fresh and always overwriting whatever
the caller passed: a fill-if-missing rule would let a hydrated doc's stale
`updatedAt` ride a later edit and lose the conflict. `useSession().writerId` is
therefore a display and debugging affordance; nothing an app writes depends on
reading it. `LocalStore`'s own verbs do NOT stamp -- they are the raw layer the
adoption merge and the sync path write through, both of which own their stamping
rules.

The same label also travels on the wire. The session's `SyncController` hands
`StorageContext.writerId` to the was-sync core as its writer-attribution label,
so every push declares it as the `Writer-Id` header. The pull side does not read
the label: the pull handler decrypts nothing, so an echo of the replica's own
write has no decrypt to skip. No second label is minted: the payload's LWW stamp
and the header are two carriers of one value. The host learns from it how many
installs of an app write for a user, which is the trade the WAS spec's
writer-attribution section accepts and keeps optional.
`sync.declareWriterId: false` withholds the wire carrier: pushes declare no
label (which clears any the server held, under its declare-or-clear rule), while
the payload stamping is unchanged.

## Login With Wallet: the App Connect protocol

Login is a single CHAPI `get`. `buildAppConnectVpr` emits a verifiable
presentation request carrying a `DIDAuthentication` query plus exactly one
`AppConnectQuery`:

- `app: { name, appUrl }` -- `name` is `appName` from `WasAppConfig`, display
  metadata for the wallet's consent surface and never evidence of who is asking;
  `appUrl` is the application's canonical URL, which identifies it among the
  applications served from its origin. It must parse as an absolute URL, must
  carry no fragment, and its origin must equal the attested requesting origin;
  the value emitted is the parsed URL's serialization (`serializedAppUrl` from
  `@interop/wallet-request`), so spellings differing only in a default port, in
  percent-encoding case, or in dot-segments do not name distinct applications.
- `capabilityQuery` -- one collection-scoped entry per requested collection:
  `invocationTarget` (an invocation target descriptor), `allowedAction`
  (non-empty), and `referenceId`. The entries carry no `controller` (the wallet
  fills it with the app-key subject DID; a public client cannot know a returning
  user's DID in advance, and dropping it is what collapses the flow to one
  round) and no `reason` (the App Connect consent surface supersedes per-grant
  reason strings).

The protocol's normative definition is the App Connect companion spec
(<https://github.com/interop-alliance/app-connect-spec>; local checkout
`../app-connect-spec` -- read `spec.md` there rather than fetching the rendered
version): the `AppConnectQuery`, the app-key credential and its binding rules,
the descriptor vocabulary with its allowed-actions table, and the response
presentation this library verifies.

`domain` is this app's own live browser origin -- the origin the CHAPI mediator
attests to the wallet -- and the `challenge` is a fresh, unpredictable nonce per
request, retained for the response check. `liveOrigin` reads
`window.location.origin` rather than trusting configuration: a configured
`appOrigin` differing from the live origin is warned about and is never used as
the bind. That one string is what the request sends as `domain`, what the
`appUrl` is validated against, and what the returned credential's `origin` claim
is checked against.

### The app-key credential

The wallet finds -- or on first run mints, wallet-side -- the app-key credential
for this (origin, `appUrl`) pair, delegates the requested capabilities to its
subject DID, and answers with one signed presentation: the credential in
`verifiableCredential`, the grants in the top-level `zcap` array, and a
wallet-provided `appConnect: { firstRun }` member, all added before signing so
the authentication proof covers them.

The credential's vocabulary is fixed and shared by every application:

- `type` is the two-entry array `["VerifiableCredential", "AppKeyCredential"]`,
  in that order (`APP_KEY_TYPE_ARRAY`). Nothing in it is application-scoped.
- `@context` begins with the VC 1.0 context and the hosted App Connect profile
  context `https://w3id.org/byoe/app-connect/v1`, which defines the credential's
  terms as well as the presentation's `zcap` and `appConnect` members. It is
  registered as a static context by `createDocumentLoader` (out of
  `byoe-context`), so verification still needs no network fetch; the signature
  suite appends its own third entry when the credential is signed.
- `credentialSubject` carries `id`, `seed` (32 bytes, base64url without
  padding), `appUrl`, and `origin`. `issuer` equals `credentialSubject.id`, and
  both equal the did:key derived from the embedded seed.

App identity is therefore scoped to the triple (user, origin, `appUrl`): the
same application at two URLs on one origin is two identities, and one URL can
carry only one.

`issueSeedCredential({ seed, origin, appUrl, appName, documentLoader })`
self-issues that credential (for app-side or test self-issuance; the wallet
mints it in production). It is a thin wrapper over wallet-request's
`issueAppKeyCredential`, the same issuer the wallet mints with, so the
credential's shape is maintained in one place; the wrapper enforces the 32-byte
seed rule, injects this library's document loader, and returns the bare
credential rather than wallet-request's `{ credential, subjectDid }` pair. The
exported names `issueSeedCredential`, `parseSeedCredential`, and
`findSeedCredential` predate the spec's term for the artifact -- read "seed
credential" in an identifier as the spec's app-key credential.

Historical note (pre-0.13 code and data only, nothing here acts on it): before
the `appUrl` profile the request's `app` block carried `credentialType` and
`vocabBase`, the credential's type array carried a third per-app entry, and its
`@context` was an inline term object interpolated from `vocabBase`. None of that
is emitted, accepted, or configurable any more, and `SeedCredentialConfig` is
gone. Recovering such a credential -- re-issuing it in place under the same
seed, since a fresh mint would roll the seed and orphan the identity the app
encrypted its data under -- is wallet-side work in `@interop/wallet-core`, not
this library's.

### Verifying the response

`loginWithWallet` runs the spec's application-side verification in order,
aborting on the first failure:

1. `verifyLoginPresentation` verifies the presentation proof and every embedded
   credential proof through `@interop/verifier-core`, with `registries: []` --
   issuer-registry lookup must not be required, since the app-key credential is
   self-issued by design.
2. The same call makes the proof checks verifier-core does not: every
   presentation-level proof has `proofPurpose` of `authentication`, echoes this
   request's fresh challenge, and carries this app's origin as `domain`.
3. `findSeedCredential({ presentation, appUrl })` locates the credential by the
   `credentialSubject.appUrl` claim alone. The `AppKeyCredential` marker type is
   deliberately NOT required at this step: requiring it would make "the wallet
   returned a credential that is wrong" indistinguishable from "the wallet
   returned nothing", and an application that reads absence as first run would
   answer by minting a second key. No such credential means the
   wallet-unsupported outcome (`WalletUnsupportedError`).
4. `parseSeedCredential({ credential, origin, appUrl })` enforces the six parse
   checks, in order: the `type` array includes `AppKeyCredential`;
   `credentialSubject.appUrl` equals the `appUrl` this request sent, as an exact
   string; `issuer` and `credentialSubject.id` are both present and equal;
   `credentialSubject.origin` equals this app's own live origin, as an exact
   string; `credentialSubject.seed` is a non-empty string decoding as
   base64url-no-pad to exactly 32 bytes (fail closed, never truncate or pad);
   and the DID derived from those bytes equals `credentialSubject.id`. The
   derived `IdentityAgents` come back on the result so the login flow does not
   re-derive them.
5. `checkGrants` validates the grants against the connecting DID parsed in step
   4 -- never against a DID taken from the response.

These checks duplicate checks the wallet already made; that is the point. They
are defense in depth over an origin binding and an identity binding this app is
fully able to check itself.

The presentation's holder DID is never checked against anything. It may be any
resolvable DID, including one that is ephemeral and not stable across visits.
Application identity does not depend on it: it is the app-key credential's
subject DID, which the wallet custodies. A reconnect therefore returns the same
subject DID, and so the same derived X25519 recipient key, even for an account
with no durable clients of its own.

The marker type is a self-declaration, not evidence -- a planted credential
controls its own `type` array -- so the seed-to-subject binding is what
authenticates internal consistency, and the wallet's store-time refusal (app-key
credentials are wallet-minted, never imported) is what keeps foreign credentials
out in the first place.

The `login()` outcome contract is `{ firstRun }` / `null` / reject:
`appConnect.firstRun === true` is the only value read as first run (an absent
member, a non-boolean, or `false` all mean returning); a null CHAPI response is
a user cancel (`LoginCancelledError`); a verified presentation with no app-key
credential is `WalletUnsupportedError` (fail closed, "update Freewallet" copy).
`LoginPhase` is `'connecting' | 'verifying'`.

### Grant checks and the skip condition

`checkGrants` enforces that every grant's `controller` is the connecting DID,
that each carries an unexpired `expires`, that each `invocationTarget` is a
single non-empty string parsing under the WAS URL template and naming a
collection (never the Space itself or a reserved sub-endpoint), that the whole
set resolves to one host and one Space, and that every app-owned collection the
app requested is covered with the actions it requires.

`checkGrantsForCollections` (`src/auth/loginFlow.ts`) wraps it with one skip:
when the configured app-owned `collections` list is empty AND the response
carries no grants, `checkGrants` -- which rejects an empty grant set -- is
skipped, and an empty grant set with a far-future expiry and no `parsed`
topology is returned instead. That covers both the app that requests nothing at
all and the shared-only app (`collections: []` plus some `sharedCollections`)
whose user declined every share; the declined shares are warned about, and the
readers are simply not opened. Such a session names no server and no Space, so
the auth store persists no session record for it, resolves no Space owner, and
starts no replication; a reload lands in `local`. Shared collections are never
passed to `checkGrants`: a declined share is not a login failure. They still
reach the routing table through `parseGrants`.

That check is structural. `controller` must equal the app's own DID,
`invocationTarget` must name exactly one collection, and `expires` must be in
the future. Nothing about the delegation chain leading to the grant is
inspected: chain depth, the parent capability, and the delegator's DID form are
deliberately left unchecked. A wallet may root a grant at the Space root or at
an intermediate delegation. Both are valid here. A standing-credential account's
grants, for instance, chain through a generation delegation: the chain is depth
3, and the delegator is a key that never appears in the account document.
Validity at invocation is the storage server's decision, not this library's.

One consequence follows directly: the connected account may have no durable
wallet clients at all. A grant can stop verifying before its stated `expires`,
because the annex generation it chained through was collected. That surfaces as
a 401 or 403, and the session moves to `reconnect`. A collection can also sit on
a key epoch this app cannot open, because no login-time sweep ran to repair it.
A shared collection degrades with a warn-and-skip. An app-owned collection
degrades further: with no epoch roster at all it falls back to a fail-closed
placeholder cipher and only that collection is unusable, but a roster that lists
epochs and excludes this app fails the whole connected activation and lands the
session back in `local` (see "Storage and sync" below). None of these is a raw,
unhandled error.

### Allowed actions

Each request stays within the allowed actions of the descriptor class it uses
(the spec's normative "Allowed actions" table). Both collection classes --
`https://w3id.org/byoe#private-collection` and
`https://w3id.org/byoe#public-collection` -- allow the full vocabulary
`GET, HEAD, POST, PUT, DELETE` (`RW_ACTIONS`, in table order), since published
content is still the application's own data and un-publishing and revision are
data management like any other write. A share is read-only (`SHARED_ACTIONS`,
`GET` and `HEAD`).

The exported helper is named `actionCeiling(visibility)`; read "ceiling" as
local shorthand for the class's allowed-actions row. A configured action set
naming an action outside its class's allowed actions is a configuration error
thrown at request-build time -- a conformant wallet can never grant it, so
letting it ride would surface later as a failed login instead of as the config
bug it is. A request that would end up with no actions is likewise refused,
because an empty `allowedAction` array means every action in the zcap model.

The seed never transits a server: minting happens in the wallet, delivery is the
browser-direct CHAPI channel. Dev mode bypasses the credential entirely rather
than faking one -- `provisionDevGrants` (Node only) builds what a wallet's
account genesis builds, in the same order: a Space created under a throwaway
provisioner client key, that key's did:webvh account log published at the
Space's world-readable `id/did.jsonl`, every private collection's epoch zero (to
the app's identity key-agreement key) installed as the genesis of the
collection's `meta/log` through the log-governed descriptor store, the Space
controller promoted to the did:webvh through wallet-core's own promotion stage
(`ensurePromotedSpaceController`, under the configured Space name, so an
interrupted promotion heals on a re-run), and per-collection zcaps delegated
from the Space root under that DID to the app's controller DID, which
`connectWithGrants({ seed, grants })` then adopts directly. A public collection
is left plaintext. The dev Space therefore passes the same governed-read policy
a wallet's does (see "Storage and sync"). `issueSeedCredential` stays exported
for app-side or test self-issuance; it signs the wallet's own credential shape
by delegating to wallet-request's issuer rather than maintaining a copy of it.

## The three kinds of collection

Three kinds, and the distinctions are load-bearing:

- App-owned private (`collections`, `visibility: 'private'`, the default). The
  app provisions, writes, and replicates it. Encrypted with the app's identity
  X25519 key-agreement key -- the same key a shared collection's roster entry
  names. Requested with the `https://w3id.org/byoe#private-collection`
  descriptor. It can answer equality queries too, over the blinded-index
  profile, when it was provisioned with a blinded-index key.
- App-owned public (`collections`, `visibility: 'public'`). Plaintext and
  world-readable; no key derivation, and the stored resource id IS the payload
  uuid, so a public document has a stable share URL (`publicUrlFor`). Requested
  with `https://w3id.org/byoe#public-collection`. The LWW bookkeeping fields
  (`updatedAt`, `writerId`) are world-readable alongside the content.
- Shared, wallet-owned (`sharedCollections`). One of the WALLET's own encrypted
  collections that the user chooses to let this app read and decrypt. Requested
  with `https://w3id.org/byoe#shared-wallet-collection` and the read-only
  `SHARED_ACTIONS` set. It is read-only by construction: no RxDB collection, no
  local replica, no replication, no writes, and the sync bootstrap's declaration
  writes skip it. Reads go straight to the server through a
  `SharedCollectionReader`, which fetches the stored EDV envelope raw (the
  `encryption: 'plaintext'` handle override) and decrypts it locally.

`SharedCollectionReader.list()` has two paths. The fast one is was-client's
`Collection.documents()` walk over the `changes` feed -- whole pages of
documents with their bodies, undecrypted by the server, which is exactly what a
reader holding its own keys wants, and the same primitive replication pulls
with. It costs one request per page rather than one per resource. The feed
carries every record kind of a Collection; the walk keeps live JSON
`kind: 'resource'` entries only, skipping the Collection's own records
(`collection-metadata`, `log`), any kind it does not know, tombstones
(`deleted`), and resources with no inline `data` (binary or `text/jsonl`), so
the result is the live set of JSON resources. The reader only decrypts what the
walk returns. The fallback, for a backend without the `changes-query` feature
(501, surfaced as `NotImplementedError`), lists the resource summaries and
fetches each body; it warns once per reader that the collection is being read
the slow way.

`validateSharedCollections` rejects a collection declared in both registries: a
collection cannot be app-owned and shared read-only at once.

### One key identity

A share hands the app an entry in the collection's key-epoch roster, and the key
in that entry is the app's identity KAK -- the X25519 (Montgomery) twin of its
`did:key` controller, on `IdentityAgents.keyAgreementKey`. The wallet derives
the same key from the controller DID alone, so the key never travels on the wire
and no request can pair controller DID A with recipient key B.

That is the SAME key the app's own collections are encrypted with. One rule
holds everywhere: an epoch-roster recipient is the X25519 twin of a controller
did:key, whoever owns the collection, and an app derives its key exactly once
per session (`LocalStore.init` takes it, rather than deriving per collection).

Earlier versions ran a second identity for app-owned collections -- a
per-collection KAK, HKDF-derived from the master seed under the collection id
(`deriveCollectionKeys`, label `kak:v1:<collectionId>`). Unifying gives up that
HKDF domain separation: one key now reads every collection the app touches. The
trade is deliberate. A share is also grantable to an arbitrary `did:key` where
no app seed exists at all, so the recipient must be derivable from the
controller DID alone; per-collection keys cannot cover that case, and only the
identity KAK can be the single rule. And the separation bought less than it
appears to: with key epochs the KAK only unwraps an epoch secret rather than
being the content key, and the seed both keys derive from is persisted in the
same process anyway.

### Failing closed, and the honest ceiling

`https://w3id.org/byoe#shared-wallet-collection` is a distinct descriptor type
rather than a flag, for the same reason `#public-collection` is: an unknown type
already resolves to unsatisfiable, so a wallet that predates the feature refuses
visibly. Silently degrading matters more here than elsewhere -- a share fuses
the read zcap with the roster entry, and half a share is ciphertext the app
cannot decrypt, which reads as corrupt data rather than as a wallet needing an
update.

What a share actually covers: every encrypted collection carries a key epoch
from provisioning (epoch zero, wrapped to the wallet owner as recipient zero),
so a share is always an `addRecipient` that escrows this app into every existing
epoch -- no rotation, no lazily created first roster. A new reader therefore
decrypts the collection's contents as they already stand, not only what is
written after the share, which is what the wallet's consent surface states. A
descriptor with no epoch roster at all is refused fail-closed at open
(`SharedCollectionUnavailableError`) rather than seeded here: it can only mean
an unprovisioned or torn collection, and the same error covers a roster this app
is not in (never shared, or access removed -- removal rotates the epoch off this
app's key). Once a session is already open, that same removal surfaces per
envelope as `KeyUnwrapError`: the descriptor lists the epoch, this app just
holds no key for it, so no descriptor refresh is spent on it.

The residue is pre-epoch legacy envelopes: resources sealed as single-recipient
envelopes back when the collection had no epoch roster at all. Nothing
re-encrypts them, so they genuinely do not decrypt for a later reader. They are
skipped with a warning rather than treated as corruption, alongside the other
expected non-results (a body that is not an EDV envelope; an envelope left
unreadable after the reader has spent its one descriptor refresh; an envelope
whose listed epoch this app has no key for, which is what a mid-session revoke
looks like). `IntegrityError` is deliberately not on that list: an envelope
served under a resource id it was not sealed for is the server serving one
document's content under another's URL, so `get()` rethrows it rather than
answering `undefined`, which the caller would read as "not there". A listing
skips it instead, logged at `error` rather than `warn` because it is never
expected: one mis-bound envelope must not make a wallet-owned collection this
app can neither repair nor route around unlistable. Every other failure -- no
covering grant, no identity key supplied, not a recipient -- degrades one reader
with a warning and never the session.

The other standing limit is the one the wallet states too: removing access stops
future reads but cannot take back what has already been read.

### Audiences: `AudienceReader`

An audience is a fourth kind of collection from the reader's side, and it gets a
reader of its own (`src/storage/audienceReader.ts`). It is one plaintext
collection in another owner's Space, and membership is a GET and HEAD zcap on
that collection's container. A subscriber holds one `AudienceReader` per
audience and merges what the readers return by the app's own stable post id,
which lives in the post body. The resource id is not a stable identity: a post
that changes audience moves.

The reader is not a `SharedCollectionReader`, and the two are deliberately not
one. A shared collection is encrypted, so that reader requires an `encryption`
descriptor and builds a cipher from it; an audience is plaintext. A shared
collection's fast path walks the POST form of the `changes` feed, which a GET
and HEAD grant does not reach; the audience reader reads the read-only GET form.
And a shared collection is resolved through the session's `WasRemoteStore`,
which holds the one server URL and Space the app's own grants name; an audience
lives in another owner's Space, possibly on another host, so
`AudienceReader.open({ zcap, signer })` takes the zcap directly and builds its
client from the zcap's own `invocationTarget` (was-client's
`parseAbsoluteSpaceTarget` reads the base URL off it, everything before the
`space` segment, so a WAS mounted under a sub-path works). The zcap arrives from
the subscription agent's own API, not in a wallet presentation, which is why
`parseGrants` and `verifyResponse` know nothing about it.

`pull()` follows the feed from the reader's checkpoint to the end, through
was-client's `resourceChanges` walk, which drops every entry whose `kind` is not
`resource`, follows a page the filter empties, ends only on a `null` checkpoint,
and fails on a checkpoint the server repeats. A live JSON resource's body rides
the feed inline and is returned as is; a tombstone is returned as
`deleted: true`, and so is a live resource rewritten to a non-JSON type, since
it is no longer a post. The checkpoint (`reader.checkpoint`, accepted back by
`open()` so a subscriber can resume across sessions) moves only together with
the changes a pull returns: a pull that fails for any reason other than a cut
rejects with the checkpoint where it began, so the next pull re-reads what this
one could not deliver, and nothing a consumer persists ever runs ahead of what
it received. Pulls are serialized, since two overlapping walks from one
checkpoint would hand the consumer the same changes twice. A checkpoint the
server refuses (a 400 with one in hand, which is what a retired feed layout
looks like) is dropped and the feed replayed from its start once, reported as a
snapshot. A server that refuses the GET form (405) or has no feed (501) is read
through the listing and one GET per resource instead, once warned about and
remembered for the reader's life. Both of those answer `snapshot: true`: a full
read rather than a delta, where every live post is present and a post the
consumer holds that is absent is gone. A denied read is never a snapshot.

The cut contract is the reader's main design point. A generation replacement or
an annex GC on the owner's side cuts every subscriber child at once, so a denied
invocation is the routine path, not an error. The reader reports `paused`, keeps
its checkpoint (on a cut mid-walk, the last fully read page's, beside the
changes of those pages), answers an empty pull without a request while paused,
and resumes from the checkpoint once `replaceCapability({ zcap })` hands it a
replacement for the same target. A zcap for another target is refused, since the
checkpoint belongs to this collection alone, and so is one that leaves `GET` out
of its `allowedAction`, which could only pause the reader again. A replacement
is accepted on a live reader too (a renewal ahead of expiry); every replacement
bumps a generation, and a denial raised by a request that left under the
previous zcap pauses nothing, so a renewal racing an in-flight pull cannot leave
the reader paused with no further zcap coming. Such a stale denial still cuts
the walk short, so the pull it ends is reported as partial: `snapshot` is
`false` even on a replay or a listing read, since only a read that ran to its
end is a full one.

On the wire a denial is a 401 or 403, or the masked 404 WAS answers an
unauthorized caller with, named `capability-revoked` or `capability-expired`
when the request itself verified and bare when the chain no longer verifies,
which is what a collected generation looks like. All of those pause the reader.
A collection deleted under the reader is the same 404 and pauses it the same
way; it just never resumes. The feed request surfaces that 404 as a typed error,
but was-client's body reads (`get`, `list`) answer `null` on any 404, the masked
denial included, so a null from one of them is ambiguous. A null listing on the
fallback path is unambiguous, since an empty collection lists as empty rather
than null, and is the cut. A null body (from `get()`, or for a resource the
listing just named) is settled by one signed GET of the container through the
`request` escape hatch, which maps the denial to its typed error: a miss stays a
miss, and a denial pauses the reader.

## Storage and sync

`SyncController` (`src/storage/syncController.ts`) is the session binding over
`createSyncController` from `@interop/was-sync/rxdb`. The core owns the
lifecycle -- the serialized start/stop queue, one replication per collection,
the status and auth-error callbacks, the poll timer, and the failed-bring-up
unwind, which flags every collection and rethrows so the caller's bootstrap can
surface it. The binding owns what is app-shaped: the port built from the
session's `WasRemoteStore` and `LocalStore`, the two port flags this deployment
needs (`feedPrimaryRead`, because CORS hides the `GET` ETag cross-origin, and
`mapAuthErrors`, without which `onAuthError` could never fire), the browser
reachability source, the poll interval from `WasSyncConfig`, and the Zustand
status store the statuses are written into. The core delivers both the logical
collection key and the WAS id to `onStatus`; the store is keyed on the logical
key, since two registry entries may share one WAS id. A collection the grant set
does not cover is flagged `error` and kept out of the port entirely, so an
uncovered collection never draws a fail-closed 403 that reads as expired access.
`stop()` is terminal for a core instance, so the binding builds a fresh core
inside `start()` and resets the status store on stop.

`rxdb` is an optional peer, and the root entry stays resolvable without it.
Nothing reachable from `src/index.ts` imports `rxdb` at module evaluation:
`LocalStore` loads `rxdb/plugins/core` and `rxdb/plugins/storage-dexie` inside
`init()` and `removeDatabase()` (the default Dexie storage is loaded only when
the caller supplies none), and `SyncController` loads `@interop/was-sync/rxdb`,
the one was-sync entry that imports `rxdb`, inside `start()`. A replica-less app
(login plus shared-collection reads, no `WasSessionProvider`) therefore installs
without `rxdb`, and an app that replicates adds the peer explicitly; a missing
peer surfaces at the first replica operation with the resolver's own error.
Under Vite a declared optional peer that is not installed resolves to a stub
that throws only when evaluated, which is what makes the lazy site the failure
point rather than the import of this package. The core's `isAuthError` predicate
is not re-exported from the root for the same reason; it is imported from
`@interop/was-sync/rxdb`. The published declarations name no `rxdb` type either,
so that consumer type-checks the root without `skipLibCheck`: the `storage`
injection option (`LocalStore.init`, `removeDatabase`, `createAuthStore`,
`executeLocalWipe`) is typed as `ReplicaStorage`, the structural shape of RxDB's
`RxStorage` the library passes through, narrowed back at the two call sites;
`onRemoteChange` callbacks receive a `ReplicaChange` (`operation` plus
`documentData`, the two members the per-doc patch reads, which every RxDB change
event satisfies); and `LocalStore.rxCollection`, whose type is RxDB's, is
`@internal` and stripped from the declarations (`stripInternal`), staying
available to the sync controller and the tests.

Every replica collection is declared on `@interop/was-sync`'s
`syncedDocSchema()`: a row is `{ id, updatedAt, data }` plus the optional
members the server stamps on it (`updatedAtCounter`, `originId`, the nested
`meta` stamp, `createdBy`, `writerId`, `epoch`, the `etag` / `metaEtag`
validators, and `custom`). The schema is stored state. RxDB refuses to open a
collection whose stored schema hash differs from the declared one, and the
schema ships with no migration strategy, so a replica created under an earlier
shape is not migrated: `clearLocalData()` removes it and the next login re-pulls
from the server.

Each collection's RxDB conflict handler (installed at `addCollections` in
`LocalStore.init`) settles a 412 push conflict by decrypting both sides and
comparing payload `updatedAt` (writer id tiebreak) through was-sync's
`makeLwwConflictHandler`. Its decrypt closure is was-client's own
`DocCipher.decrypt` shape,
`({ id, envelope, context? }) => Promise<Json | Blob>`. was-sync calls it once
per side with that side's own `SyncedDoc.id`, the row's/resource's own stored
id. The closure does not read an id out of the decrypted payload: the server
controls that field, and on a private (random-id) collection it is a different,
logical uuid anyway. The cipher checks the envelope against the id it was given
and raises `IntegrityError` on a mismatch (an envelope sealed for a different
resource than the one it is read under). was-sync keeps that separate from its
undecryptable-side handling: on a private collection the error propagates out of
conflict resolution, and the collection's replication cycle fails the same way
any other fatal conflict-resolution error does, reported through `onStatus` as
`error`. No new status value or error-name contract exists for it.

A public collection's pass-through codec (`createPlaintextDocCodec` in
`docCipher.ts`) checks the same binding: the row id IS the payload's own `id`
(see "The three kinds of collection" above), so a body read under a resource id
that does not match its own `id` field raises `IntegrityError` there too, and so
does a body carrying no string `id` at all, and so does an EDV envelope (a body
with an object `jwe` member) stored in the plaintext collection. Both paths over
a public collection treat all of those leniently, because a public collection
takes writes from anything holding a grant on it and the binding there is a
data-consistency check on a plaintext body, not a seal. Hydration skips such a
row with a warning and hydrates the rest. The conflict handler warns and hands
the malformed body back for comparison, so the side is settled on the
last-write-wins stamp it still carries; failing the cycle instead would break
that collection's replication permanently, since the server's body is unchanged
on every retry. A private collection's `IntegrityError` propagates out of both
paths unchanged.

`startWasSync` (`src/storage/wasSync.ts`) is the replication bootstrap: given
the parsed grant set and the invoking `ZcapClient` it builds the delegated
`WasRemoteStore`. A collection's `encryption` descriptor, its public
`plaintext.indexes` declaration, and its encrypted `custom` envelope (where a
private collection's blinded-index schema lives) are three members of one
Collection Metadata object, served at `/space/{s}/{c}/meta` under one
`metaVersion` validator. The `encryption` member is only a projection of the
collection's governing log, and is never read for the descriptor (see "The
governed descriptor source" below). The bootstrap reads the object once per
registered collection the grants cover where something on it is wanted: a public
collection declaring indexes (the `plaintext` declaration's baseline), a private
one whose descriptor was not already known (the `custom` envelope its
blinded-index install reuses). That one read feeds the public indexes
declaration and the install; the blinded-index declaration reads the object
again on its own (see below).

The private collection's cipher is rebuilt from the descriptor acquired through
the governed source, when its epoch roster differs from what the local store
opened with, and the fresh set is handed to the descriptor-cache refresher so an
offline session can rebuild its epoch-aware ciphers without a live read. Nothing
declares a collection encrypted from this side: the governing log's genesis is
what declares it, written by whoever provisions the collection, and a private
collection with no governing log stays fail-closed.

Every collection that configures equality `indexes` then declares them, and
where the declaration lives still depends on visibility. A public collection's
declaration goes on the same object's plaintext `plaintext.indexes` member,
through was-client's `Collection.configure`. It merges the change over the
object already read, carries `name`, `custom`, and every member this client does
not model forward, and pins the write to the read's validator. A lost race is
re-read and rebased by was-client's own compare-and-swap; only a race lost
repeatedly is reported here, and the next session's pass repairs it. The
declaration is skipped once the stored declaration already matches the
configured list. A private collection declares its indexes as blinded-index
attributes inside the object's encrypted `custom` envelope instead, through a
compare-and-swap write (`declareBlindedIndexes`, over was-client's
`Collection.declareIndexes`, one write for every missing attribute). The
encrypted form is what lets every recipient discover what is queryable while the
server never learns the attribute names. Only attributes missing from the
persisted schema are written, so a returning session writes nothing, and the
declaration reports whether it actually wrote.

The persisted blinded-index schema is then installed on that collection's own
document cipher (`LocalStore.applyCollectionMeta`, over the upstream cipher's
`applyMeta`), so every document the app writes from then on carries blinded
`indexed` entries and is findable by an equality query. Because the
blinded-index declaration is the one write that can change `custom`, the install
reuses the object the bootstrap already read when that declaration reported no
write, and reads the object again when it did. `Collection.meta()` is not used
for this read: it decodes `custom` to plaintext, and the cipher wants the
envelope exactly as stored. The install is remembered per collection and
re-applied whenever the cipher is rebuilt (an epoch rotation, the unknown-epoch
refresh), since a schema change rotates no epochs and so does not ride the
descriptor-equality gate. The residue is prospective-only stamping: a document
sealed before the schema was installed (anything written offline before the
first connect, including the adoption merge's pre-sync writes) carries no
entries until it is rewritten. All of it is non-fatal and warns on refusal,
including a private collection provisioned without a blinded-index key (no
`hmac` member on its descriptor), which also skips the schema read outright: an
unqueryable collection still replicates in full. The object read keeps the same
two non-answers apart as the Metadata read described below: not-found and a
backend without metadata support mean "no schema", while any other failure is
thrown, which the bootstrap warns about and skips the install for that session.

The blinded-index declaration is the one write a private collection takes in a
pass, and it reads the object fresh for its own compare-and-swap rather than
trusting the copy the pass read, so it is never caught out by a write that
landed first.

The remote store is built with this app's identity keys when they are available,
which is what lets the client's EDV keystore construct the codec the
blinded-index verbs need; replication itself still moves envelopes verbatim and
never goes through that codec. A private collection whose descriptor carries no
key epochs stays fail-closed, warned about plainly rather than surfacing later
as per-row decrypt failures. The fetched descriptors are handed to
`onDescriptorsFetched` (the offline descriptor cache) and the store's descriptor
source is installed on the local store, so a decrypt that meets an unseen epoch
(a rotation elsewhere) re-reads and rebuilds once per collection per installed
source. An unseen epoch is the only signal that spends that refresh; a decrypt
that fails because this app holds no key for an epoch the descriptor already
lists surfaces as `KeyUnwrapError` and leaves the refresh untouched. Installing
a source (a reconnect runs the bootstrap again over the same store) re-arms the
spent guard, the shared in-flight refresh, and the recorded refusals together,
so the next unknown-epoch decrypt asks the new source. Re-arming one of the
three without the others would surface a recorded refusal as a bare unknown
epoch under the stale cipher. Every change to a collection's cipher (that
refresh, the bootstrap's descriptor install, and the blinded-index schema
install) runs on one per-collection chain, so a schema install cannot land on a
cipher a concurrent rebuild then replaces. Shared collections are handled apart
from all of that: they never enter replication and never receive a declaration
write, and instead one `SharedCollectionReader` is opened per configured shared
collection the grants cover, concurrently, each failure a warn-and-skip.

### The governed descriptor source

Every `edv` descriptor this library adopts comes from one source,
`WasRemoteStore.descriptorSource`: wallet-core's `logGovernedDescriptorSource`
over each collection's `meta/log`, invoked with that collection's own delegated
zcap (the grant that reads the collection covers its log, so no second grant is
needed). A read resolves the log's verified head, with the chain, the entry
proofs, and the external authorization checked against the Space owner's
verified did:webvh account log. The served Metadata object's `encryption` member
is never read for the descriptor. It is a projection a host could strip the
governing `history` from, serving an epoch it minted in its place, and a plain
reader cannot tell that from an honest point-state descriptor.

The owner's controller view is resolved by `resolveSpaceOwner`
(`src/identity/spaceOwner.ts`), once per connected activation. A requester holds
nothing that names the Space owner: the grant chain's root is an opaque URN, and
the Space Description needs a Space-scoped capability App Connect never
delegates. What it can reach is the account log the owner publishes
world-readable at `/space/{spaceId}/id/did.jsonl`. That log is self-certifying.
The DID it resolves to encodes the host and path it is published under, so the
owner of a Space is the DID whose log is published in that Space and whose
identifier (`getFileUrl`) maps back to that URL. A log published for another
location and served there fails that check; a tampered log fails resolution. The
fetch, the resolution, and the location check are wallet-core's
`discoverAccountLog`, the reader its own ceremonies verify an account log with
(`verifyAccountLog` is that reader plus the expected-DID check), so was-react
carries no copy of the body; `resolveSpaceOwner` only names the absent-log case
after the Space asked about. The resolved `{ did, log }` becomes the
`webvhResourceLogController` every collection-log read is verified against.

Acquisition is written once, as `acquireGovernedDescriptor`
(`src/storage/governedDescriptors.ts`): was-client's `acquireDescriptor` under
`requireGoverned`, which admits only a source declaring `verifiesHistory: true`
and refuses any other with `UnverifiedDescriptorError` before asking it. The
login-time read, the bootstrap's install, the local store's unknown-epoch
refresh, and the shared reader's self-refreshing cipher
(`createRefreshingEdvDocCipher` with the same flag) all go through it, so
nothing plain-read ever enters the descriptor cache. A fetch failure that
`acquireDescriptor` would swallow (it falls back to the cache, which is empty
here) is rethrown, so "unknown" stays apart from "no descriptor". A collection
with no governing log answers no descriptor and stays fail-closed.
`UnverifiedDescriptorError` surfaces as itself everywhere, since its message
names the fix: the shared reader rethrows it ahead of
`SharedCollectionUnavailableError`, and the local store records the refusal its
refresh met and throws it from the decrypt that spent the refresh and every
later one, rather than the envelope's unknown-epoch error. A governing log the
source refuses to adopt (a forged or discontinuous chain) is treated the same
way at both sites (one predicate, `isDescriptorRefusal`, classifies both kinds),
since relabeling it as "not a recipient" or as a foreign envelope would hide a
security signal. A fetched roster that lists the epoch but wraps no key to this
app (the rebuild raises `KeyUnwrapError`) is recorded the same way: the source
has answered, so the refresh is spent and the decrypt surfaces `KeyUnwrapError`
rather than the envelope's unknown epoch. Any other refresh failure (a dropped
connection) is logged and leaves the refresh un-spent, so the next unknown-epoch
decrypt re-asks. A refresh still in flight when another source is installed
writes none of this bookkeeping; its outcome belongs to the retired source. The
refresh's install and the bootstrap's install share one freshness gate: a roster
the held cipher already matches, or an earlier head of the same log than the one
the cipher was built from, is not swapped in, so two reads of one log settling
in either order cannot move a collection backward. The owner's controller view
and the chain-head pins live together on one `SpaceTrust`
(`src/storage/spaceTrust.ts`), created by the auth store per connected
activation and handed to both the login-time read's store and the bootstrap's
store (`fromGrants` takes it as `trust`), so the owner's log is fetched and
verified once and a head served to the second store continues what the first
pinned. The owner's own account log is pinned in the same store, so a resolution
retried after a failed one continues the chain the first pinned rather than
adopting whatever the host serves next. The pins are in memory: continuity is
checked within a session, and a reload trusts the served head afresh. The owner
resolution is kept only when it succeeds; a failed fetch is retried by the next
read rather than remembered.

`readRemoteDescriptors` is the login-time counterpart. It acquires one
descriptor per granted private collection before any replication exists, because
the connected replica must open epoch-aware. Epoch-from-birth leaves no
single-key fallback, and the adoption merge writes into the replica before sync
starts. Public collections are excluded here: nothing on their Metadata object
is needed before replication exists, so they are left to the bootstrap's own
pass. Both this read and the bootstrap's per-collection pass run the same
read-filter-cache logic, written once in `wasSync.ts` as
`readGrantedEncryption`. It skips the ungranted collections, acquires each
remaining private collection's descriptor through the governed source exactly
once (reusing a descriptor the caller already acquired), and keeps only the
epoch-bearing ones. The bootstrap runs that same pass over every granted
collection, public ones with indexes included, and reads the Metadata object
beside the acquisition where its hook wants it (a public collection declaring
indexes, a private one whose descriptor was not already known), so the public
indexes declaration, the blinded-index install, and the cipher rebuild ride that
one read. The login-time pass has no hook and reads no object. The blinded-index
declaration reads the object again on its own, as noted above.

A Metadata read has two distinct non-answers, and the pass keeps them apart. "No
descriptor" is a fact about the collection: the governed source found no log, or
the object read answered not-found (which is also how WAS answers an
unauthorized read), the backend has no metadata support, or the object carries
no `encryption` member. `readCollectionMeta` answers `undefined` for exactly
that. A read that fails for any other reason (a dropped connection, a 5xx) is
thrown, because the answer is unknown rather than absent. A caller that took it
for "no descriptor" would open a correctly provisioned collection under the
fail-closed placeholder cipher and fail the adoption merge on it. Neither read
retries on its own; the HTTP client underneath already retries transient status
codes and network errors on every GET. The pass settles every collection and
reports the failed ones beside the descriptors, and each caller decides what a
failure costs. A login rejects the whole connected activation, which falls back
to `local` with the error surfaced and the anonymous replica intact for a retry.
A hot restore adopts nothing, so it warns and opens that collection fail-closed
instead, and a reload while offline still restores the connected session. The
bootstrap skips that one collection entirely, hook included, with a warning. It
keeps whatever cipher it opened with (the cached descriptor, or fail-closed) and
receives no declaration write this session; when the read succeeds on a later
session it repairs the cipher then. The bootstrap's per-collection hook is
guarded the same way. A cipher rebuild that raises `KeyUnwrapError` (a roster
rotated off this app since the cached descriptor) is reported beside the failed
reads, its descriptor is withdrawn from the set handed to the offline cache, and
every other collection still replicates. The unknown-epoch refresh is the one
place a failed read costs nothing further: the refresh is spent by the time the
source answers, and the decrypt retry fails the same way it would under no
refresh at all.

A descriptor's epoch roster can also simply not include this app: not "no
descriptor" and not "no epochs", but a roster whose recipients never wrapped a
key to this app's key-agreement key at all. That is a different failure from the
ones above. Building that collection's cipher raises `KeyUnwrapError` from
inside `LocalStore.init`, and it is not absorbed per collection the way a
missing descriptor is. The connected activation fails as a whole, and the
session falls back to `local` with the error surfaced. It never dead-ends: the
anonymous replica is what it lands on.

`createDescriptorManager` (`src/storage/descriptorManager.ts`) owns where a
descriptor comes from at each point of a bring-up, bound once to the app's
collection registry and its two seed stores. It mints and persists the anonymous
replica's descriptors at local birth, reads the offline cache before any remote
exists, completes that set with live reads for a granted private collection the
cache does not cover, and writes the sync bootstrap's fetched set back. The auth
store only sequences those four operations. Three of them are best-effort: a
failure warns and leaves the affected collections fail-closed rather than
failing the session. The live completion at login is the exception. A read that
answers "no descriptor" leaves that collection fail-closed like the others, but
a read that fails rejects the activation, for the reason given above: the
connected replica must not open over a guess the adoption merge would write
through. The same completion on a hot restore is best-effort like the rest,
since a restore adopts nothing.

`createDescriptorCache` (`src/identity/seedStore.ts`) presents the seed store's
single persisted descriptor record as the `EncryptionDescriptorCache` seam
`@interop/was-client/edv` acquires through. The blob is stamped with the
controller DID whose descriptors it holds, and a cache bound to a different
controller reads it as empty and overwrites the stamp on its first write: a
descriptor names an epoch roster a specific identity is a recipient of, so a
login under another controller must never build ciphers from it. Puts are
read-modify-writes over the one record, serialized through a promise chain so
two of them cannot lose one another's entry. The cache is a superset of that
seam: it also reads the whole set in one blob read and merges a whole set in one
read-modify-write, so a bring-up phase costs one IndexedDB open/close instead of
one per collection.

The root entry also re-exports `mintRecordEncryption` (from
`@interop/wallet-core/keyring`) beside `LocalStore`, `deriveIdentity`, and
`createDescriptorCache`. The seam rule: a consumer handed `LocalStore` directly
is handed everything needed to provision one under epoch-from-birth -- minting
the one-epoch descriptor a fresh encrypted collection requires must not force a
dependency on `@interop/wallet-core`. It is the same minting the anonymous
replica and this package's own tests use.

`publicUrlFor({ collectionKey, id })` (`src/storage/publicUrl.ts`) composes the
stable, world-readable resource URL of a document in a public (plaintext)
collection -- the publish-copy share pattern. It routes the logical key to its
WAS collection id through the active storage context, exactly as
`EntityStore.query` does, so it needs an open `LocalStore` and a
wallet-connected session, and it fails closed on a non-public or unprovisioned
collection or an empty id. The URL resolves publicly only once the document has
replicated.

`createDocumentLoader` (`src/identity/documentLoader.ts`) is the app's one
JSON-LD document loader: `@interop/security-document-loader`'s static security
contexts and its default did:key + did:web resolver, plus the
`@interop/did-method-webvh` driver, so a wallet may present its presentation
holder as a did:webvh and verification still resolves it -- as VERIFIED
resolution, with the driver's history-log verifier (hash chain plus entry
proofs) active, so a tampered `did.jsonl` fails closed. The BYOE App Connect
contexts are registered as static documents from `byoe-context`, which is what
keeps verification fetch-free and lets vocabulary additions ship with a
`byoe-context` bump alone. DIDs on loopback hosts resolve over plain http
natively, so no dev shim is needed.

## The one-document facade

`defineDocumentApp` (`src/react/documentApp.ts`) builds the whole wiring --
config, store registry, entity store -- for an app whose entire model is a
single key-value document (an Excalidraw-style editor, a game save file), and
returns a typed `useAppDocument` hook over it. The app never sees
`createEntityStore`, grant parsing, or sync internals: it renders `doc`, calls
`update`, and optionally offers file export/import (`was-document/v1` tagged
blobs) and a "Save to Web Spaces" `connect()`.

It is a degenerate entity store: one collection holding one logical document
under a fixed id, with the app's data wrapped as
`{ id, updatedAt, writerId, data }` so app fields can never collide with the LWW
fields the sync layer requires -- and stamped by the entity store's `upsert`,
not by the facade, which passes `{ id, data }` alone. Hydration goes through
`LocalStore.hydrateSingleton`, which LWW-reconciles the duplicate envelope rows
two clients can mint for the same logical document, keeping the winner and
tombstoning the losers. The generated config registers exactly one collection
and sets `onboarding: 'local-first'`, so `connect()` is plain `login()`: one
legible line on the wallet consent screen, and the default merge adoption
carries the local document into the granted collection. Multi-document ("slot")
variants are not supported yet (they would need a grouped per-id reconciler --
`hydrateSingleton` reconciles all rows down to one winner), and an app that has
outgrown one document should move to `createEntityStore`.

## The MUI dialogs

Three presentational confirmations over the store's actions, all built on
`ConfirmDialog` and all cancel-safe (backdrop, escape, or Cancel runs nothing):

- `LogoutDialog` makes the keep-versus-wipe choice explicit -- log out but leave
  the local replica on this machine, or log out and erase it -- since a shared
  machine and a personal one want opposite defaults. It states that erasing
  removes the local copy only and that data already synced returns on the next
  login.
- `ClearDataDialog` confirms the destructive reset behind `clearLocalData`. Its
  warning is mode-aware: in `local` the local replica is the only copy, so it
  nudges the user to export first; once connected, the synced copy survives, so
  it says so instead of threatening total loss.
- `AdoptDialog` is the pre-login adoption choice an app shows when
  `useHasLocalData` reports data in the anonymous replica: "Bring my data" runs
  `login({ adopt: 'merge' })`, "Set it aside" runs `login({ adopt: 'leave' })`.
