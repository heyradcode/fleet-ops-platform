/**
 * ---------------------------------------------------------------------------
 * The communications sources: the canonical shapes
 * ---------------------------------------------------------------------------
 * Teams, Genesys and Webex are not network clouds, and their first product is
 * not an Observation. It is a WORKFORCE: who has a phone on which platform,
 * which agency they belong to, and which building they sit in. Every later
 * question - "is the Houston call quality problem one site or three
 * agencies?" - is a join against that, so it comes first.
 *
 * WHY NOT THE NETWORK `Observation`: that type is keyed on a DeviceId and a
 * vendor of `cisco | juniper | aruba`, and its whole machinery - the plane,
 * the dedupe key, the topology merge - is about boxes on a network. A person
 * is not a device, and forcing one into that shape would put a fake DeviceId
 * into every alarm and incident downstream. The call-quality and queue
 * SIGNALS will need a canonical shape too; that is a separate decision, made
 * when there is a rule that consumes them.
 */
import type { TenantId } from '../../platform/types.ts';

export type CommsSource = 'teams' | 'genesys' | 'webex';

export const COMMS_SOURCES: readonly CommsSource[] = ['teams', 'genesys', 'webex'];

/** The agency split, per the customer: an agency, a contractor, or unknown. */
export type AgencyAssignment =
  | { kind: 'agency'; agency: string }
  | { kind: 'contractor'; domain: string }
  /** A domain the tenant configuration does not list. Counted and NAMED, never dropped. */
  | { kind: 'unknown'; domain: string };

/**
 * Where a facility code came from. Recorded because the sources disagree
 * sometimes, and "which one did we believe" is the first question asked.
 */
export type FacilitySource = 'entra-street-address' | 'webex-location';

/** Why an account could not be placed at a facility. */
export type UnplacedReason =
  | 'no-facility-code'         // Entra address has no LC= at all
  | 'malformed-facility-code'  // something LC-like that is not LC=NNNN
  | 'no-webex-location'        // Webex Calling user with no location
  | 'unmapped-webex-location'  // a location the tenant table does not know
  | 'no-facility-source'       // e.g. Genesys: the platform holds none
  | 'directory-sync-incomplete' // the first Entra sync has not finished yet
  | 'not-in-directory';        // a Teams account Entra's directory does not list

/** One account on one platform, normalised. Pure output of a normaliser. */
export type CommsAccount = {
  source: CommsSource;
  /** The platform's own id. Never a join key across platforms. */
  sourceUserId: string;
  /** As the platform holds it - case preserved, for display and audit. */
  email: string;
  /** Lower-cased. THE cross-platform join key; see workforce.ts. */
  emailKey: string;
  displayName: string;
  agency: AgencyAssignment;
  /** A person, or a Teams resource account (auto attendant, call queue). */
  kind: 'person' | 'resource';
  /** Voice-enabled on this platform. Teams users without it are filtered upstream. */
  voice: boolean;
  active: boolean;
  facility?: { code: string; source: FacilitySource };
  unplaced?: UnplacedReason;
};

/**
 * Per-tenant configuration for the comms sources.
 *
 * In production this lives with the rest of the tenant's onboarding config;
 * here it is a constant in config.ts. What matters is that NONE of it is
 * inferred - the customer decides which domains are which agency, and a
 * domain nobody listed is reported rather than guessed at.
 */
export type CommsTenantConfig = {
  tenantId: TenantId;
  /** Which of the three this customer runs. */
  sources: CommsSource[];
  /** Email domain (lower-case) -> agency. */
  agencyDomains: Record<string, string>;
  /** Known contractor domains. Reported per domain; the customer can roll them up. */
  contractorDomains: string[];
  /**
   * Webex Calling location -> facility code, keyed by location NAME.
   *
   * By name here because the mock's ids are generated. In production key it by
   * location id: names are edited by admins, and a rename would silently
   * un-place every user at that site.
   */
  webexLocationFacility: Record<string, string>;
};
