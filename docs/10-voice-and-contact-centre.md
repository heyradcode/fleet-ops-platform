# Voice, contact centre and the remote-site WAN

The second half of the platform: the communications estate of a large public
agency — Teams, Webex and Cisco phones, a Genesys contact centre, the SIP
trunks and the satellite links underneath them — watched with the same rules
the network side already follows. Everything here runs offline against mocks
of the vendors' own APIs.

```bash
pnpm start --only=comms        # the whole comms story, narrated
pnpm start --only=solarwinds   # the network half: an on-prem poller, two planes
pnpm start --only=brief        # the executive brief (after the two above)
pnpm web                       # sign in as an hhs-demo account -> "comms"
pnpm mock                      # the vendor mocks on http://127.0.0.1:5190, for curl
```

---

## The sources, and what each can witness

| Source | What it tells us | Subject | Witness kind |
|---|---|---|---|
| **Teams** (Microsoft Graph) | Voice users; Direct Routing calls; call quality | trunk, facility | measures its own calls |
| **Webex** | Calling users and locations; meeting quality; CDRs | facility | measures its own calls |
| **Genesys Cloud** | Agents; queue backlog and abandonment; queue members, placed in buildings as **counts** (hourly) | queue | the system of record |
| **Bandwidth** | The carrier's end of each SIP trunk | trunk | the other end of the SBC |
| **Starlink** | The satellite WAN at remote sites | facility | the dish measures its link |
| **Kurmi** | The Cisco desk-phone estate, by agency — and the phone names CUCM is asked about | — | inventory only |
| **CUCM** (RisPort70) — on premises, or Webex Calling Dedicated Instance | Whether each desk phone is **registered** | facility | the call control counting its own registrations |
| **Helix** (BMC ITSM) | Changes and tickets | — | **context, never evidence** |
| **SolarWinds** (Orion) | Network devices: ICMP and SNMP | device | two planes, see below |
| **911Inform** | E911 — **not built**, see below | | |

The rule that decides everything below is the network side's, restated:
**independence means a different vantage point, not a different feed.**

- *Call quality at a facility* is an inference about a building's network,
  drawn from clients. One service can be wrong about it alone (a client
  build, a media region), so it needs **two services** — Teams and Webex — to
  agree. When the second is down, the alarm is held back and says *"Webex was
  unavailable"*, never *"single source"*: could-not-ask is not saw-nothing.
- *A trunk's failure rate*, *a queue's backlog* and *a dish's packet loss* are
  the system counting itself. They page on one source.
- *Bandwidth* is not a second witness that gates paging; it is the **other end
  of the SBC**. It sees the half of an outage Teams structurally cannot — a
  dead SBC's inbound calls fail at the carrier and never reach Teams — and the
  two ends together say **which leg** is at fault.
- *Desk-phone registration* is the call control counting its own
  registrations, so it pages on one source too — and it is the **only**
  witness there is. A phone that cannot register makes no calls, so Teams and
  Webex, which judge calls, see nothing: the same silence as a dead SBC. Only
  the **network's** reasons count (`KeepAliveTimeout`, `ConnectivityError`); a
  phone switched off, wiped or logged out of is a decision, like an admin-down
  port, and a desk unregistered for over a week is data quality.
- *SolarWinds* is a poller we run, so it observes from two planes: its ICMP
  status is **external** (the same plane as our own probe — one witness, not
  two, if a tenant runs both), and the SNMP counters it relays are **device**.
  Its alerts are never ingested: they are its conclusions from the same polls.
- *Helix* never becomes evidence. Changes and tickets are attached **after**
  the rules decide, labelled *candidate, not cause*, and matched through
  tenant tables — or, for network devices, along the uplink chain and never
  sideways.

---

## How a poll flows

```
 Entra directory ──delta──▶ placement (hash + LC code, never the address)
        │
 Teams · Genesys · Webex ──▶ WORKFORCE: people joined by lower-cased email,
        │                    agency from the domain, facility from Entra/Webex
        ▼
 Kurmi ──phone names──▶ CUCM (RisPort70 is asked BY NAME; no Kurmi, not asked)
        │
 Teams · Webex · Genesys · Bandwidth · Starlink · CUCM
        │  each source isolated: one failing costs that source, never the poll
        ▼
 SIGNALS  one number per (subject, kind, window) - never one per call
        │
        ├──▶ ANOMALIES  vs this subject's baseline for this hour of the week
        │               (early warning and context; never an alarm)
        ▼
 ALARMS   corroboration by service; fault location from the trunk's two ends
        ▼
 INCIDENTS  grouped by subject ──▶ + Helix context (after the rules)
        ▼
 LIFECYCLE  one open incident per subject; resolves only on a HEALTHY
            MEASUREMENT three polls running - never on silence
        ▼
 store (counts only) ──▶ board · assistant tools · daily brief
        ▼
 ARCHIVE  the poll's normalised output, to S3 as a backup - signals, alarms,
          incidents, workforce COUNTS, health; never a person
```

