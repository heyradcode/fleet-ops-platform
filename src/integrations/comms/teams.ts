/**
 * Microsoft Teams Voice users, via Graph.
 *
 * TWO CALLS, JOINED BY ENTRA OBJECT ID, because neither holds everything:
 *
 *   /admin/teams/userConfigurations   who is voice-enabled, and their number
 *   /users?$select=...streetAddress   where they sit (LC=NNNN in the address)
 *
 * The first is FILTERED at the source to `isEnterpriseVoiceEnabled eq true`.
 * Entra holds ~75,000 accounts at this customer and most are not phone users;
 * pulling them all to filter locally costs ~75 pages a run against a
 * throttled API, for rows that are then thrown away.
 *
 * The second is the expensive one and the known gap. `/users` has no voice
 * flag to filter on, so a full pull is 75,000 rows - about 76 pages of 999,
 * which is PAST `MAX_PAGES_PER_RUN` and would come back `truncated`. The
 * production answer is a `/users/delta` query: one full sync, then only
 * changes. The mock does not model delta yet, so this pulls the whole list
 * and surfaces `truncated` rather than hiding it.
 *
 * `$select` IS NOT OPTIONAL. Graph's default property set omits
 * `streetAddress`, so without it every user comes back unplaced and nothing
 * errors.
 */
import type { CommsClient, Drained } from './client.ts';
import { drainGraph } from './client.ts';
import { assignAgency, facilityFromAddress } from './classify.ts';
import type { CommsAccount, CommsTenantConfig, UnplacedReason } from './types.ts';

type UserConfigurationRow = {
  id: string;
  userPrincipalName: string;
  accountType: string;
  isEnterpriseVoiceEnabled: boolean;
  telephoneNumbers: Array<{ telephoneNumber: string; assignmentCategory: string }>;
};

type EntraUserRow = {
  id: string;
  userPrincipalName: string;
  mail: string | null;
  displayName: string;
  streetAddress: string | null;
};

export type TeamsRaw = {
  configurations: Drained<UserConfigurationRow>;
  users: Drained<EntraUserRow>;
};

export async function pullTeams(client: CommsClient): Promise<TeamsRaw> {
  const g = client.endpoints.graph;
  const configurations = await drainGraph<UserConfigurationRow>(client,
    g + '/admin/teams/userConfigurations?$filter=' +
    encodeURIComponent('isEnterpriseVoiceEnabled eq true') + '&$top=999');
  const users = await drainGraph<EntraUserRow>(client,
    g + '/users?$select=id,userPrincipalName,mail,displayName,streetAddress&$top=999');
  return { configurations, users };
}

/**
 * Where Entra places each person, keyed by lower-cased UPN - for EVERY Entra
 * user, not only the voice-enabled ones.
 *
 * This is why the full `/users` pull is worth its cost. A Genesys agent or a
 * Webex user who has no Teams phone is still an Entra user with an address,
 * and without this they would be unplaceable for no reason but which phone
 * system their agency happened to buy.
 */
export type EntraPlacement = Map<string, { code: string } | { unplaced: UnplacedReason }>;

/** Pure. Raw Graph rows -> accounts and placement. Replayable over archived pages. */
export function normaliseTeams(raw: TeamsRaw, config: CommsTenantConfig): {
  accounts: CommsAccount[];
  placement: EntraPlacement;
} {
  const users = new Map(raw.users.rows.map((u) => [u.id, u]));
  const placement: EntraPlacement = new Map(
    raw.users.rows.map((u) => [u.userPrincipalName.toLowerCase(), facilityFromAddress(u.streetAddress)]));

  const accounts = raw.configurations.rows
    .filter((c) => c.isEnterpriseVoiceEnabled)
    .map((c): CommsAccount => {
      const user = users.get(c.id);
      // The UPN is the sign-in name; `mail` can differ, and is null on
      // resource accounts. The UPN is what Genesys and Webex usernames match.
      const email = c.userPrincipalName;
      const resource = c.accountType === 'resourceAccount';
      const place = facilityFromAddress(user?.streetAddress);
      return {
        source: 'teams',
        sourceUserId: c.id,
        email,
        emailKey: email.toLowerCase(),
        displayName: user?.displayName ?? email,
        agency: assignAgency(email, config),
        kind: resource ? 'resource' : 'person',
        voice: true,
        active: true,
        ...(resource ? {}
          : 'code' in place
            ? { facility: { code: place.code, source: 'entra-street-address' as const } }
            : { unplaced: place.unplaced }),
      };
    });

  return { accounts, placement };
}
