# Code tour

`00-start-here.md` gives a reading order for understanding the *product*. This
is the other thing: a walk through the *code*, in the order data actually moves,
stopping at the files that carry a design decision rather than plumbing.

Written as it is walked. Stop 1 is complete; the later stops carry their file
pointers already, and get filled in as we go through them.

## Two structural facts to hold first

**`src/` has zero runtime dependencies and no `node:` imports.** That is not
minimalism for its own sake. The React board in `web/` imports the backend
modules *directly* and runs them in the browser tab, so the whole backend has
to be portable code. It is why `platform/clock.ts`, `crypto.ts` and `random.ts`
exist at all.

**`src/aws/` is not a wrapper around the AWS SDK.** It is six local stand-ins —
DynamoDB, S3, Kinesis, EventBridge, Step Functions, Bedrock — implementing the
same *semantics*, which is what lets `pnpm start` run the entire platform with
no account and no network.

## The itinerary

| Stop | Where | What it answers |
|---|---|---|
| 1 | `src/platform/types.ts` | The domain model. Everything is shaped by this |
| 2 | `src/integrations/` | How vendor JSON becomes an `Observation` |
| 3 | `src/platform/inventory.ts` | The alias→deviceId join — the genuinely hard part |
| 4 | `src/pipeline/steps.ts` | The spine: collect → … → correlate |
| 5 | `src/aws/` | Six AWS services, in-process |
| 6 | `src/api/`, `src/geo/`, `src/ai/` | Reading it back: GraphQL, REST, maps, the agent |
| 7 | `web/src/` | The board, which imports the backend directly |

---

## Stop 1 — `src/platform/types.ts` (640 lines)

Read this one properly. Everything downstream is a consequence of it.

### `Observation` is the centre of gravity

`types.ts:272` — a three-way union, and the fork itself is the design decision:

| Variant | Line | What it is | Where it is stored |
|---|---|---|---|
| `MetricObservation` | `:231` | a scalar + a unit — temperature, utilisation, optical dBm | DynamoDB + S3 history |
| `EventObservation` | `:238` | a *state transition*. No value, because a value would be meaningless | DynamoDB + S3 history |
| `FlowObservation` | `:257` | a traffic aggregate | **S3 only**, queried with Athena |

Flows are split out because they are the one class whose volume scales with
*traffic* rather than with incidents. Putting them in the operational store
makes the bill track how busy the network is, which is the wrong thing for it
to track.

### `ObservationPlane` is the most load-bearing type in the repo

`types.ts:118` — `'device' | 'controller' | 'external'`. It answers **where the
knowledge originated**, and corroboration — two independent witnesses before
anyone gets paged — is defined over it.

Note what it deliberately does *not* describe: how the data travelled. There
used to be a `planeFor(encoding)` helper, and `types.ts:83` is now a comment
explaining why it must never come back. Every feed is cloud HTTP now, so
deriving plane from transport would stamp the whole platform `controller`,
`planes.length >= 2` would be unsatisfiable from vendor data, and nearly every
alarm would be silently held back. One Meraki poll legitimately produces both
planes, from two different endpoints.

### `ObservationBase`

`types.ts:179` — the common shape: tenant, device, time, plane, dedupe key.

### Constants that are policy, not plumbing

- `DEDUPE_BUCKET_MS` (`:323`) — how wide a window counts as the same report
  arriving twice.
- `CLOCK_SKEW_LIMIT_MS` (`:350`) and `ResolvedTime` (`:352`) — devices lie
  about the time. Both the claimed and the received timestamp are kept, rather
  than picking one and losing the evidence that they disagreed.

### The bus projections, at the bottom

`AlarmEventDetail` and `IncidentEventDetail` are what actually crosses
EventBridge: flat, partial, and deliberately not the full record, because
EventBridge rules pattern-match on structure. A consumer that casts
`e.detail as Alarm` compiles cleanly and then throws on every delivery — see
the note in `CLAUDE.md`, which is there because it happened.

### Suggested read order inside the file

`:118` plane → `:179`–`:272` observation → `:409` `Device`, `:431`
`NetworkInterface`, `:466` `DeviceState` → the alarm and incident types → the
bus projections at the end.

---

## Stop 2 — the ingest edge

`src/integrations/http.ts`, `webhook.ts`, `connector.ts`, `controller/`.
Where vendor JSON becomes an `Observation`.

## Stop 3 — `src/platform/inventory.ts`

The alias→deviceId join.

## Stop 4 — `src/pipeline/steps.ts`

The spine, top to bottom.

## Stop 5 — `src/aws/`

## Stop 6 — `src/api/`, `src/geo/`, `src/ai/`

## Stop 7 — `web/src/`