Each stage is one file under `src/integrations/comms/`, and each file's header
is the long form of the paragraph above it.

| File | What it owns |
|---|---|
| `client.ts` | Tokens (per tenant, refreshed early), retries honouring `Retry-After`, the paging dialects |
| `entra-directory.ts` | Delta sync, resumable across runs; generations, so nobody reads a half-built directory |
| `workforce.ts` | The email join, the agency and facility split, unique people per facility |
| `signals.ts` | Windowed aggregates with minimum samples; the thresholds, in one place |
| `incidents.ts` | Corroboration, dissent, fault localisation, grouping |
| `lifecycle.ts` | Identity across polls, measured recovery, flap handling |
| `anomalies.ts` | Hour-of-week baselines in the customer's zone; never learning an outage |
| `health.ts` | Per-source status with history; data-quality issues that name their fix |
| `helix-context.ts`, `helix-network.ts` | Candidate changes and existing tickets |
| `kurmi.ts`, `starlink.ts`, `bandwidth.ts` | The sources with unusual protocols — SOAP, a stream, XML |
| `cucm.ts` | Desk-phone registration: by name, batched, paced to a shared allowance; which unregistrations count |
| `staffing.ts` | Which buildings each queue's agents sit in - counts, of ALL members, through the roster that is not kept |
| `poll.ts` | The order all of the above runs in |
| `archive.ts` | The backup: each poll's normalised output to S3, with a tripwire that refuses personal data |
| `../../reporting/daily-brief.ts` | The executive brief: every figure from stored data, none from a model |

### The archive: a backup of what the polls meant, not of what the APIs said

After every poll, `archive.ts` writes the poll's **normalised** output to S3.
That's the signals (one number per trunk, facility or queue per window, with
its sample size), the alarms and incidents the rules decided, the workforce
as **counts**, and each source's health. It's enough to rebuild the comms
side of the table, to keep history past the table's lifetime, and to query a
year of it with Athena.

It is deliberately **not** the raw API responses. Those carry the roster
(names, emails, addresses, phone numbers), which this platform never stores
(`store.ts`). Two guards keep it that way:
- **By type.** The archive's input has no field for the roster or a call
  record, so the poll's roster can't be passed by mistake.
- **By a tripwire.** Every object is scanned for an email address or an
  E.164 phone number before anything is written. One match refuses the whole
  poll's archive and names the record type, never the match.

A test runs a real poll and checks that no name, email, street address,
phone number or vendor id from the mock directory appears anywhere in the
archive.

| | |
|---|---|
| Layout | `comms/<record>/tenant=<t>/dt=YYYY-MM-DD/hh=HH/<poll time>.jsonl`: JSON Lines, hive-partitioned for Athena, one object per record type per poll |
| Records | `signals`, `alarms`, `incidents` (open and resolved), `workforce`, `health`; every line carries `schema`, `tenantId`, `polledAt` |
| Bucket | `infra/terraform/auth/comms-archive.tf`: versioned, SSE-S3, public access blocked, TLS only; kept `comms_archive_retention_days` (default 400) |
| Failure | Never fails the poll. It's logged and reported in the poll result; the operational data is already in the table |
| Writer | `pnpm seed:aws`, through the AWS CLI (`scripts/s3-cli-store.ts`). A scheduled poller in Lambda would use an SDK adapter behind the same `ObjectStore` interface |

It stays in S3 Standard on purpose. The cheaper classes bill a minimum object
size (128 KB for Standard-IA and Glacier Instant Retrieval), and these
objects are a few KB each.

---

## What is grounded, what is modelled, what must be verified

The mocks answer the vendors' **real hostnames and paths**, and keep each
API's known traps. How much of each is grounded varies, and a review should
know exactly where:

