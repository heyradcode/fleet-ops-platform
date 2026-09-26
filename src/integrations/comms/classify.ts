/**
 * The two classifications every comms account goes through: which agency,
 * and which facility. Shared by all three normalisers so they cannot drift -
 * one lower-casing the domain and another not is precisely how one person
 * becomes two agencies.
 */
import type { AgencyAssignment, CommsTenantConfig, UnplacedReason } from './types.ts';

/**
 * Agency from the email domain.
 *
 * LOWER-CASED FIRST. Genesys and Entra keep whatever case the account was
 * created with, and the customer's own data has an agency domain in capitals.
 * Without this, that person is an `unknown` domain nobody can explain.
 */
export function assignAgency(email: string, config: CommsTenantConfig): AgencyAssignment {
  const domain = email.slice(email.lastIndexOf('@') + 1).trim().toLowerCase();
  const agency = config.agencyDomains[domain];
  if (agency) return { kind: 'agency', agency };
  if (config.contractorDomains.includes(domain)) return { kind: 'contractor', domain };
  return { kind: 'unknown', domain };
}

/**
 * The facility code embedded in an Entra street address as `LC=NNNN`.
 *
 * STRICT, and reports why it failed. A lenient parse that also accepted
 * `LC 0412` would be right for that one typo and wrong for the next one it
 * guessed at; a person reported as unplaced gets fixed at source, a person
 * silently placed in the wrong building does not.
 */
export function facilityFromAddress(
  address: string | null | undefined,
): { code: string } | { unplaced: UnplacedReason } {
  const text = address ?? '';
  const m = /\bLC=(\d{4})\b/.exec(text);
  if (m) return { code: m[1] };
  return /\bLC\b/i.test(text) ? { unplaced: 'malformed-facility-code' } : { unplaced: 'no-facility-code' };
}

export function describeAgency(a: AgencyAssignment): string {
  switch (a.kind) {
    case 'agency': return a.agency;
    case 'contractor': return 'contractor (' + a.domain + ')';
    case 'unknown': return 'unknown (' + a.domain + ')';
  }
}
