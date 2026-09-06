/**
 * ---------------------------------------------------------------------------
 * NetPulse domain model
 * ---------------------------------------------------------------------------
 * The whole platform is an ETL + AI loop over one idea:
 *
 *   third-party API  ->  RawRecord  ->  Signal  ->  Incident  ->  Agent answer
 *
 * `Signal` is the *canonical* shape. Cisco, Genesys and Splunk all speak
 * different dialects; every connector's job is to translate into `Signal` so
 * that the rest of the platform (GraphQL, the AI agent, the map) only ever has
 * to understand ONE schema. That single normalisation step is what makes the
 * "centralised reporting view" in the JD's 1-2 month target possible.
 *
 * Note the `tenantId` on literally everything. In a multi-tenant SaaS the
 * tenant is not a filter you remember to add - it is part of the identity of
 * every record and the partition key of every query. See platform/tenancy.ts.
 */

/** Opaque-ish branded IDs keep you from passing a siteId where a tenantId goes. */
export type TenantId = string;
export type SiteId = string;
export type SignalId = string;
export type IncidentId = string;

export type ProviderId =
  | 'cisco-meraki'
  | 'juniper-mist'
  | 'aruba-central'
  | 'genesys-cloud'
  | 'five9'
  | 'amazon-connect'
  | 'thousandeyes'
  | 'splunk';

export type ProviderDomain = 'network' | 'contact-center' | 'observability';

export type Severity = 'ok' | 'info' | 'warning' | 'critical';

/** What a metric measures - drives units, thresholds and how the agent talks. */
export type SignalKind =
  | 'device-health'      // uptime / CPU / packet loss on a switch or AP
  | 'wan-latency'        // ms between two points
  | 'packet-loss'        // percent
  | 'queue-wait'         // contact-centre seconds in queue
  | 'abandon-rate'       // percent of callers who hung up
  | 'agent-occupancy'    // percent
  | 'error-rate'         // percent of failed requests
  | 'log-volume';        // events per minute

/** Exactly what came back from the vendor, before we touched it. Lands in S3. */
export type RawRecord = {
  tenantId: TenantId;
  provider: ProviderId;
  fetchedAt: string;          // ISO-8601
  /** Vendor-native payload. Deliberately `unknown` - nobody may read it except
   *  that provider's own normalise() function. */
  payload: unknown;
};

/** The canonical measurement. Everything downstream reads this and only this. */
export type Signal = {
  tenantId: TenantId;
  signalId: SignalId;
  provider: ProviderId;
  domain: ProviderDomain;
  kind: SignalKind;
  siteId: SiteId;
  /** Vendor's own id for the thing (device serial, queue id, test id). */
  sourceRef: string;
  value: number;
  unit: 'ms' | 'percent' | 'count' | 'seconds';
  severity: Severity;
  observedAt: string;         // ISO-8601, from the vendor's clock
  /** Filled in by the geo-enrichment step - see pipeline/03-geo-enrich.ts */
  location?: { lon: number; lat: number; region: string };
  attributes: Record<string, string | number | boolean>;
};

/** A correlated cluster of bad signals. This is what humans get paged about. */
export type Incident = {
  tenantId: TenantId;
  incidentId: IncidentId;
  title: string;
  severity: Severity;
  status: 'open' | 'acknowledged' | 'resolved';
  siteIds: SiteId[];
  signalIds: SignalId[];
  openedAt: string;
  /** Written by the Bedrock agent, not by a human. */
  aiSummary?: string;
  aiCitations?: Array<{ source: string; snippet: string }>;
};

/** A physical place. Lives in Aurora PostGIS; cached in DynamoDB. */
export type Site = {
  tenantId: TenantId;
  siteId: SiteId;
  name: string;
  region: string;
  lon: number;
  lat: number;
  /** Employees on site - used to weight incident severity. */
  headcount: number;
};

/** The identity the rest of the code trusts, produced by verifying a JWT. */
export type Principal = {
  sub: string;
  email: string;
  tenantId: TenantId;
  /** Roles come from Cognito groups, mapped from SAML/OIDC claims upstream. */
  roles: Array<'admin' | 'operator' | 'viewer'>;
  /** Which IdP the user actually came from - useful for audit + debugging. */
  identityProvider: 'cognito' | 'Google' | 'Facebook' | 'SignInWithApple' | 'AcmeSAML' | 'OktaOIDC';
};
