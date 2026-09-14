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
  // The demo customer, and the reason it runs all three is not laziness: this
  // is what an estate looks like after two acquisitions. Meraki at the edge,
  // Mist on the Austin wireless, Aruba on the Denver access layer, and nobody
  // has had the budget to unify them. It is also the configuration that makes
  // cross-plane corroboration demonstrable, because Meraki alone supplies two
  // planes and the probe supplies the third.
  'acme-networks': ['meraki', 'mist', 'aruba-central'],

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

/**
 * The shared secret each cloud signs its webhooks with.
 *
 * PER TENANT AND PER CONTROLLER, never one global secret. A single shared
 * secret would mean any customer who could read it - or any vendor support
 * engineer who saw it in a Central console - could forge alerts into every
 * other customer's estate. In production these live in Secrets Manager under
 * `netpulse/{tenantId}/{controller}/webhook`, rotated on the vendor's schedule,
 * and the receiver looks one up per delivery rather than holding them in
 * memory.
 *
 * Hard-coded here for the offline demo only, and deliberately obvious about it:
 * a plausible-looking secret in a repository is worse than one that announces
 * itself as fake.
 */
const DEMO_WEBHOOK_SECRETS: Record<string, string> = {
  'acme-networks|meraki': 'demo-only-not-a-real-webhook-secret',
  'acme-networks|aruba-central': 'demo-only-not-a-real-webhook-secret',
  'northwind-utilities|mist': 'demo-only-not-a-real-webhook-secret',
};

export function webhookSecretFor(tenantId: TenantId, controller: ControllerId): string | undefined {
  return DEMO_WEBHOOK_SECRETS[tenantId + '|' + controller];
}

/**
 * Which connector handles a delivery on this controller's endpoint.
 *
 * Takes the tenant as well, so an inbound webhook cannot reach a connector the
 * customer does not run. Without that check the endpoint is an open door into
 * any tenant whose id an attacker can guess.
 */
export function connectorForWebhook(
  tenantId: TenantId, controller: ControllerId,
): Connector | undefined {
  if (!controllersFor(tenantId).includes(controller)) return undefined;
  return connectors.find((c) => c.controller === controller);
}
