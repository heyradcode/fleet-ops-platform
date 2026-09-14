/**
 * The controller registry.
 *
 * One list. The ingest pipeline iterates it; nothing else in the platform ever
 * names a controller. Onboarding a fourth is: write the file, add it here, ship.
 *
 * PER-TENANT SUBSETS, and why this is not premature generality:
 *
 * An enterprise does not run all three cloud controllers. Which one it runs was
 * decided by whoever bought the switches, years ago, and is painful to change.
 * Some run two - Meraki at the branches and Central on campus, after an
 * acquisition. Some run none at all and manage everything on-box. A platform
 * that assumed everyone runs everything would fail on its second customer.
 *
 * Modelling that properly costs one function, `connectorsFor(principal)`, and
 * it buys something the flat list could not: it makes the corroboration rule
 * honest. A tenant with no controller has only the device plane, and the rule
 * has to degrade gracefully rather than assume a second witness that is never
 * coming. `orbital-health` below exists to keep us honest about that.
 *
 * Each connector gets its OWN circuit breaker. A Central outage must not stop
 * Meraki data from flowing - partial data beats no data on an operations board.
 */
import type { Principal, TenantId } from '../../platform/types.ts';
import type { Connector, ControllerId } from '../connector.ts';
import { CircuitBreaker } from '../connector.ts';

import { meraki } from './meraki.ts';
import { mist } from './mist.ts';
import { arubaCentral } from './aruba-central.ts';

/** Every controller this platform knows how to poll. */
export const connectors: Connector[] = [meraki, mist, arubaCentral];

/**
 * Which controllers each customer actually runs.
 *
 * In production this is per-tenant configuration in DynamoDB, edited by an
 * onboarding tool. Hard-coding it here keeps the demo readable while preserving
 * the shape of the real thing.
 */
const TENANT_CONTROLLERS: Record<TenantId, ControllerId[]> = {
  // The demo customer. A mixed estate - Cisco switching with Meraki at the
  // edge, Aruba on the access layer - which is the configuration that makes
  // cross-plane corroboration demonstrable, and why the demo uses it.
  'acme-networks': ['meraki', 'aruba-central'],

  // A different stack entirely - same platform, no code changes.
  'northwind-utilities': ['mist'],

  // No cloud controller. Everything is managed on-box, so the ONLY plane
  // available is what the devices say about themselves. The corroboration rule
  // has to handle this gracefully rather than assume it away - see
  // pipeline/steps.ts, where single-plane alarms are raised but held back from
  // paging unless the kind is exempt.
  'orbital-health': [],
};

/** Default for a tenant with no explicit configuration: no controller. */
const DEFAULT_CONTROLLERS: ControllerId[] = [];

export function controllersFor(tenantId: TenantId): ControllerId[] {
  return TENANT_CONTROLLERS[tenantId] ?? DEFAULT_CONTROLLERS;
}

/**
 * The connectors to poll for this caller.
 *
 * Takes a `Principal`, not a bare tenant id - same discipline as every
 * repository function. There is no way to ask for "all tenants' connectors"
 * by accident.
 */
export function connectorsFor(principal: Principal): Connector[] {
  const allowed = new Set(controllersFor(principal.tenantId));
  return connectors.filter((c) => allowed.has(c.controller));
}

export const breakers = new Map<ControllerId, CircuitBreaker>(
  connectors.map((c) => [c.controller, new CircuitBreaker(c.controller)]),
);
