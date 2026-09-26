/**
 * ---------------------------------------------------------------------------
 * The synthetic workforce behind the Teams, Genesys and Webex mocks
 * ---------------------------------------------------------------------------
 * ONE directory, three services. The same person appears in Entra (Teams),
 * in Genesys and in Webex under the same email address, because that is the
 * join the knowledge graph will have to make: none of the three clouds shares
 * an id with the others, and the email is the only handle they have in common.
 * Three independently generated directories would let that join pass by luck
 * or fail by accident, and neither would tell you anything.
 *
 * NOTHING HERE IS REAL. The agencies use `.example` domains (RFC 2606) rather
 * than the customer's, the names come from two short lists, and the facility
 * codes are invented. The shapes of the problems are taken from the
 * discovery notes, because those are what the connectors have to survive:
 *
 *   - The agency is the DOMAIN of the email, and one address in the directory
 *     is upper-cased. A split that forgets to lower-case files that person
 *     under an agency nobody has heard of.
 *   - Most of the contact centre is CONTRACTORS on their own domains. They
 *     belong to no agency, and "unknown domain" must not silently mean
 *     "drop them".
 *   - The facility id lives inside a free-text street address as `LC=NNNN`.
 *     Two people have none and one has it written `LC 0412` - the parse has
 *     to report those rather than invent a facility.
 *   - Entra holds far more accounts than are voice-enabled, and two voice
 *     accounts are RESOURCE accounts (an auto attendant, a call queue), not
 *     people. Counting them as staff inflates every per-agency number.
 *
 * DETERMINISTIC, AND ON ITS OWN SEED. It must not draw from the ambient
 * `random()` - that stream also feeds the estate generator and the uuid
 * source, and pulling from it here would reshuffle the network estate the
 * moment anything imported a mock. See the `loadEstate()` note in CLAUDE.md.
 */
import { seededRandom, type Random } from '../../../platform/random.ts';
import { seededUuid } from '../../../platform/crypto.ts';

export type AgencyId = 'HHSC' | 'DSHS' | 'DFPS';

/** Domain -> agency. The connectors will need this as tenant configuration. */
export const AGENCY_DOMAINS: Record<string, AgencyId> = {
  'hhs.texas.example': 'HHSC',
  'dshs.texas.example': 'DSHS',
  'dfps.texas.example': 'DFPS',
};

export const CONTRACTOR_DOMAINS = ['contact-partner.example', 'staffing-co.example'] as const;

export type Facility = { code: string; name: string; street: string; city: string };

export const FACILITIES: Facility[] = [
  { code: '0412', name: 'Central Office',        street: '100 Example Pkwy',   city: 'Austin' },
  { code: '0417', name: 'North Austin Campus',   street: '2200 Sample Blvd',   city: 'Austin' },
  { code: '1120', name: 'Houston Regional',      street: '48 Placeholder St',  city: 'Houston' },
  { code: '1455', name: 'Dallas Regional',       street: '7 Fixture Ave',      city: 'Dallas' },
  { code: '2031', name: 'El Paso Field Office',  street: '315 Mock Rd',        city: 'El Paso' },
  { code: '3308', name: 'Lubbock Field Office',  street: '90 Synthetic Way',   city: 'Lubbock' },
];

export type Person = {
  /** Stable across every service. NOT a vendor id - each mock mints its own. */
  key: string;
  firstName: string;
  lastName: string;
  /** As the source systems hold it, including the one upper-cased domain. */
  email: string;
  kind: 'employee' | 'contractor';
  agency?: AgencyId;
  /** Undefined for the people the address parse must report as unplaceable. */
  facility?: Facility;
  /** Entra `streetAddress`, with the facility code embedded the way HHS does. */
  streetAddress: string;
  department: string;
  /** Genesys puts an employee number here, as a string. */
  employeeNumber: string;
  inTeams: boolean;
  teamsVoice: boolean;
  inGenesys: boolean;
  genesysActive: boolean;
  inWebex: boolean;
  /** E.164, for anyone with a phone number on any platform. */
  phone?: string;
  ids: {
    entra: string;
    genesys: string;
    webex: string;
  };
};

/** A Teams resource account: voice-enabled, in Entra, and not a person. */
export type ResourceAccount = {
  id: string;
  upn: string;
  displayName: string;
  kind: 'autoAttendant' | 'callQueue';
  phone: string;
};

export type Directory = {
  people: Person[];
  resourceAccounts: ResourceAccount[];
  /** The Entra tenant, the Genesys org and the Webex org the mocks pretend to be. */
  entraTenantId: string;
  genesysOrgId: string;
  webexOrgId: string;
};

const FIRST = [
  'Avery', 'Jordan', 'Morgan', 'Riley', 'Casey', 'Taylor', 'Quinn', 'Rowan',
  'Emerson', 'Hayden', 'Parker', 'Reese', 'Sawyer', 'Skyler', 'Dakota', 'Finley',
  'Harper', 'Kendall', 'Logan', 'Marlowe', 'Oakley', 'Peyton', 'Remy', 'Sage',
];
const LAST = [
  'Alvarez', 'Brennan', 'Castillo', 'Delgado', 'Ellison', 'Fontaine', 'Garrity',
  'Holloway', 'Iverson', 'Jaramillo', 'Kessler', 'Lindqvist', 'Moreau', 'Navarro',
  'Okafor', 'Pellegrino', 'Quintero', 'Rasmussen', 'Salcedo', 'Thibodeaux',
];
const DEPARTMENTS = [
  'Eligibility', 'Intake', 'Provider Relations', 'Benefits', 'Licensing',
  'IT Service Desk', 'Records', 'Field Operations',
];

