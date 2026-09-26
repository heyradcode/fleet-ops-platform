/**
 * ---------------------------------------------------------------------------
 * BMC Helix ITSM (AR System REST API) - the mock
 * ---------------------------------------------------------------------------
 * One host, per customer on BMC's SaaS (`{customer}-restapi.onbmc.com`); the
 * mock's is on a reserved `.example` name:
 *
 *   POST /api/jwt/login                       form username/password -> text token
 *   GET  /api/arsys/v1/entry/{form}           ?q=&fields=values(...)&limit=&offset=
 *
 * Forms modelled: `CHG:Infrastructure Change` (changes) and `HPD:Help Desk`
 * (incidents). Shapes are from memory of the AR System REST reference and
 * BMC's form definitions - VERIFY field names against the customer's Helix,
 * which is routinely customised. In particular, a change's configuration
 * items really live in an association form, not on the change; the mock
 * flattens that into a `CI Name` field, and the connector reads it in one
 * place so the real join is a local change.
 *
 * THE TRAPS THIS MOCK KEEPS:
 *
 *   - Auth is `AR-JWT <token>`, not `Bearer`. The login returns the token as
 *     PLAIN TEXT, and says nothing about when it expires.
 *   - Without `fields=values(...)` you get EVERY field - including the
 *     submitter's name and email on a ticket. Select what you need; that is
 *     both the performance advice and the data-minimisation rule.
 *   - Timestamps are `2026-09-08T13:35:00.000+0000` - an offset with no
 *     colon. Not every date parser accepts that.
 *   - Errors are a JSON ARRAY of `{ messageType, messageText, messageNumber }`.
 *   - `HPD:Help Desk` really does spell it `Detailed Decription`.
 *   - `q=` is AR's qualification language. It is a query language, so a value
 *     spliced into it unescaped is an injection - see helix.ts's builder.
 *
 * WHAT IS PLANTED, relative to "now":
 *   - CRQ000000104521: a QoS policy change on the Houston WAN edge, ending
 *     44 minutes ago - four minutes before Houston's call quality went bad.
 *   - CRQ000000104530: a TLS certificate renewal on SBC2, ending 41 minutes
 *     ago - just before SBC2 started failing calls.
 *   - INC000000231876: the helpdesk already has "choppy audio at Houston",
 *     raised 18 minutes ago.
 *   - Noise that must NOT match: a Houston change three days old, a Dallas
 *     change three hours old, SBC1 maintenance six hours ago, a change
 *     scheduled for tomorrow, and an unrelated open ticket.
 */
import { createApp, DEMO_HELIX_USER, issueToken, type MockApp, type MockRequest, type MockResponse } from './kernel.ts';
import { activityAnchor } from './time.ts';

const HELIX_TOKEN_TTL_S = 3600;

export const HELIX_PLANTED = {
  houstonChange: 'CRQ000000104521',
  sbcChange: 'CRQ000000104530',
  houstonTicket: 'INC000000231876',
} as const;

const MIN = 60_000;
const HOUR = 60 * MIN;

/** AR's timestamp style: ISO with `+0000` rather than `Z`. */
function arDate(ms: number): string {
  return new Date(ms).toISOString().replace('Z', '+0000');
}

type Values = Record<string, string | null>;

