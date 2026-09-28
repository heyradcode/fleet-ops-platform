/**
 * The HHS world the graph tests stand on: the comms sources polled from the
 * mocks, then the knowledge graph built from what the poll stored - the
 * order `pnpm seed:aws` and the tab both use. Test support only; nothing the
 * platform runs imports it.
 */
import type { Principal } from '../platform/types.ts';
import { setClock, fixedClock, now } from '../platform/clock.ts';
import {
  DEMO_BANDWIDTH_USER, DEMO_CLIENT, DEMO_HELIX_USER, DEMO_KURMI_USER, DEMO_STARLINK_ACCOUNTS, DEMO_WEBEX_TOKEN,
  directory, mockFetch, resetMockState,
} from '../integrations/comms/mock/index.ts';
import { createCommsClient } from '../integrations/comms/client.ts';
import { COMMS_CONFIG, HHS_DEMO_TENANT } from '../integrations/comms/config.ts';
import { runCommsPoll } from '../integrations/comms/poll.ts';
import { buildGraph } from './store.ts';

export const HHS_ADMIN: Principal = {
  sub: 'graph-admin', email: 'graph@x', tenantId: HHS_DEMO_TENANT,
  roles: ['admin'], scope: { kind: 'tenant' }, identityProvider: 'cognito',
};

export async function pollHhsAndBuildGraph(principal: Principal = HHS_ADMIN): Promise<void> {
  resetMockState();
  setClock(fixedClock());
  await runCommsPoll(principal, createCommsClient({
    tenantId: HHS_DEMO_TENANT, fetch: mockFetch, sleep: async () => {},
    credentials: {
      entra: { tenantId: directory().entraTenantId, ...DEMO_CLIENT },
      genesys: { ...DEMO_CLIENT }, webex: { token: DEMO_WEBEX_TOKEN }, bandwidth: { ...DEMO_BANDWIDTH_USER },
      helix: { ...DEMO_HELIX_USER }, kurmi: { ...DEMO_KURMI_USER }, starlink: { ...DEMO_STARLINK_ACCOUNTS.prod },
    },
  }), COMMS_CONFIG[HHS_DEMO_TENANT], now());
  await buildGraph(principal);
}
