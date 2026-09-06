# Data modelling

## The split

```
DynamoDB — signals, incidents      high volume, write-heavy, known-key reads
Aurora   — sites, regions, reports spatial, ad-hoc, joins and aggregates
S3       — raw vendor payloads     cheap, durable, replayable
```

Using one for the other's job is the mistake. DynamoDB cannot answer "which
sites are within 75km"; Aurora cannot absorb a million writes a minute without
becoming a project.

---

## DynamoDB single-table design

### The idea

DynamoDB has no joins. So instead of one table per entity, you put every entity
in **one** table and design the partition key (PK) and sort key (SK) so that
items you want to fetch *together* sort *next to each other*. Then you Query a
key prefix.

```
PK                       SK                          entity
TENANT#acme#SITE         SITE#dal-01                 Site
TENANT#acme#SIGNAL       2026-09-04T10:00:00Z#a3f…   Signal
TENANT#acme#INCIDENT     2026-09-04T10:02:00Z#inc_7f Incident
```

Because the SK **starts with an ISO-8601 timestamp**, "this tenant's signals
from the last hour, newest first" is one Query with a range condition and
`ScanIndexForward: false`. No scan, no filter, no sorting in application code —
ever.

> **The rule to repeat:** model your access patterns first, then derive the
> keys. Never the other way round.

### Access patterns for this product

| Pattern | How |
|---|---|
| Recent signals for a tenant | Query `PK = TENANT#<t>#SIGNAL`, descending, limit |
| Signals for one site | Query **GSI1** `GSI1PK = TENANT#<t>#SITE#<site>` |
| Open incidents | Query `PK = TENANT#<t>#INCIDENT`, descending |
| One site by id | GetItem `PK = TENANT#<t>#SITE`, `SK = SITE#<id>` |

GSI1 flips the access direction — that is what a secondary index is *for*.
Without it, "all signals for dal-01" would mean reading every signal for the
tenant and filtering, which costs read units proportional to your **data**
rather than to your **answer**.

### Query vs Scan vs Filter

| | Cost is proportional to |
|---|---|
| **Query** | The items returned (within one partition) |
| **Scan** | The **whole table** |
| **FilterExpression** | The items **read**, not the items returned |

That last row is the one people get wrong. A filter runs *after* the read: it
reduces the payload, not the bill. If you filter a lot, you need a different key
or a sparse GSI.

`--only=data` prints the read counts side by side.

### What a GSI actually costs

A GSI is a full, eventually-consistent **copy** of the projected attributes with
its own throughput, and it consumes write units on **every** base-table write.

- Project with `INCLUDE`, listing what the query needs. `ALL` doubles storage
  and write cost; `KEYS_ONLY` forces a second read per item.
- GSIs are **sparse**: items without the GSI key don't appear at all. Useful —
  you can cheaply index just the subset you care about (e.g. only unresolved
  incidents).

### Capacity mode

`PAY_PER_REQUEST` for spiky, unpredictable SaaS traffic — you never think about
capacity. Switch to `PROVISIONED` with autoscaling only once traffic is steady
enough to forecast: roughly 5x cheaper at high, predictable volume, and
considerably more expensive if you guess wrong.

### Two features worth using

**TTL.** Set an `expiresAt` attribute (epoch seconds) and DynamoDB deletes the
item within ~48h, **free**. Far cheaper than a scheduled cleanup job, and it
keeps hot partitions small.

**Streams.** A change log of the table. The main use is the **transactional
outbox**: write the row and its event in one transaction, and let a
Streams-triggered Lambda publish the event. That is the rigorous answer to "how
do you guarantee the event and the write cannot diverge?"

### Hot partitions

DynamoDB spreads load across partitions by key. A key like
`PK = TENANT#acme#SIGNAL` puts one tenant's entire write volume on one
partition. Adaptive capacity absorbs a lot of this now, but if a single tenant
outgrows it, **write-shard**: `TENANT#acme#SIGNAL#<0-9>` and scatter-gather on
read. Know the technique; don't apply it pre-emptively.

→ `src/aws/dynamodb.ts`, `src/platform/repository.ts`

---

## Why the repository layer exists

Every read and write goes through `src/platform/repository.ts`. Two reasons:

1. **Tenancy.** Every function takes a `Principal` and builds the partition key
   itself. There is no function accepting a bare `tenantId` string, so there is
   no code path that *can* forget the tenant. The type system enforces it.
2. **Key layout.** When access patterns change — and they will — the key design
   changes in one file instead of thirty.

The AI agent's tools call these same functions. That is deliberate: the agent
must not have a privileged back door into the data.

---

## Aurora PostgreSQL

Used for sites, service regions and reporting. Serverless v2 scales capacity
continuously and, in non-prod, **to zero** after 15 minutes idle — which takes a
dev database bill to nearly nothing overnight. Never enable auto-pause in prod;
cold resume costs ~15 seconds.

Schema highlights (`src/data/schema.sql`):

- **`tenant_id` first in every primary key.** Every query filters on it, and a
  leading tenant column keeps each tenant's rows physically clustered.
- **A `CHECK (ST_IsValid(boundary))` constraint.** Self-intersecting polygons
  make `ST_Contains` return nonsense rather than an error — a horrible bug to
  find six months later.
- **A partial index**, `WHERE status <> 'resolved'`. Only open incidents are ever
  listed; resolved ones accumulate forever. Indexing the 1% you query keeps the
  index small enough to stay in memory.
- **A GIN index** on the `site_ids` array so `'dal-01' = ANY(site_ids)` is
  indexed rather than scanned.
- **Row-level security** keyed on `current_setting('app.tenant_id')`, so even a
  SQL injection or an ad-hoc query cannot cross tenants.

> RLS is **bypassed by the table owner** and by any role with `BYPASSRLS`. The
> application must connect as a non-owner role, or the policies are decorative.

---

## S3 — the raw layer

Hive-partitioned so Athena/Glue can prune by date:

```
raw/tenant=acme/provider=cisco-meraki/dt=2026-09-04/hh=10/<uuid>.json
```

**Archive before you normalise.** Normalisation is code, code has bugs, and when
you fix the bug you want to replay history rather than beg the vendor for last
month's data. This is the "bronze" layer of a medallion architecture.

Lifecycle rules that pay for themselves:

- Standard → Standard-IA at 30 days → Glacier Instant Retrieval at 90.
- `noncurrent_version_expiration` — versioning is on, so old versions accumulate
  invisibly and you pay for every overwrite forever without this.
- `abort_incomplete_multipart_upload` — failed multipart uploads leave orphaned
  parts you are billed for and cannot see in the console.
- `bucket_key_enabled` on SSE-KMS — cuts KMS request costs by up to 99%.

→ `src/aws/s3.ts`, `infra/terraform/modules/s3-bedrock-kb/main.tf`

---

## Idempotency

The pipeline is at-least-once: EventBridge and Step Functions both retry. So
make the **write** idempotent rather than trying to make delivery exactly-once.

```ts
signalId = sha256(`${provider}|${sourceRef}|${observedAt}`).slice(0, 24)
```

The same vendor reading always produces the same id, so a duplicate `PutItem`
overwrites with identical bytes instead of creating a second row.

For genuinely non-idempotent side effects (charging a card, paging a human), use
a conditional write on a dedupe key:
`ConditionExpression: 'attribute_not_exists(PK)'`.

→ `src/platform/ids.ts`, and the test in
`src/integrations/connector.test.ts` that proves re-ingesting produces identical
ids.
