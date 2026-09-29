# Genesys Cloud APIs — what this system actually calls

Collections: <https://developer.genesys.cloud/platform/api/postman>

Genesys generates these from the API spec, so coverage is complete — the
problem is the opposite of Webex's. There are hundreds of requests and six of
them matter. Note that Genesys does **not** support Postman as a channel; the
collections are a convenience.

## Read this first: you are on GovCloud

The stock collections and every tutorial default to `api.mypurecloud.com` and
`login.mypurecloud.com`. **This tenant is not there.**

```
api    https://api.use2.us-gov-pure.cloud
login  https://login.use2.us-gov-pure.cloud
```

(`comms/client.ts:82` and `:81`.) Point the Postman environment at those or
every request 401s against an org that does not exist, which reads as a
credentials problem and is not one.

## The six endpoints

| Endpoint | Method | Used by | API family |
|---|---|---|---|
| `/oauth/token` | POST | `comms/client.ts:220` | Auth (on the **login** host) |
| `/api/v2/users?state=any` | GET | `comms/genesys.ts:33` `pullGenesys` | Users |
| `/api/v2/routing/queues` | GET | `comms/signals.ts:312`, `staffing.ts:91` | Routing |
| `/api/v2/routing/queues/{id}/members` | GET | `comms/staffing.ts:94` | Routing |
| `/api/v2/analytics/queues/observations/query` | POST | `comms/signals.ts:323` | Analytics (real-time) |
| `/api/v2/analytics/conversations/aggregates/query` | POST | `comms/signals.ts:335` | Analytics (aggregate) |

## Priority order for getting familiar

1. **`POST /oauth/token`** — nothing works until this does. See the grant note
   below; it is the one that catches people.
2. **`GET /api/v2/users?state=any`** — the workforce join. `state=any` is
   deliberate: the default omits inactive users, and we want the full roster.
3. **`GET /api/v2/routing/queues`** then **`/members`** — queue staffing. We
   read members **one queue at a time on purpose**: the token's rate limit is
   shared, and parallel reads buy 429s.
4. **The two analytics `/query` POSTs** — these carry the actual signal, and
   they are POSTs with a JSON body rather than GETs with query strings. This is
   where the Postman collection earns its keep, because the request bodies have
   real structure (interval, granularity, group-by, metrics) and getting one
   subtly wrong returns an empty result rather than an error.

Observations vs aggregates is worth internalising before reading the code:
*observations* are a right-now snapshot of queue state, *aggregates* are
bucketed history. We use both, for different signals.

## Auth: client credentials have no user context

We use `grant_type=client_credentials` with HTTP Basic
(`comms/client.ts:220-228`).

Genesys is explicit that **client credentials carry no user context — only the
permissions of the attached role.** Any endpoint that resolves "the current
user" (`/api/v2/users/me` and friends) will not work, and the failure is not
always an obvious 403. Our six reads are all org-scoped, so this is fine, but
it will bite you the moment you copy a request out of a tutorial written
against an implicit-grant token.

If a request works in the Genesys API Explorer (which uses *your* login) and
fails from our integration, this asymmetry is the first thing to check, not the
second.

## What to skip

Conversations, Telephony, Workforce Management, Architect flows, Notifications
websockets, Knowledge, Journey. Large, well documented, and not in our path.

**Do not** reach for the alerting APIs. Genesys's own conclusions about a queue
are the system of record counting itself — same argument that keeps Orion's
alerts and Splunk out of evidence. We read measurements and decide separately.

`/api/v2/authorization/divisions` is served by our mock
(`mock/genesys.ts:474`) but **no code outside `mock/` calls it**. Placeholder,
not a supported read.

## Local alternative

`pnpm mock` serves all of these on `127.0.0.1:5190` from
`src/integrations/comms/mock/genesys.ts`, including the OAuth token endpoint.
No credentials, no GovCloud access, and the analytics responses are shaped
against the seeded estate — which makes it a faster way to check a body shape
than round-tripping a real org.

---

**Sources:**
[Postman — Genesys Cloud Developer Center](https://developer.genesys.cloud/platform/api/postman) ·
[Platform API overview](https://developer.genesys.cloud/platform/api/) ·
[Configure Postman for Platform API](https://developer.genesys.cloud/blog/2025-02-18-configuring-postman/index)
