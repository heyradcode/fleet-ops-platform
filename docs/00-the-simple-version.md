# NetPulse, the simple version

Read this first if the rest of `docs/` feels like a lot. It explains the whole
system the way you would explain it to a five-year-old. Every section ends with
**In the code**, for when you're ready for the grown-up version.

---

## The story in one breath

HHS is like a very big school with lots of buildings. Every building has:
- boxes that pass messages around (the **network**);
- phones and video calls (**Teams** and **Webex**);
- a room full of people answering calls from the public (the **contact
  centre**).

Sometimes something breaks. NetPulse is the helper that:

1. **listens** to everyone who might tattle about a problem;
2. **works out what really broke**, without panicking over one grumpy voice;
3. **tells the right grown-up once**, not fifty times;
4. **answers questions** about it, on a board you can look at and through a
   robot you can ask.

The thing it cares about most is **never crying wolf.** A board that shouts all
day is a board nobody reads.

---

## The whole thing in one picture

```
 THE TATTLETALES          THE KITCHEN                        WHAT PEOPLE SEE
 (who tells us things)    (where news gets cooked)

 Meraki  Mist  Aruba ─┐
 SolarWinds           │   ┌─────────┐   ┌───────────┐   ┌──────────────┐
 our own probes       ├──>│ mailbox │──>│ translate │──>│ the rules    │
 Teams  Webex         │   │  (S3)   │   │ + dedupe  │   │ 2 witnesses, │
 Genesys  Bandwidth   │   └─────────┘   └───────────┘   │ family tree  │
 Starlink  Kurmi     ─┘                                 └──────┬───────┘
                                                               │
                                               alarms, incidents
                                                               v
 Helix (the diary) ── "maybe because..." ──────────>┌──────────────────┐
                                                    │    notebook      │
                                                    │   (DynamoDB)     │
                                                    └──┬──────┬─────┬──┘
                                                       │      │     │
                                                    board   robot  daily
                                                    (web)   (AI)   brief
```

---

## 1. Meet the characters

| The thing | It's like... | Its real name |
|---|---|---|
| A building | a building of the school | a `Site`, with a facility code such as `1120` (Houston) |
| Network boxes | a **family tree**: grandma at the top (the core), her children (distribution switches), grandchildren (access switches) and great-grandchildren (wireless access points) | `Device`, with `uplinkDeviceId` pointing at its parent |
| The WAN edge | the school gate to the outside world | a `Device` with role `wan-edge` |
| Meraki, Mist, Aruba Central | babysitters who watch the boxes and keep notes | the vendors' cloud APIs |
| SolarWinds | a guard we hired ourselves, who walks round poking the boxes | Orion, read with fixed SWQL queries |
| Probes | our own eyes | `integrations/probe.ts` |
| Teams, Webex | the phones and video calls | Microsoft Graph, Webex APIs |
| Genesys | the call centre, where the public queues up | Genesys Cloud |
| SBC | the front door between Teams and the phone company | a Session Border Controller |
| Bandwidth | the phone company, standing on the other side of that door | the SIP carrier |
| Starlink | a satellite dish for faraway offices | Lubbock's internet link |
| Kurmi | the list of desk phones | a SOAP API |
| CUCM | the telephone exchange the desk phones plug into | Cisco Unified CM, or Webex Calling Dedicated Instance |
| Helix | the diary of changes people made, and the tickets | BMC Helix |
| Entra | the school register: who works here, and in which building | Microsoft Entra ID |

---

## 2. Listening: getting the news in

We have to **phone** some tattletales every few minutes to ask "anything
new?". That's **polling**. Others **phone us** the moment something happens.
That's a **webhook**.

Anyone could phone us pretending to be Meraki, so a caller must give the
**secret handshake** (an HMAC signature) before we listen to a single word.
If we don't check that first, a stranger could tell us "the broken switch is
fixed now" and quietly close a real problem.

Everything that arrives goes straight into the **mailbox** (S3) exactly as it
came, before we read it, so no letter is ever lost.

We keep a **bookmark** (a watermark) of how far we've read. We move it only
*after* we've written the news down. If we moved it earlier and then tripped,
we would skip a page forever and never know.

