# Deploy and verify: the order, and how to know each step worked

What is built reaches AWS in a fixed order, and each step can fail in a way
that looks like success somewhere else: a new Lambda over an old table, or a
new table behind an old Lambda. This page is the order, plus
`pnpm smoke:aws`, which checks the deployed path **as you**, using your own
token - and, when something is behind, says WHICH half and the command that
fixes it.

## Before you start

- AWS credentials in the shell (`AWS_PROFILE`, or SSO), for the account that
  holds both Terraform roots.
- A board you can sign in to (`pnpm web`), because the smoke test needs your
  access token.

## The order

| # | Step | Command | Proved by `pnpm smoke:aws` |
|---|---|---|---|
| 1 | The deploy policy gets the Gateway actions | see below | the `agentcore` apply succeeding |
| 2 | Build what ships | `pnpm build:lambda && pnpm build:agent` | nothing yet: this only writes `.build/` |
| 3 | The board API: `GET /audit`, the HHS estate, candidate causes; and the table's TTL | `terraform -chdir=infra/terraform/auth apply` | `board API: GET /board`, `GET /audit` |
| 4 | The knowledge graph in DynamoDB, the queue staffing and CUCM readings it is built from, and the comms poll's backup in S3 | `TABLE_NAME=$(terraform -chdir=infra/terraform/auth output -raw main_table_name) COMMS_ARCHIVE_BUCKET=$(terraform -chdir=infra/terraform/auth output -raw comms_archive_bucket) pnpm seed:aws` | `GET /comms + candidate causes` (Houston's top candidate is `wan-hou01-02`); `graph: a failing trunk …`, `graph: an overwhelmed queue …`, `comms: desk-phone registration (CUCM)`; the seed prints `comms archive: 5 objects … -> s3://…` |
| 5 | The Gateway, the MCP server's graph tools, and the agent pointed at the Gateway | `terraform -chdir=infra/terraform/agentcore apply` | `MCP via Gateway` ×2, `Agent on AgentCore` |
| 6 | Everything, as you | `pnpm smoke:aws` | all PASS |

**Step 1**, the deploy policy (an IAM change, so yours to run):

```bash
aws iam create-policy-version \
  --policy-arn arn:aws:iam::588651260734:policy/NetpulseAgentCoreDeploy \
  --policy-document file://infra/terraform/agentcore/deploy-policy.json --set-as-default
```

IAM keeps five versions of a policy. If it refuses because the limit is
reached, delete the oldest non-default version first
(`aws iam delete-policy-version --version-id v1 ...`).

**Step 4 is re-runnable.** The eight-week baseline backfill it did before is
recorded and skipped. The graph rebuild overwrites by key and removes only
what the sources dropped.

**Step 5: no gateway-only lock.** An earlier version also locked the MCP
runtime to the Gateway. That can't work while the Gateway passes the user's
token through, and it took the assistant down ("Transaction token
required"). `docs/12` explains why.

## Running the smoke test

It needs your **access** token. The token lives an hour and the script never
prints it:

1. Sign in to the board.
2. In the browser's dev tools console, run
   `copy(sessionStorage.getItem("netpulse.session"))`.
3. Put the token in your shell. In PowerShell: `$env:NETPULSE_TOKEN = "<paste>"`.
   In Git Bash: `export NETPULSE_TOKEN="<paste>"`.
4. Run `pnpm smoke:aws`.

It reads the endpoints from what the deploy already wrote: the board API and
agent from `web/.env.cognito.local`, and the Gateway and MCP runtime from the
`agentcore` root's outputs. A check whose piece isn't deployed yet is
**SKIP**, not FAIL. Every FAIL names the command that fixes it.

Example output once everything is deployed:

```
Token: tenant hhs-demo, groups [admin], access token, 52 min left

PASS  board API: GET /board
      7 sites: dal-01, aus-01, hou-01, aus-02, elp-01, lbb-01, adc-01
PASS  board API: GET /comms + candidate causes
      Houston: top candidate wan-hou01-02
PASS  graph: a failing trunk follows its SBC's path
      sbc2: top candidate acc-adc01-05
PASS  graph: an overwhelmed queue follows its staffing
      "Eligibility - English": top candidate wan-hou01-02
PASS  comms: desk-phone registration (CUCM)
      desk phones dropping at LC=2031, from the call control alone
PASS  board API: GET /audit
      40 recent calls, 40 recorded by the MCP server
PASS  MCP via Gateway: tools/list
      13 tools (3/3 graph tools); Mcp-Session-Id came back through the gateway
PASS  MCP via Gateway: tools/call explainIncident
      CANDIDATE (not evidence) wan-hou01-02 (wan-edge): Interface errors, ...
PASS  Agent on AgentCore: tools over MCP via Gateway
      answered (offline), tools over MCP via Gateway
```

One line settles an open question from `docs/12`: **`Mcp-Session-Id …
came back`** says whether the Gateway forwards the session header to a
Runtime target. If it didn't, the check still passes, because our MCP
server keeps no session state; every call just starts cold.

## Undoing it

| Want | Set, then apply `agentcore` |
|---|---|
| The agent calls the MCP runtime directly again, with no Gateway and no lock | `mcp_via_gateway = false` |
| The agent runs its tools inside itself, as before MCP | `use_mcp_tools = false` |

Both variables are in `infra/terraform/agentcore/variables.tf`. Each fallback
path sets its environment variables only when they have values, so turning
something off never depends on an empty value being accepted.