function changes(anchor: number): Values[] {
  const c = (id: string, summary: string, site: string, ci: string, start: number, end: number | null,
    status: string, group: string): Values => ({
    'Request ID': id.replace('CRQ', '0'),
    'Infrastructure Change ID': id,
    'Description': summary,
    'Detailed Description': summary + '. Implemented per the approved plan.',
    'Change Request Status': status,
    'Site': site,
    'CI Name': ci,
    'Risk Level': 'Risk Level 2',
    'Support Group Name': group,
    'Scheduled Start Date': arDate(start - 5 * MIN),
    'Scheduled End Date': arDate((end ?? start + HOUR) + 5 * MIN),
    'Actual Start Date': status === 'Scheduled' ? null : arDate(start),
    'Actual End Date': end === null || status === 'Scheduled' ? null : arDate(end),
    'Last Modified Date': arDate(end ?? start),
  });
  return [
    c(HELIX_PLANTED.houstonChange, 'Houston WAN edge - QoS policy update', 'Houston Regional Office',
      'hou-wan-edge-01', anchor - 55 * MIN, anchor - 44 * MIN, 'Completed', 'Network Operations'),
    c(HELIX_PLANTED.sbcChange, 'TLS certificate renewal - Teams Direct Routing SBC2', 'Austin Data Center',
      'SBC2-TEAMS-DR', anchor - 47 * MIN, anchor - 41 * MIN, 'Completed', 'Unified Communications'),
    c('CRQ000000104498', 'Houston print server queue migration', 'Houston Regional Office',
      'hou-print-01', anchor - 72 * HOUR, anchor - 71 * HOUR, 'Closed', 'Desktop Support'),
    c('CRQ000000104510', 'Dallas access switch firmware upgrade', 'Dallas Regional Office',
      'dal-acc-sw-07', anchor - 3 * HOUR - 20 * MIN, anchor - 3 * HOUR, 'Completed', 'Network Operations'),
    c('CRQ000000104515', 'SBC1 log rotation policy', 'Austin Data Center',
      'SBC1-TEAMS-DR', anchor - 6 * HOUR, anchor - 6 * HOUR + 10 * MIN, 'Completed', 'Unified Communications'),
    c('CRQ000000104540', 'El Paso WAN circuit upgrade', 'El Paso Field Office',
      'elp-wan-edge-01', anchor + 20 * HOUR, anchor + 22 * HOUR, 'Scheduled', 'Network Operations'),
  ];
}

function tickets(anchor: number): Values[] {
  const t = (id: string, summary: string, site: string, status: string, group: string, submitted: number,
    first: string, last: string): Values => ({
    'Request ID': id.replace('INC', '0'),
    'Incident Number': id,
    'Description': summary,
    'Detailed Decription': summary + ' - reported by phone.',
    'Status': status,
    'Priority': 'High',
    'Impact': '3-Moderate/Limited',
    'Urgency': '2-High',
    'Assigned Group': group,
    'Site': site,
    'Submit Date': arDate(submitted),
    'Last Modified Date': arDate(submitted + 5 * MIN),
    // PERSONAL DATA - returned when no `fields` projection is asked for.
    'First Name': first,
    'Last Name': last,
    'Internet E-mail': first.toLowerCase() + '.' + last.toLowerCase() + '@hhs.texas.example',
  });
  return [
    t(HELIX_PLANTED.houstonTicket, 'Choppy audio on Teams calls - Houston office', 'Houston Regional Office',
      'Assigned', 'Unified Communications', anchor - 18 * MIN, 'Avery', 'Castillo'),
    t('INC000000231850', 'Password reset for shared mailbox', 'Dallas Regional Office',
      'In Progress', 'Service Desk', anchor - 2 * HOUR, 'Jordan', 'Holloway'),
    t('INC000000231790', 'Printer offline - Houston 3rd floor', 'Houston Regional Office',
      'Closed', 'Desktop Support', anchor - 30 * HOUR, 'Riley', 'Moreau'),
  ];
}

// ---------------------------------------------------------------------------
// Qualification parsing - the subset the mock understands
// ---------------------------------------------------------------------------

type Cond = { field: string; op: string; value: string };

const COND = /'([^']+)'\s*(!=|<=|>=|=|<|>)\s*"((?:[^"]|"")*)"/y;

/** `'Field' op "value" AND ...`. Anything else is a 400 - never silently ignored. */
function parseQualification(q: string): Cond[] | string {
  const out: Cond[] = [];
  let i = 0;
  for (;;) {
    while (q[i] === ' ') i++;
    COND.lastIndex = i;
    const m = COND.exec(q);
    if (!m) return 'unsupported qualification near: ' + q.slice(i, i + 40);
    out.push({ field: m[1], op: m[2], value: m[3].replace(/""/g, '"') });
    i = COND.lastIndex;
    while (q[i] === ' ') i++;
    if (i >= q.length) return out;
    if (q.slice(i, i + 3).toUpperCase() !== 'AND') return 'only AND is modelled, near: ' + q.slice(i, i + 20);
    i += 3;
  }
}