Long lists arrive in **pages**. If we stopped at page 3 of 7, the school would
look smaller and calmer than it really is. So one helper (`drainPages`) owns
page-turning, and it always says when it had to stop early.

**In the code:** `integrations/connector.ts` (every source has `poll()` and
`onWebhook()`), `integrations/http.ts` (pages and bookmarks),
`integrations/webhook.ts` (the handshake), `integrations/controller/`
(Meraki, Mist, Aruba).

---

## 3. Translating: one language for everyone

Meraki, Mist and Aruba each describe the same broken port in a different way.
We translate every message into one sentence:

> "At this time, about this box, this thing measured this value, and *this is
> who told us*."

That sentence is an **`Observation`**.

"Who told us" is called the **plane**, and it matters a lot:

| Plane | Means |
|---|---|
| `device` | the box said it about itself |
| `controller` | its babysitter cloud said it |
| `external` | we saw it with our own eyes (a probe) |

**Name tags.** A babysitter knows a box by its serial number or its MAC
address, never by the name painted on it. The **inventory** matches all of a
box's nicknames to its one real id (`resolveDeviceAny`). A nickname that
matches nothing is counted as **inventory drift**: boxes out there that we
don't know about.

**In the code:** `platform/types.ts` (`Observation`, `ObservationPlane`),
`platform/inventory.ts` (the name tags, which is the hard part).

---

## 4. Don't count one tattle twice

Meraki might tell us about a flapping port in a webhook, then tell us again in
the next poll. That's one kid telling the same story twice, not two witnesses.
So matching stories are folded into one (`collapseDuplicates`) before anything
else happens. Skip this step and one flapping port looks like four problems.

**In the code:** `pipeline/steps.ts`, `collapseDuplicates`.

---

## 5. The two-witness rule

If one kid says "the swing is broken", maybe it is, or maybe they're just
grumpy. If a second kid who was standing **somewhere else** saw it too, we
believe them.

So an alarm only **pages** someone when two **different planes** agree. That
could be the box and its cloud, or the cloud and our probe. The box at the far
end of a cable counts as a second witness too.

With only one witness, the alarm is still raised but **held back**. It shows
on the board, and nobody gets woken up.

There's one exception. When a box says "my own power supply died", nobody
else could possibly see that, so it doesn't need a second witness.

**In the code:** `pipeline/steps.ts`, `evaluate`.

---

## 6. The family tree: blame grandma once

If grandma falls over, all her children and grandchildren look as if they've
fallen too, because they can't reach anyone. We don't want fifty pages for one
grandma.

So each alarm climbs its family tree to the **highest relative that is also
alarming**. Everyone who reaches the same grandma becomes **one incident**,
and it's blamed on her.

Why a tree and not "things close together on the map"? Two cousins under the
same broken parent aren't broken *because of each other*; they share a cause.
Being close on a map works both ways, but a family tree has a direction.

Two more rules:
- **Only some kinds of trouble travel down the tree**: a cable going down, a
  box you can't reach, a lost neighbour. A box with dirty ports (interface
  errors) has its own problem and never merges.
- **We wait 10 minutes** for the family to finish falling over, because the
  bad news takes a few minutes to travel down the tree.

**In the code:** `pipeline/steps.ts`, `detectIncidents` and `TOPOLOGY_CAUSED`.
The whole kitchen line is one workflow (AWS Step Functions) in
`pipeline/ingest-workflow.ts` and `state-machine.asl.json`.

---

## 7. The loudspeaker: only big news

Only important news goes on the school **loudspeaker** (the event bus): alarms
and incidents. The thousands of little "port 7 is fine" messages never do.
Otherwise the loudspeaker bill would grow with the size of the school instead
of with the number of problems.

Anyone who wants the news listens to the loudspeaker. **Splunk**, the
customer's big record book, is one listener. The loudspeaker carries a short
**summary** (a projection), not the whole record. A listener that expects the
whole record breaks on every message.

**In the code:** `aws/eventbridge.ts`, `integrations/splunk/`.

