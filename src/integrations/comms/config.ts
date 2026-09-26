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
    bandwidth: {
      accountId: '9900001',
      peerTrunk: {
        '540101': 'sbc1.voice.hhs.texas.example',
        '540102': 'sbc2.voice.hhs.texas.example',
        // 540103, the legacy PBX trunk, is deliberately absent: it has no
        // Teams counterpart, and its signals must still arrive under its own
        // name rather than be dropped.
      },
    },
    helix: {
      siteFacility: {
        'Central Office': '0412',
        'North Austin Campus': '0417',
        'Houston Regional Office': '1120',
        'Dallas Regional Office': '1455',
        'El Paso Field Office': '2031',
        'Lubbock Field Office': '3308',
        // 'Austin Data Center' is deliberately absent: it houses the SBCs,
        // not staff, and mapping it to a facility would attach every data
        // centre change to that facility's call quality.
      },
      ciTrunk: {
        'SBC1-TEAMS-DR': 'sbc1.voice.hhs.texas.example',
        'SBC2-TEAMS-DR': 'sbc2.voice.hhs.texas.example',
      },
    },
  },
};

export function commsConfigFor(tenantId: string): CommsTenantConfig | undefined {
  return COMMS_CONFIG[tenantId];
}
