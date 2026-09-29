# Webex APIs — what this system actually calls

Collection: <https://github.com/WebexSamples/postman-webex>

## Read this first

**The Webex Postman collection mostly does not cover what NetPulse uses.** Of
the four Webex endpoints in this codebase, **one** appears in it.

That collection is built around *messaging* (Messages, Rooms, Teams, Webhooks,
Cards) and *org admin* (Roles, Licenses, Devices, Places, xAPI). NetPulse is a
**meetings-quality consumer** — it never sends a message, never touches a room,
never reads a device. So import it for `/v1/people` and the auth setup, then
work from the developer docs for the rest.

## The four endpoints, and where each lives

| Endpoint | Host | Used by | In the collection? |
|---|---|---|---|
| `GET /v1/people` | `webexapis.com/v1` | `comms/webex.ts:32` `pullWebex` | **Yes** — Admin (*People*), also Messaging |
| `GET /v1/locations` | `webexapis.com/v1` | `comms/webex.ts:32` `pullWebex` | **No** — see note below |
| `GET /v1/meetings` | `webexapis.com/v1` | `comms/signals.ts:273` | **No** |
| `GET /v1/meeting/qualities` | `analytics.webexapis.com/v1` | `comms/signals.ts:281` | **No** — different host entirely |

### `Locations` is not `Places`

The Admin collection has a **Places** folder. That is *not* this. Places are
workspaces — a room with a device in it. **Locations** are Webex Calling sites,
and that is what NetPulse joins people to in order to get a facility code. If
you work from the Places requests you will build the wrong mental model of the
join.

### The analytics host is separate

`/v1/meeting/qualities` is served from `analytics.webexapis.com`, not
`webexapis.com` (`comms/client.ts:84`). Same token, different base URL. Nothing
in the collection points there, so you will be adding that request by hand.

## Priority order for getting familiar

1. **`GET /v1/people`** — start here. It is in the collection, it is the join
   key for everything (`workforce.ts` joins on the lower-cased email), and it
   is the one request you can run unmodified.
2. **`GET /v1/locations`** — the other half of the join. Build it by hand.
3. **`GET /v1/meetings`** — note the query we actually send:
   `?meetingType=meeting&state=ended&from=…&to=…&max=100`. We ask from an hour
   *before* the window and filter for overlap, because a meeting that started
   at 13:50 and ran past 14:00 belongs in the 14:00 window.
4. **`GET /v1/meeting/qualities?meetingId=…&max=1000`** — the payload that
   actually matters. One request *per meeting*, which is why the read is the
   slowest part of a poll.

## Auth

The collection wants a `{{access_token}}` environment variable, and the Admin
folder needs an admin-privileged token. That matches us: `pullWebex` reads the
whole org's people and locations.

**We hold a long-lived token and never refresh it** (`comms/client.ts:230`) —
unlike Genesys and Entra, which do OAuth client-credentials at runtime.
Rotation is an operational task here, not a runtime one. The developer-portal
personal access token is fine for exploring and expires in 12 hours; do not
model the production integration on it.

You can ignore the `{{bot_token}}` variable. It is only for the Cards
collection, which we have no use for.

## What to skip entirely

Messages, Rooms, Teams, Webhooks, AttachmentActions, Cards, Devices, xAPI,
Roles, Licenses. None of it is in our path. The Admin collection's *Events*
folder looks tempting as an audit source — it is not one we use, and Webex
conclusions about our estate would be one witness twice over, the same argument
that keeps Orion's alerts and Splunk out of evidence.

## Local alternative

`pnpm mock` serves these routes on `127.0.0.1:5190` from
`src/integrations/comms/mock/webex.ts`, which implements `/v1/people`,
`/v1/locations`, `/v1/meetings` and `/v1/meeting/qualities` against the seeded
estate. Faster than Postman for checking a shape, and it needs no token.

`/v1/cdr_feed` is in the mock but **is not wired to anything** — no code
outside `mock/` reads it. Treat it as a placeholder, not a supported read.