| Source | Grounded in | Modelled or placeholder | Verify against a live tenant |
|---|---|---|---|
| Teams (Graph) | Graph v1.0 reference | `userConfigurations` filter support | Teams admin fields; accepted `$filter`s; delta-token lifetime |
| Genesys | Platform API reference; the customer sample's **field names** | analytics response detail | — |
| Webex | Developer reference | CDR field set; meeting-quality units | both |
| Bandwidth | Account API (XML, sites, SIP peers) | **call-outcomes endpoint is a placeholder**, isolated in `fetchPeerOutcomes` | the Insights reference |
| Helix | AR System REST, as documented | CI association flattened onto the change | the customer's customised forms; token lifetime |
| Kurmi | **One sample's structure** — no schema | endpoint path, paging, failure reporting | the schema (held by the legacy EMP reporting team) |
| CUCM (RisPort70) | Cisco's **published** RisPort70 reference (DevNet) | Fault wordings; a name with no record being simply absent | that the cluster grants RisPort to an application user (for Dedicated Instance, Cisco's call); our share of the rate allowance; the route to it |
| Starlink | The published Enterprise API client | alert names (real ones come from each response) | alert names; `ObstructionPercentTime` units |
| SolarWinds | SWIS / SWQL references | — | custom properties; which columns are UTC |
| 911Inform | — | **not built** | an API reference — there is no public one |

Nothing in the mocks is real data. People, facilities and phones are
synthetic, on `.example` domains; addresses are from reserved test ranges.
Where a customer sample informed a shape, its **structure** was used and its
values never were.

---

## Things that were learned the hard way while building this

- **HTTP 200 is not success** on a SOAP API (Kurmi). The body's status is.
- **A telemetry stream can advance on send** (Starlink). The only defence is
  archiving the raw body before parsing it — the watermark rule, inverted.
- **One service account per environment** (Starlink): shared, each consumer
  silently receives part of the stream.
- **Rates over small samples are noise.** A queue abandoning "four times
  normal" at 26 calls a half-hour is three calls; the anomaly engine rightly
  will not call it. Volume is where early warning is real.
- **Unique people, not summed columns.** Someone on Teams and Webex is one
  person; a sum overstates every "how many are affected".
- **Resolution needs a healthy measurement.** A dead SBC at 3am produces no
  signal at all; "no alarm" would have closed its incident while it was down.
- **A phone that cannot register is silent** (CUCM). No call, so no bad
  call: every call-quality source reports a building whose desk phones are
  all dead as fine. Only the call control can say so.
- **RisPort70's limits are shared and silent.** Its ~15 requests a minute are
  the whole cluster's, spent by every application that reads it; an answer
  holds at most 2000 devices and does not say when it stopped. So phones are
  asked by name in batches of 500, paced to a configured share, and a
  building the per-poll budget did not reach is *not measured* — never a
  partial rate. `selectCmDeviceExt` takes no wildcards, which is why the
  names come from Kurmi.
- **The same answer names people.** RisPort70 returns the logged-in user,
  a description that is usually someone's name, and the extension. The
  connector reads name, status, reason and time, and nothing else.
- **One SBC, two spellings, two subjects.** Graph returns the trunk FQDN as
  the gateway was typed; the tenant tables say it however their author did.
  `SBC2.voice...` and `sbc2.voice...` were two subjects, so the carrier's
  end and Teams's end of one SBC never met. Every FQDN is a key now
  (`fqdnKey`: lower-case, no trailing dot).
- **"Not asked" is its own state.** A source nobody asked (CUCM with no phone
  list) is neither healthy nor down - but stamping it "succeeded" every poll
  meant it could never go stale. A snapshot built while the directory was
  still syncing would have said "nobody can be placed" for an hour.
- **Inverted thresholds fail silently.** Reachability was `[1, 1]` for a
  release — every reachable device critical, invisible to the alarm rules,
  visible only on the map and in the agent's evidence.

---

## Decisions that are not ours to make

These are open, deliberately, because each is either outward-facing or
irreversible:

1. **Splunk as a data source.** The platform treats it as context, never
   evidence; a requirement to ingest it would need that rule changed on purpose.
2. **Comms incidents on the event bus.** A new projection is a contract every
   consumer depends on.
3. **Agency or facility access scopes.** They need Cognito custom attributes,
   which can never be renamed or removed once the pool exists. Until then,
   comms data is tenant-wide only — a site is not a facility.
4. **Writing to Helix.** Opening or updating a ticket pages people.
5. **Delivering the daily brief** by mail or Teams. It is built; sending it is
   the customer's call.
6. **Reading CUCM at all, and how much.** RisPort's allowance is shared with
   the customer's own tools, so our share (`cucm.requestsPerMinute`) is theirs
   to set. For Dedicated Instance, whether an application user may read
   RisPort is Cisco's to allow, and the cluster is reached over private
   peering, so the poller has to run where that route is.