function matches(row: Values, c: Cond): boolean {
  const v = row[c.field];
  if (v === null || v === undefined) return c.op === '!=';
  const cmp = c.field.endsWith('Date')
    ? Date.parse(v.replace(/\+0000$/, 'Z')) - Date.parse(c.value.replace(/\+0000$/, 'Z'))
    : v.localeCompare(c.value);
  switch (c.op) {
    case '=': return cmp === 0;
    case '!=': return cmp !== 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    default: return cmp >= 0;
  }
}

function arError(status: number, text: string, number: number, appended?: string): MockResponse {
  return { status, body: [{ messageType: 'ERROR', messageText: text, messageAppendedText: appended ?? null, messageNumber: number }] };
}

const FORMS: Record<string, (anchor: number) => Values[]> = {
  'CHG:Infrastructure Change': changes,
  'HPD:Help Desk': tickets,
};

function entries(req: MockRequest, form: string): MockResponse {
  const source = FORMS[form];
  if (!source) return arError(400, 'Form does not exist on server', 303, form);
  let rows = source(activityAnchor());

  const q = req.query.get('q');
  if (q) {
    const conds = parseQualification(q);
    if (typeof conds === 'string') return arError(400, 'Error in qualification', 1587, conds);
    for (const c of conds) {
      if (!(c.field in rows[0])) return arError(400, 'Field does not exist on current form', 314, c.field);
    }
    rows = rows.filter((r) => conds.every((c) => matches(r, c)));
  }

  const fieldsParam = req.query.get('fields');
  let fields: string[] | undefined;
  if (fieldsParam) {
    const m = /^values\((.*)\)$/.exec(fieldsParam);
    if (!m) return arError(400, 'Invalid fields parameter', 8960, fieldsParam);
    fields = m[1].split(',').map((f) => f.trim());
    for (const f of fields) if (!(f in (source(0)[0]))) return arError(400, 'Field does not exist on current form', 314, f);
  }

  const limit = Math.min(1000, Math.max(1, Number(req.query.get('limit') ?? 50)));
  const offset = Math.max(0, Number(req.query.get('offset') ?? 0));
  const page = rows.slice(offset, offset + limit);
  const self = req.base + req.path;
  const next = new URLSearchParams(req.query);
  next.set('offset', String(offset + limit));
  next.set('limit', String(limit));

  return {
    status: 200,
    body: {
      entries: page.map((r) => ({
        values: fields ? Object.fromEntries(fields.map((f) => [f, r[f] ?? null])) : r,
        _links: { self: [{ href: self + '/' + r['Request ID'] }] },
      })),
      _links: {
        self: [{ href: self + '?' + req.query.toString() }],
        ...(offset + limit < rows.length ? { next: [{ href: self + '?' + next.toString() }] } : {}),
      },
    },
  };
}

export const helixApi: MockApp = createApp('helix', 'api', [
  {
    method: 'POST',
    pattern: '/api/jwt/login',
    public: true,
    handler(req) {
      const form = new URLSearchParams(req.body);
      if (form.get('username') !== DEMO_HELIX_USER.username || form.get('password') !== DEMO_HELIX_USER.password) {
        return arError(401, 'Authentication failed', 623, form.get('username') ?? '');
      }
      return { status: 200, contentType: 'text/plain', body: issueToken('helix', HELIX_TOKEN_TTL_S) };
    },
  },
  {
    method: 'GET',
    pattern: '/api/arsys/v1/entry/:form',
    handler: (req, { form }) => entries(req, form),
  },
], (status, _code, message) => arError(status, message, status === 401 ? 623 : status === 429 ? 9093 : 9350));
