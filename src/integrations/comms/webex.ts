/**
 * Webex Calling users.
 *
 * `callingData=true` IS NOT OPTIONAL: without it Webex omits `locationId`,
 * and every user comes back with no location and nothing errors - the same
 * silent shape as Graph's `$select`.
 *
 * The facility is the Webex Calling LOCATION, mapped through a table the
 * tenant maintains, because location names are admin-typed and inconsistent
 * ("HOU-1120 Houston Regional", "Lubbock"). Parsing a code out of the name
 * would work for some and invent a facility for others. A location missing
 * from the table is reported by name so someone can add it.
 */
import type { CommsClient, Drained } from './client.ts';
import { drainWebex } from './client.ts';
import { assignAgency } from './classify.ts';
import type { CommsAccount, CommsTenantConfig } from './types.ts';

type WebexPersonRow = {
  id: string;
  emails: string[];
  displayName: string;
  status: string;
  phoneNumbers: Array<{ type: string; value: string }>;
  locationId?: string;
};

type WebexLocationRow = { id: string; name: string };

export type WebexRaw = { people: Drained<WebexPersonRow>; locations: Drained<WebexLocationRow> };

export async function pullWebex(client: CommsClient): Promise<WebexRaw> {
  const w = client.endpoints.webexApi;
  const people = await drainWebex<WebexPersonRow>(client, w + '/people?callingData=true&max=1000');
  const locations = await drainWebex<WebexLocationRow>(client, w + '/locations?max=1000');
  return { people, locations };
}

export function normaliseWebex(raw: WebexRaw, config: CommsTenantConfig): {
  accounts: CommsAccount[];
  /** Location names the tenant table does not map. Someone has to add them. */
  unmappedLocations: string[];
} {
  const locations = new Map(raw.locations.rows.map((l) => [l.id, l.name]));
  const unmapped = new Set<string>();

  const accounts = raw.people.rows.map((p): CommsAccount => {
    // `emails` is an array; the first is the primary, and the only one Webex
    // currently allows for a person.
    const email = p.emails[0] ?? '';
    const locationName = p.locationId ? locations.get(p.locationId) : undefined;
    const code = locationName ? config.webexLocationFacility[locationName] : undefined;
    if (locationName && !code) unmapped.add(locationName);

    return {
      source: 'webex',
      sourceUserId: p.id,
      email,
      emailKey: email.toLowerCase(),
      displayName: p.displayName,
      agency: assignAgency(email, config),
      kind: 'person',
      voice: p.phoneNumbers.length > 0,
      active: p.status !== 'inactive',
      ...(code
        ? { facility: { code, source: 'webex-location' as const } }
        : { unplaced: locationName ? 'unmapped-webex-location' as const : 'no-webex-location' as const }),
    };
  });

  return { accounts, unmappedLocations: [...unmapped].sort() };
}
