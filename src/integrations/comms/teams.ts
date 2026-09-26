/**
 * Microsoft Teams Voice users, via Graph.
 *
 * `/admin/teams/userConfigurations`, FILTERED at the source to
 * `isEnterpriseVoiceEnabled eq true`. Entra holds ~75,000 accounts at this
 * customer and most are not phone users; pulling them all to filter locally
 * costs ~75 pages a run against a throttled API, for rows that are then
 * thrown away.
 *
 * WHERE THEY SIT comes from the synced Entra directory (entra-directory.ts),
 * keyed by object id - not from a `/users` listing here. That listing was 76
 * pages of 999 at this customer, past the per-run page ceiling, so it came
 * back truncated on every poll. The delta sync reads the directory once and
 * then only its changes.
 */
import type { CommsClient, Drained } from './client.ts';
import { drainGraph } from './client.ts';
import { assignAgency } from './classify.ts';
import type { EntraDirectoryView } from './entra-directory.ts';
import type { CommsAccount, CommsTenantConfig } from './types.ts';

type UserConfigurationRow = {
  id: string;
  userPrincipalName: string;
  accountType: string;
  isEnterpriseVoiceEnabled: boolean;
  telephoneNumbers: Array<{ telephoneNumber: string; assignmentCategory: string }>;
};

export type TeamsRaw = { configurations: Drained<UserConfigurationRow> };

export async function pullTeams(client: CommsClient): Promise<TeamsRaw> {
  const configurations = await drainGraph<UserConfigurationRow>(client,
    client.endpoints.graph + '/admin/teams/userConfigurations?$filter=' +
    encodeURIComponent('isEnterpriseVoiceEnabled eq true') + '&$top=999');
  return { configurations };
}

/** Pure. Raw Graph rows plus the directory -> accounts. Replayable over archived pages. */
export function normaliseTeams(
  raw: TeamsRaw, config: CommsTenantConfig, directory: EntraDirectoryView,
): CommsAccount[] {
  return raw.configurations.rows
    .filter((c) => c.isEnterpriseVoiceEnabled)
    .map((c): CommsAccount => {
      // The UPN is the sign-in name, and what Genesys and Webex usernames match.
      const email = c.userPrincipalName;
      const resource = c.accountType === 'resourceAccount';
      const place = directory.placementById(c.id);
      return {
        source: 'teams',
        sourceUserId: c.id,
        email,
        emailKey: email.toLowerCase(),
        // Names are not read from the directory any more - it stores none.
        // The UPN is enough to act on, and nothing downstream persists it.
        displayName: email,
        agency: assignAgency(email, config),
        kind: resource ? 'resource' : 'person',
        voice: true,
        active: true,
        ...(resource ? {}
          : place && 'code' in place
            ? { facility: { code: place.code, source: 'entra-street-address' as const } }
            : {
              unplaced: place && 'unplaced' in place ? place.unplaced
                : directory.status === 'complete' || directory.status === 'resyncing'
                  ? 'not-in-directory' as const
                  : 'directory-sync-incomplete' as const,
            }),
      };
    });
}
