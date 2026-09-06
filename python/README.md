# Python reference implementations

The JD lists **Python and/or TypeScript**, and in practice AWS AI/ML and
geospatial Lambdas are usually Python. These two files show the same designs as
`src/ai/` and `src/geo/`, written the way you would actually deploy them: real
`boto3` calls, no local fakes.

| File | Covers |
|---|---|
| `ai_pipeline/bedrock_agent.py` | Bedrock `InvokeModel`, Knowledge Base `Retrieve`, guardrails, and the agent tool loop that AgentCore hosts for you |
| `geospatial/postgis_lambda.py` | Aurora Data API, `ST_DWithin` / `ST_AsGeoJSON` / `ST_ClusterDBSCAN`, coordinate validation, MapBox style expressions |

**These are read-only reference.** They need `boto3` and real AWS credentials.
The runnable demo is the TypeScript one - `npm start` from the repo root - which
executes the same architecture end to end with zero dependencies and no AWS
account.

Read them side by side with their TypeScript counterparts; the comments in each
cover different ground.
