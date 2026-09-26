/**
 * Comms-source configuration for the demo tenant.
 *
 * Deliberately a SEPARATE copy of what the mocks know, not an import of it.
 * The mocks are the customer's world; this is what the customer has told us
 * about it. A test that passes because both sides read the same constant
 * proves nothing - so the tests compare the outcome against the mock's ground
 * truth instead, and a drift between the two shows up as a wrong count.
 */
import type { CommsTenantConfig } from './types.ts';

export const HHS_DEMO_TENANT = 'hhs-demo';

export const COMMS_CONFIG: Record<string, CommsTenantConfig> = {
  [HHS_DEMO_TENANT]: {
    tenantId: HHS_DEMO_TENANT,
    sources: ['teams', 'genesys', 'webex'],
    agencyDomains: {
      'hhs.texas.example': 'HHSC',
      'dshs.texas.example': 'DSHS',
      'dfps.texas.example': 'DFPS',
    },
    contractorDomains: ['contact-partner.example', 'staffing-co.example'],
    webexLocationFacility: {
      'Austin - Central Office (0412)': '0412',
      'AUS North Campus': '0417',
      'HOU-1120 Houston Regional': '1120',
      'Dallas Regional Office': '1455',
      'ELP Field 2031': '2031',
      'Lubbock': '3308',
    },
  },
};

export function commsConfigFor(tenantId: string): CommsTenantConfig | undefined {
  return COMMS_CONFIG[tenantId];
}