---

## 8. The phones side (comms)

This half isn't about boxes; it's about **people and places**. We ask Teams,
Webex, Genesys and Bandwidth what's going on, and we get **signals** about
three kinds of thing:

| Subject | Example |
|---|---|
| a **building** | "calls from Houston sound bad" |
| a **trunk** (an SBC) | "calls through SBC2 keep failing" |
| a **queue** | "people are waiting too long for Eligibility - English" |

The rules, simply:

- **Bad call quality needs two services to agree** (Teams *and* Webex). Teams
  alone might just be one laptop having a bad day.
- **Failing calls and long queues count themselves.** That's the system's own
  tally, so one source is enough.
- **Bandwidth stands on the other side of the SBC's door.** When an SBC dies,
  outside callers fail at the phone company and never reach Teams. Only
  Bandwidth can see them.
- **A desk phone that fell off the exchange makes no calls at all**, so Teams
  and Webex have nothing to judge. Only the exchange (CUCM) knows. We ask it
  about each phone by the name on Kurmi's list, a few requests a minute,
  because the exchange shares that allowance with everyone else.
- **If a source is down, we say "we couldn't ask", never "all fine".**
- **Getting better needs a healthy check-up, not silence.** A dead SBC at 3am
  sends no complaints at all. An incident closes only after **three check-ups
  in a row** actually measured it healthy. If it breaks again within 30
  minutes, it's the same incident coming back, not a new one.
- **"Is this weird for a Tuesday at 9am?"** Unusual-looking numbers
  (anomalies) are compared with the same hour of the week in past weeks, and
  only once there are at least 4 weeks of them. Normal on a Monday morning is
  not normal on a Sunday night.
- **We count people; we never keep names.** The register (Entra) tells us who
  works in which building, so we can say "29 people make calls there". The
  names are thrown away after each check, and only the counts are saved.
- **A backup copy.** Each check's cooked results (signals, alarms, incidents,
  counts, health) are copied to an S3 bucket. A tripwire refuses the whole
  copy if it spots an email address or a phone number.

**In the code:** `integrations/comms/`: `poll.ts` (one check, stage by
stage), `signals.ts`, `lifecycle.ts`, `anomalies.ts`, `workforce.ts`,
`health.ts`, `archive.ts`. The pretend vendors are in `comms/mock/`.

---

## 9. The diary (Helix): "maybe because..."

Helix is the diary where people write things like "I changed the Houston WAN
edge at 2pm". When something breaks, we look in the diary and say "**maybe**
it was this change".

- **Maybe, never proof.** The diary can't page anyone and can't hush anything.
- **If we can't open the diary, we say so.** We never say "nothing was
  changed".
- **Look up the tree, never sideways.** A change on grandma can hurt her
  children. A change on your cousin didn't break you.

**In the code:** `integrations/comms/helix.ts`, `helix-context.ts`,
`ai/itsm-tools.ts`.

---

## 10. The map of who helps whom (the knowledge graph)

This is where the two halves meet. The graph is a map of dots and arrows:

```
 box         ── is in ──────────>  building
 box         ── plugs into ─────>  its parent box
 satellite   ── serves ─────────>  a faraway building
 SBC         ── is plugged into ─> a switch
 phone trunk ── ends at ────────>  an SBC
 queue       ── is staffed from ─> buildings (how many agents in each)
 Helix name  ── is ─────────────>  our thing
```

It holds only **what connects to what**. Incidents stay in their own place,
and there are **no people**, just a count per building.

When Houston's calls sound bad, we follow the arrows to **Houston's own
boxes** and ask whether anything there complained around that time. When SBC2
fails calls, we follow **SBC2's own road**: its switch, up the tree to
grandma, then out through the school gate (the WAN edge). We never check the
switch next door. When a call-centre queue is overwhelmed, we follow it to
the buildings where **at least a fifth of its agents** sit, counting every
agent, including the ones no list can place in a building.

What we find is a **candidate**, meaning "have you looked here?". There are
four possible answers, so that "found nothing" can never be mistaken for
"couldn't look":

