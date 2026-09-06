# Python reference implementations

AWS AI/ML and geospatial Lambdas are usually Python. These two files show the
same designs as `src/ai/` and `src/geo/`, written the way they would actually be
deployed: real `boto3` calls, no local stand-ins. The TypeScript versions are
the ones that run offline.

| File | Covers |
|---|---|
| `ai_pipeline/bedrock_agent.py` | Bedrock `InvokeModel`, Knowledge Base `Retrieve`, guardrails, and the agent tool loop that AgentCore hosts for you |
| `geospatial/postgis_lambda.py` | Aurora Data API, `ST_DWithin` / `ST_AsGeoJSON` / `ST_ClusterDBSCAN`, coordinate validation, MapBox style expressions |

**These are read-only reference.** They need `boto3` and real AWS credentials.
The runnable demo is the TypeScript one - `pnpm start` from the repo root - which
executes the same architecture end to end with zero dependencies and no AWS
account.

Read them side by side with their TypeScript counterparts; the comments in each
cover different ground.