/** How many people. Large enough that every service paginates at its default size. */
export const DIRECTORY_SIZE = 240;

const SEED = 0x434f4d4d;   // 'COMM'

function pickFrom<T>(rng: Random, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

let cached: Directory | undefined;

/**
 * The directory. Built once and cached, for the same reason `loadEstate()` is:
 * rebuilding would be harmless here only because the seed is private, and
 * relying on that is how the next person breaks it.
 */
export function directory(): Directory {
  if (!cached) cached = build();
  return cached;
}

function build(): Directory {
  const rng = seededRandom(SEED);
  const id = seededUuid(rng);
  const agencies = Object.entries(AGENCY_DOMAINS);

  const people: Person[] = [];
  for (let i = 0; i < DIRECTORY_SIZE; i++) {
    const firstName = pickFrom(rng, FIRST);
    const lastName = pickFrom(rng, LAST);
    // A third of the workforce is contracted, and almost all of it sits in
    // the contact centre - which is why Genesys is mostly contractors.
    const contractor = rng() < 0.3;
    const [agencyDomain, agency] = pickFrom(rng, agencies);
    const domain = contractor ? pickFrom(rng, CONTRACTOR_DOMAINS) : agencyDomain;
    const local = firstName + '.' + lastName + String(10 + Math.floor(rng() * 90));

    const facility = pickFrom(rng, FACILITIES);
    const inTeams = !contractor;
    // Roughly half of Entra is voice-enabled. The rest must be filtered out
    // before anything counts per-agency phone users.
    const teamsVoice = inTeams && rng() < 0.55;
    const inGenesys = contractor || rng() < 0.25;
    // DSHS runs Webex Calling alongside Teams; a few HHSC staff do too.
    const inWebex = !contractor && (agency === 'DSHS' ? rng() < 0.8 : rng() < 0.12);

    people.push({
      key: 'p' + String(i).padStart(3, '0'),
      firstName,
      lastName,
      email: local + '@' + domain,
      kind: contractor ? 'contractor' : 'employee',
      agency: contractor ? undefined : agency,
      facility,
      streetAddress: facility.street + ' LC=' + facility.code,
      department: pickFrom(rng, DEPARTMENTS),
      employeeNumber: String(200000 + Math.floor(rng() * 99999)),
      inTeams,
      teamsVoice,
      inGenesys,
      genesysActive: rng() < 0.92,
      inWebex,
      phone: teamsVoice || inWebex || inGenesys
        ? '+1512555' + String(1000 + i).slice(-4)
        : undefined,
      ids: { entra: id(), genesys: id(), webex: id() },
    });
  }

  plantEdgeCases(people);

  return {
    people,
    resourceAccounts: [
      {
        id: id(), upn: 'aa-main-line@hhs.texas.example', displayName: 'Main Line Auto Attendant',
        kind: 'autoAttendant', phone: '+15125550100',
      },
      {
        id: id(), upn: 'cq-it-service-desk@hhs.texas.example', displayName: 'IT Service Desk Queue',
        kind: 'callQueue', phone: '+15125550101',
      },
    ],
    entraTenantId: id(),
    genesysOrgId: id(),
    webexOrgId: id(),
  };
}

/**
 * The deliberate traps, placed by index rather than left to the seed, so a
 * change to the generator cannot quietly stop producing them.
 */
function plantEdgeCases(people: Person[]): void {
  const employees = people.filter((p) => p.kind === 'employee' && p.inTeams);

  // An upper-cased domain. Genesys and Entra both preserve whatever case the
  // account was created with.
  const shouty = employees[3];
  shouty.email = shouty.email.replace(/@.*$/, (d) => d.toUpperCase());
  shouty.inGenesys = true;

  // No facility code at all.
  for (const p of [employees[7], employees[19]]) {
    p.facility = undefined;
    p.streetAddress = FACILITIES[0].street;
  }

  // A malformed code: a human typed a space instead of '='.
  const typo = employees[11];
  typo.facility = undefined;
  typo.streetAddress = FACILITIES[0].street + ' LC 0412';
  typo.teamsVoice = true;
  typo.phone ??= '+15125559999';
}

/** The agency for an email, the way the connectors will have to derive it. */
export function agencyOf(email: string): AgencyId | 'contractor' | undefined {
  const domain = email.slice(email.indexOf('@') + 1).toLowerCase();
  if (domain in AGENCY_DOMAINS) return AGENCY_DOMAINS[domain];
  if ((CONTRACTOR_DOMAINS as readonly string[]).includes(domain)) return 'contractor';
  return undefined;
}

/** `LC=NNNN` out of a street address, or undefined. Deliberately strict. */
export function facilityCodeOf(streetAddress: string | null | undefined): string | undefined {
  const m = /\bLC=(\d{4})\b/.exec(streetAddress ?? '');
  return m ? m[1] : undefined;
}

/** For the tests and the activity generator: a stable, private stream per use. */
export function streamFor(label: string, anchor = 0): Random {
  let h = SEED ^ anchor;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193);
  return seededRandom(h >>> 0);
}