| Answer | Means |
|---|---|
| **found** | this is what we found, and the road that connects it |
| **none** | we looked at these 6 boxes and found nothing |
| **no road** | there's nothing to follow; a queue isn't a place on the network |
| **unknown** | the map isn't built, or we couldn't read it |

**In the code:** `src/graph/derive.ts` (draws the map), `store.ts` (keeps
it), `correlate.ts` (walks it).

---

## 11. The notebook and the attic: where things are kept

- **The notebook is DynamoDB.** It holds devices, alarms, incidents, the map
  and the audit log. Every page starts with the customer's name
  (`TENANT#hhs-demo#...`), so one customer can never read another's pages.
  The pages are laid out so that every question is one quick lookup.
- **The attic is S3.** It keeps the raw letters exactly as they arrived, the
  comms backups, and the traffic records (flows). There are far too many flows
  for the notebook, so they're searched with Athena instead.
- **Writing in the notebook takes a moment**, so every write must be waited
  for (`await`). A forgotten wait works fine on a laptop but loses writes on
  AWS, which is why `pnpm check:promises` hunts for them.

**In the code:** `aws/dynamodb.ts` (the notebook, in memory by default),
`aws/dynamodb.sdk.ts` (the real one), `aws/s3.ts`.

---

## 12. The board: what you look at

The board is a web page with a map (React and MapLibre). The clever trick is
that the same kitchen code can cook in **two ovens**:

- **Inside your browser tab.** The whole backend runs right there, which is
  how the demo works without any AWS at all.
- **On AWS Lambda.** The board asks for `GET /board`, `/comms` and `/audit`
  over the internet.

It's the **same recipe** in both (`board-api.ts`), so they can't disagree.
Because the recipe also runs in a browser, it can't use anything that only
exists in Node (`node:fs`, `Buffer`, `process`). One of those anywhere, and
the board is a blank page.

The colours are calm everywhere, and **amber means "look at this"**. Nothing
else is ever amber.

**In the code:** `web/src/`, `web/src/transport/select.ts` (picks the oven),
`src/api/board-api.ts` (the recipe).

---

## 13. Who are you? Signing in

When you sign in (Amazon Cognito), you get a **badge**: an access token. It
says which customer you belong to, your role and, for some people, your site.
Your email's domain decides the customer, and a domain nobody knows signs in
and sees nothing.

- **What you can see comes from the badge, never from what you ask for.** A
  Dallas operator who asks about Austin gets nothing about Austin.
- **Every door checks the badge again: seven checks.** They include who
  issued it, its signature, that it hasn't expired, which app it's for, that
  it's an access badge, and which customer it names. This happens even if the
  gate already checked it.
- **Badges are checked against the real clock**, even though the demo world's
  clock is stuck on 8 September. Otherwise a badge could never expire.

**In the code:** `infra/terraform/auth/`, `src/auth/pre-token-generation.ts`
(it writes the customer onto the badge), `platform/membership.ts`,
`web/src/auth/`.

---

## 14. The helper robot (the AI assistant)

You can ask the robot "why is Houston's call quality bad?". It:

1. **thinks** with a language model: Claude on Amazon Bedrock, or a scripted
   offline stand-in for demos and tests;
2. **uses tools** to find facts, like "list the open incidents", "what serves
   Houston?" or "explain this incident";
3. **answers**, and shows its working, one step at a time.

```
 you (browser) ── your badge ──> the robot (AgentCore Runtime)
                                   │  thinks with Claude (Bedrock)
                                   │  "I need a tool"
                                   v
                                 the front desk (AgentCore Gateway)
                                   │  passes YOUR badge straight through
                                   v
                                 the tool house (MCP server)
                                   │  checks the badge again, writes the logbook
                                   v
                                 the notebook (DynamoDB), read only
```

The safety rules:

- **The tools come from a fixed menu.** The robot picks a tool and fills in
  the blanks. It never writes its own database query or Splunk search,
  because a made-up query is how you trick a robot into doing something bad.
- **It can only read.** It can look but never change anything, and if it asks
  for a tool it wasn't offered, it's refused.
