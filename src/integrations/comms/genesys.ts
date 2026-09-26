/**
 * Genesys Cloud users - the contact centre workforce.
 *
 * `state=any`, NOT the default. The default returns active users only, which
 * is right for "who can take a call now" and wrong for a directory: an agent
 * deactivated yesterday still has last week's calls against their id, and a
 * join that cannot find them turns those calls into orphans. Inactive users
 * are kept and flagged, and the split counts only the active ones.
 *
 * NO FACILITY HERE. Genesys holds nothing that says which building an agent
 * sits in (confirmed in discovery), and its `division` is an access boundary
 * that crosses agencies, not a location. An employee's facility comes from
 * their Teams record through the workforce join; a contractor, who is not in
 * Entra, has none - and is reported as such rather than guessed.
 */
import type { CommsClient, Drained } from './client.ts';
import { drainGenesys } from './client.ts';
import { assignAgency } from './classify.ts';
import type { CommsAccount, CommsTenantConfig } from './types.ts';

type GenesysUserRow = {
  id: string;
  name: string;
  email?: string;
  username: string;
  state: 'active' | 'inactive' | 'deleted';
  primaryContactInfo: Array<{ address: string; mediaType: string }>;
};

export type GenesysRaw = { users: Drained<GenesysUserRow> };

export async function pullGenesys(client: CommsClient): Promise<GenesysRaw> {
  return { users: await drainGenesys<GenesysUserRow>(client, '/api/v2/users', { state: 'any' }) };
}

export function normaliseGenesys(raw: GenesysRaw, config: CommsTenantConfig): CommsAccount[] {
  return raw.users.rows
    .filter((u) => u.state !== 'deleted')
    .map((u): CommsAccount => {
      // `email` is optional on a Genesys user; `username` is always there and
      // is the same address for every user this org provisions.
      const email = u.email ?? u.username;
      return {
        source: 'genesys',
        sourceUserId: u.id,
        email,
        emailKey: email.toLowerCase(),
        // Upper-cased by this org's provisioning feed. Display only.
        displayName: u.name,
        agency: assignAgency(email, config),
        kind: 'person',
        voice: u.primaryContactInfo.some((c) => c.mediaType === 'PHONE'),
        active: u.state === 'active',
        unplaced: 'no-facility-source',
      };
    });
}
