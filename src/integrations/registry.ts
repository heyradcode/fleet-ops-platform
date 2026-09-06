/**
 * The connector registry.
 *
 * One list. The ingest pipeline iterates it; nothing else in the platform ever
 * names a vendor. Onboarding Fortinet is: write the file, add it here, ship.
 *
 * Each connector gets its OWN circuit breaker. A Splunk outage must not stop
 * Meraki data from flowing - partial data beats no data in an ops dashboard.
 */
import type { ProviderId } from '../platform/types.ts';
import type { Connector } from './connector.ts';
import { CircuitBreaker } from './connector.ts';

import { ciscoMeraki } from './network/cisco-meraki.ts';
import { juniperMist } from './network/juniper-mist.ts';
import { arubaCentral } from './network/aruba-central.ts';
import { genesysCloud } from './contact-center/genesys.ts';
import { five9 } from './contact-center/five9.ts';
import { amazonConnect } from './contact-center/amazon-connect.ts';
import { thousandEyes } from './observability/thousandeyes.ts';
import { splunk } from './observability/splunk.ts';

export const connectors: Connector[] = [
  ciscoMeraki, juniperMist, arubaCentral,
  genesysCloud, five9, amazonConnect,
  thousandEyes, splunk,
];

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
