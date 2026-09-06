/**
 * The connector registry.
 *
 * One list. The ingest pipeline iterates it; nothing else in the platform ever
 * names a vendor. Onboarding Zonar is: write the file, add it here, ship.
 *
 * PER-TENANT SUBSETS, and why this is not premature generality:
 *
 * A carrier does not run eight telematics vendors. A truck carries one GPS
 * unit, one ELD and usually one dashcam - so a tenant's real integration set is
 * two or three, chosen years ago and painful to change. Different carriers
 * chose differently, and a platform that assumed everyone runs everything would
 * fail on its second customer.
 *
 * Modelling that properly costs one function, `connectorsFor(principal)`, and
 * it buys something the flat list could not: cross-vendor corroboration becomes
 * a claim about *independent hardware on one truck* rather than about "we
 * happen to poll eight APIs".
 *
 * Each connector gets its OWN circuit breaker. A Lytx outage must not stop
 * Samsara position data from flowing - partial data beats no data on a
 * dispatch board.
 */
import type { Principal, ProviderId, TenantId } from '../platform/types.ts';
import type { Connector } from './connector.ts';
import { CircuitBreaker } from './connector.ts';

import { samsara } from './telematics/samsara.ts';
import { geotab } from './telematics/geotab.ts';
import { verizonConnect } from './telematics/verizon-connect.ts';
import { motive } from './eld-hos/motive.ts';
import { omnitracs } from './eld-hos/omnitracs.ts';
import { platformScience } from './eld-hos/platform-science.ts';
import { lytx } from './video-safety/lytx.ts';
import { netradyne } from './video-safety/netradyne.ts';

/** Every connector this platform knows how to speak. */
export const connectors: Connector[] = [
  samsara, geotab, verizonConnect,
  motive, omnitracs, platformScience,
  lytx, netradyne,
];

/**
 * Which vendors each carrier actually runs.
 *
 * In production this is per-tenant configuration in DynamoDB, edited by an
 * onboarding tool. Hard-coding it here keeps the demo readable while preserving
 * the shape of the real thing.
 *
 * Note the deliberate spread: one GPS vendor, one ELD vendor, and - for the
 * carriers that bought cameras - one dashcam vendor.
 */
const TENANT_PROVIDERS: Record<TenantId, ProviderId[]> = {
  // The demo carrier. GPS + ELD + dashcam is the configuration that makes
  // cross-vendor corroboration possible, which is why the demo uses it.
  'acme-freight': ['samsara', 'motive', 'lytx'],

  // A different stack entirely - same platform, no code changes.
  'northstar-logistics': ['geotab', 'omnitracs', 'netradyne'],

  // No dashcams. The safety rules degrade to single-source, which is exactly
  // the situation the corroboration rule has to handle gracefully rather than
  // assume away.
  'pinnacle-transport': ['verizon-connect', 'platform-science'],
};

/** Default for a tenant with no explicit configuration: telematics only. */
const DEFAULT_PROVIDERS: ProviderId[] = ['samsara'];

export function providersFor(tenantId: TenantId): ProviderId[] {
  return TENANT_PROVIDERS[tenantId] ?? DEFAULT_PROVIDERS;
}

/**
 * The connectors to poll for this caller.
 *
 * Takes a `Principal`, not a bare tenant id - same discipline as every
 * repository function. There is no way to ask for "all tenants' connectors"
 * by accident.
 */
export function connectorsFor(principal: Principal): Connector[] {
  const allowed = new Set(providersFor(principal.tenantId));
  return connectors.filter((c) => allowed.has(c.provider));
}

export const breakers = new Map<ProviderId, CircuitBreaker>(
  connectors.map((c) => [c.provider, new CircuitBreaker(c.provider)]),
);

export function connectorFor(provider: ProviderId): Connector {
  const found = connectors.find((c) => c.provider === provider);
  if (!found) throw new Error('no connector registered for ' + provider);
  return found;
}

/**
 * How many of a vendor's calls we are willing to have in flight at once.
 * Feeds the Step Functions Map state's maxConcurrency so our own fan-out
 * cannot rate-limit us.
 */
export function safeConcurrency(c: Connector): number {
  return Math.max(1, Math.min(8, Math.floor(c.rateLimitPerMin / 60)));
}