- **It carries *your* badge, not its own.** So it can only ever see what you
  can see.
- **Everything goes in the logbook.** Every tool call is recorded in an audit
  log: who asked, which tool, when, and a **fingerprint** (a hash) of what was
  asked, never the words themselves. Admins can read the logbook on the
  board.
- **It says "candidate" when it means candidate.** A robot repeats what its
  tools tell it with the same confidence, so the tools are careful with their
  words.

**In the code:** `ai/agent-core.ts` (the thinking loop); `ai/tools.ts`,
`comms-tools.ts`, `graph-tools.ts` and `itsm-tools.ts` (the menu);
`ai/tool-provider.ts` (the one way a tool is run); `ai/mcp/` (the tool
house); `ai/audit.ts`; `ai/guardrails.ts`; `infra/terraform/agentcore/`.

---

## 15. The report card (the daily brief)

The brief is one page for the bosses: what's broken, how many people it
affects, and what changed.

- **Every number comes from the notebook**, never from the robot's
  imagination. The words are a fill-in-the-blanks template around the real
  numbers.
- **It's green only if nothing is broken *and* every source answered.**
  "Nothing broken, but Webex didn't answer" is amber, with Webex named.

**In the code:** `src/reporting/daily-brief.ts`.

---

## 16. The magic trick: the same story every time

In the demo world the clock is stuck at 8 September and the dice are loaded (a
seeded random generator). So `pnpm start` tells exactly the same story every
time, and CI compares two runs line by line. That's what makes a screenshot
reproducible and a real change easy to spot.

That's why the code never calls `new Date()` or `Math.random()`: it asks
`platform/clock.ts` and `platform/random.ts` instead. The one exception is the
badge, which is checked against real time (section 13).

**All the data is made up.** A real list of network boxes would be a map of a
real organisation's insides, so nothing real goes in this repo. The vendors
are pretend versions (mocks), built from their published API documentation.

---

## 17. Where it lives on AWS: the LEGO instructions

Terraform files are **LEGO instructions** for AWS. There are several sets on
the shelf, but only two are ever built:

| Set | What it builds |
|---|---|
| `infra/terraform/auth/` | sign-in (Cognito and the badge helper), the list of who belongs to which customer, the notebook (DynamoDB), the board's API (a Lambda behind API Gateway) and the comms backup bucket. It costs pennies. |
| `infra/terraform/agentcore/` | the robot, the tool house and the front desk |

The other sets (`envs/`, `stack/`) show what a full production build would
look like. Building them costs real money every month (the database alone is
about $87 a month even when idle), so they stay in the box.

Deploying goes in this order:
1. build the bundles;
2. apply `auth`;
3. fill the notebook (`pnpm seed:aws`);
4. apply `agentcore`;
5. check it as yourself (`pnpm smoke:aws`).

`docs/13-deploy-and-verify.md` has the details.

---

## Cheat sheet: the rules to remember

1. **Never cry wolf.** One witness is held back, not paged.
2. **Two witnesses means two different places to stand** (planes), not the
   same story told twice.
3. **Blame grandma once**, not every grandchild.
4. **Only big news goes on the loudspeaker.**
5. **Silence isn't "fixed".** A healthy check-up is.
6. **"Couldn't ask" is never "all fine".**
7. **The diary and the map give "maybe" answers**, never proof.
8. **Count people; never keep their names.**
9. **What you can see comes from your badge.**
10. **The robot only reads, and it carries your badge.**
11. **The same story every run.**
12. **Every number in the report comes from data**, never from a model.

---

## Where to go next

| Read | For |
|---|---|
| `docs/00-start-here.md` | running it, and a reading order |
| `docs/01-architecture.md` | the whole system on one page, the grown-up version |
| `docs/10-voice-and-contact-centre.md` | the phones side in detail |
| `docs/11-agentcore.md` | how the robot is hosted |
| `docs/12-ai-orchestration-mcp-knowledge-graph.md` | the robot's tools, the tool house and the map |
| `docs/13-deploy-and-verify.md` | putting it on AWS, and checking it worked |
| `CLAUDE.md` | every rule above, with the reason it exists |
