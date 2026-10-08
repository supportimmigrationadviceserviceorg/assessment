// crm-score / worker.js  —  Cloudflare Worker "ias-score"
//
// Collects what each person does, by email address, from three places:
//   1. Mailgun webhooks       POST /mailgun   (opened, clicked, unsubscribed, complained, failed)
//   2. The landing pages      POST /e         (page visits, reaching the payment step)
//   3. ias-crm forwards       POST /forward   (questionnaires, yes/no answers - already flowing through ias-crm)
// and on a schedule (every 15 minutes) scores each changed person and writes to their Bitrix lead:
//   UF_CRM_IAS_SCORE   0-100
//   UF_CRM_IAS_HEAT    HOT / WARM / COLD / DO NOT CONTACT / CLIENT
//   UF_CRM_IAS_NEXT    the recommended next step, one line
//   UF_CRM_IAS_SIGNALS what the score is based on
// plus a timeline comment, ONLY when the recommendation changes, so agents are not spammed.
//
// It never changes a lead's stage, never creates a lead, and never sends anything to a client.
//
// Secrets (Cloudflare dashboard, encrypted):  BITRIX_WEBHOOK, MAILGUN_SIGNING_KEY, SCORE_KEY
// Binding:                                     DB  (D1 database "ias-score")
// Optional plain-text variables:               SCORE_PROTECTED, BATCH_SIZE

import { scoreEmail, DAY } from './score.js';
import { parseAssessment, adviseProfile, formatProfile, readAgentNotes, cleanText, profileFit, isOwnComment } from './profile.js';

const BUILD = 'score-v42';
const ORIGIN = 'https://supportimmigrationadviceserviceorg.github.io';
const DEFAULT_PROTECTED = ['CONVERTED', '26', '27', '31', 'DETAILS', '12'];
const PAGE_TYPES = new Set(['view', 'checkout']);
const EMAIL_RE = /^[^\s@#]{1,64}@[^\s@#]{1,190}\.[a-z]{2,}$/i;

// ---------------------------------------------------------------- schema
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL, type TEXT NOT NULL, ts INTEGER NOT NULL,
      meta TEXT, ext_id TEXT UNIQUE)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS ev_email_ts ON events(email, ts)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS state (
      email TEXT PRIMARY KEY, dirty INTEGER NOT NULL DEFAULT 1,
      last_event INTEGER, scored_at INTEGER, score INTEGER, heat TEXT,
      rec_key TEXT, lead_id TEXT, note TEXT, pri INTEGER NOT NULL DEFAULT 1)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS st_dirty ON state(dirty, pri, last_event)`),
  ]);
  for (const col of ['prof_key TEXT', 'assigned TEXT']) {
    try { await db.prepare(`ALTER TABLE state ADD COLUMN ${col}`).run(); } catch (e) { /* already there */ }
  }
  await db.prepare(`CREATE TABLE IF NOT EXISTS digest_log (day TEXT PRIMARY KEY, sent_at INTEGER, summary TEXT)`).run();
  schemaReady = true;
}

async function record(db, email, type, ts, meta, extId, quiet = false) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return false;
  await ensureSchema(db);
  if (quiet) { // kept for the record, but it says nothing about the person: no rescoring
    await db.prepare(`INSERT OR IGNORE INTO events (email, type, ts, meta, ext_id) VALUES (?,?,?,?,?)`)
      .bind(email, type, ts, meta ? JSON.stringify(meta).slice(0, 500) : null, extId || null).run();
    return true;
  }
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO events (email, type, ts, meta, ext_id) VALUES (?,?,?,?,?)`)
      .bind(email, type, ts, meta ? JSON.stringify(meta).slice(0, 500) : null, extId || null),
    // pri 2 = something more than an email open; those are scored first.
    db.prepare(`INSERT INTO state (email, dirty, last_event, pri) VALUES (?,1,?,?)
      ON CONFLICT(email) DO UPDATE SET dirty=1, last_event=MAX(COALESCE(last_event,0), excluded.last_event),
        pri=MAX(pri, excluded.pri)`)
      .bind(email, ts, type === 'open' ? 1 : 2),
  ]);
  return true;
}

// ---------------------------------------------------------------- helpers
const json = (o, status = 200, extra = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...extra } });
const cors = (req) => (req.headers.get('origin') === ORIGIN
  ? { 'access-control-allow-origin': ORIGIN, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' }
  : {});

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function keyOk(req, env) {
  const u = new URL(req.url);
  const k = req.headers.get('x-score-key') || u.searchParams.get('key') || '';
  return !!env.SCORE_KEY && safeEqual(k, env.SCORE_KEY);
}

// ---------------------------------------------------------------- Bitrix
function bxBase(env) {
  // Accept the webhook with or without a trailing method (the Bitrix screen shows ".../profile").
  let b = String(env.BITRIX_WEBHOOK || '').trim().replace(/\/+$/, '');
  b = b.replace(/\/[a-z]+(\.[a-z_]+)+(\.json)?$/i, '').replace(/\/profile$/i, '');
  return b + '/';
}
// Bitrix allows about 2 requests a second per portal (shared with ias-crm), so
// calls from this Worker are spaced out.
let lastBx = 0;
// Cloudflare's free plan allows 50 outside calls per run. Every Bitrix call takes
// one from this budget; work that would go over stops and continues next run.
let subUsed = 0, subMax = 45;
export function resetBudget(env) { subUsed = 0; subMax = parseInt((env && env.SUB_MAX) || '45', 10); }
const budgetLeft = () => subMax - subUsed;
async function takeSub() {
  if (subUsed >= subMax) throw new Error('call budget for this run used up');
  subUsed++;
  const wait = lastBx + 450 - Date.now();
  if (wait > 0) await new Promise(res => setTimeout(res, wait));
  lastBx = Date.now();
}
async function bx(env, method, params) {
  await takeSub();
  const r = await fetch(bxBase(env) + method + '.json', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(`Bitrix ${method}: ${String(j.error_description || j.error).replace(/\/rest\/\S+/g, '[path]')}`);
  return j.result;
}

// The four fields, on leads AND contacts. Created by /admin/setup as UF_CRM_IAS_*
// on leads, or by hand in Bitrix with these exact labels (Bitrix then gives them
// UF_CRM_<number> codes, different for leads and contacts).
const FIELD_LABELS = {
  score: ['UF_CRM_IAS_SCORE', 'engagement score'],
  heat: ['UF_CRM_IAS_HEAT', 'engagement heat'],
  next: ['UF_CRM_IAS_NEXT', 'recommended next step'],
  signals: ['UF_CRM_IAS_SIGNALS', 'engagement signals'],
  // Read-only lead form fields used to judge fit when there is no questionnaire.
  fbIncome: ['', 'fb income'],
  income: ['', '=income'], // a separate plain "Income" field on some leads; exact name only
  ipCountry: ['', 'ip country'],
  niReason: ['UF_CRM_1742920574090', 'not interested reason'],
  // Existing CRM fields the system keeps up to date when it emails a client.
  lastMail: ['', 'date when the last mailing was sent', 'last email sent', 'last mail sent', 'date of last email', 'last email date'],
  mailCount: ['', 'number of mailings sent'],
};
const fieldItems = {}; // list-field code -> { itemId: text }
const fieldCache = {};
const fieldsFresh = (entity) => fieldCache[entity] && Date.now() - fieldCache[entity].at < 3600000;
async function entityFields(env, entity) {
  if (fieldsFresh(entity)) return fieldCache[entity].map;
  return cacheFields(entity, await bx(env, `crm.${entity}.fields`, {}) || {});
}
function cacheFields(entity, all) {
  const map = {};
  for (const [key, [code, label, ...exact]] of Object.entries(FIELD_LABELS)) {
    if (code && all[code]) {
      map[key] = code;
      if (Array.isArray(all[code].items)) fieldItems[code] = Object.fromEntries(all[code].items.map(it => [String(it.ID), it.VALUE]));
      continue;
    }
    // First pass: the main label (prefix match). Second pass: alternative labels, exact only.
    const passes = label.startsWith('=')
      ? [(n) => n === label.slice(1)]
      : [(n) => n === label || n.startsWith(label), (n) => exact.includes(n)];
    for (const ok of passes) {
    if (map[key]) break;
    for (const [c2, f] of Object.entries(all)) {
      if (!c2.startsWith('UF_CRM_')) continue;
      const names = [f.title, f.listLabel, f.formLabel, f.filterLabel].map(x => String(x || '').trim().toLowerCase());
      if (names.some(ok)) {
        map[key] = c2;
        if (Array.isArray(f.items)) fieldItems[c2] = Object.fromEntries(f.items.map(it => [String(it.ID), it.VALUE]));
        break;
      }
    }
    }
  }
  fieldCache[entity] = { map, at: Date.now() };
  return map;
}

// Paged list calls (Bitrix returns 50 per page).
async function bxAll(env, method, params, max = 1000) {
  const out = []; let start = 0;
  while (out.length < max) {
    if (budgetLeft() < 3 && out.length) break; // keep a little for what follows
    await takeSub();
    const r = await fetch(bxBase(env) + method + '.json', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...params, start }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error(`Bitrix ${method}: ${String(j.error_description || j.error).replace(/\/rest\/\S+/g, '[path]')}`);
    out.push(...(j.result || []));
    if (j.next === undefined || j.next === null) break;
    start = j.next;
  }
  return out;
}

// Up to 50 Bitrix calls in ONE request. cmds: [[key, method, params], ...]
function qs(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') out.push(qs(v, key));
    else if (typeof v === 'string' && v.startsWith('$result[')) out.push(encodeURIComponent(key) + '=' + v);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(v == null ? '' : v));
  }
  return out.filter(Boolean).join('&');
}
async function bxBatch(env, cmds) {
  const res = { result: {}, total: {}, error: {} };
  for (let i = 0; i < cmds.length; i += 50) {
    const chunk = cmds.slice(i, i + 50);
    await takeSub();
    const r = await fetch(bxBase(env) + 'batch.json', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ halt: 0, cmd: Object.fromEntries(chunk.map(([k, m, p]) => [k, m + '?' + qs(p)])) }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error(`Bitrix batch: ${String(j.error_description || j.error).replace(/\/rest\/\S+/g, '[path]')}`);
    const b = j.result || {};
    Object.assign(res.result, b.result || {}); Object.assign(res.total, b.result_total || {}); Object.assign(res.error, b.result_error || {});
  }
  return res;
}

let statusCache = null, statusAt = 0;
async function leadStatuses(env) {
  if (statusCache && Date.now() - statusAt < 3600000) return statusCache;
  const list = await bx(env, 'crm.status.list', { filter: { ENTITY_ID: 'STATUS' } }).catch(() => []) || [];
  statusCache = Object.fromEntries(list.map(x => [x.STATUS_ID, x.NAME]));
  statusAt = Date.now();
  return statusCache;
}
let contactTypeCache = null, contactTypeAt = 0;
let sourceCache = null, sourceAt = 0;
async function sourceNames(env) {
  if (sourceCache && Date.now() - sourceAt < 3600000) return sourceCache;
  const list = await bx(env, 'crm.status.list', { filter: { ENTITY_ID: 'SOURCE' } }).catch(() => []) || [];
  sourceCache = Object.fromEntries(list.map(x => [x.STATUS_ID, x.NAME]));
  sourceAt = Date.now();
  return sourceCache;
}
// Leads and contacts from the HIVE source are not ours to score or report on.
const isHive = (srcName, srcDesc) => /\bhive\b/i.test(srcName || '') || /\bhive\b/i.test(srcDesc || '');
const isNoAnswerStatus = (name) => /no\s*answer|not\s*answer|didn'?t\s*answer|^NA\b|\bNA$|no\s*line|^NL\b|unreachable/i.test(name || '');
const isFailedPayStatus = (name) => /fail\w*\s*(to\s*)?pay|pay\w*\s*fail|declin/i.test(name || '');
// "Not interested - support email request" (31) is set by the client from the
// re-engagement page, not by an agent, so it is not counted against anyone.
const isNotInterestedStatus = (name) => /not\s*interest|^NI\b|\bNI$/i.test(name || '') && !/paid|support email/i.test(name || '');

// FB Income / IP Country straight from the lead form (list fields give an item ID).
function leadFormFacts(lead, entity = 'lead') {
  const fm = (fieldCache[entity] || {}).map || {};
  const val = (code) => {
    if (!lead || !code) return '';
    let v = lead[code];
    if (Array.isArray(v)) v = v[0];
    v = v == null ? '' : String(v);
    return (fieldItems[code] && fieldItems[code][v]) || v;
  };
  const phone = lead && Array.isArray(lead.PHONE) && lead.PHONE[0] ? lead.PHONE[0].VALUE : '';
  return { income: val(fm.fbIncome) || val(fm.income), country: val(fm.ipCountry), phone, niReason: val(fm.niReason) };
}

async function bitrixFacts(env, email) {
  // Everything about one person in ONE bundled Bitrix call: the later commands use
  // the IDs found by the first two ($result[...]), so no second round trip is needed.
  const L = '$result[leads][0][ID]', C = '$result[contacts][0][ID]';
  const cmds = [
    ['leads', 'crm.lead.list', { filter: { EMAIL: email }, order: { DATE_CREATE: 'DESC' },
      select: ['ID', 'STATUS_ID', 'DATE_CREATE', 'COMMENTS', 'ASSIGNED_BY_ID', 'SOURCE_ID', 'SOURCE_DESCRIPTION', 'UTM_CAMPAIGN', 'MOVED_TIME', 'DATE_MODIFY', 'PHONE', 'UF_*'] }],
    ['contacts', 'crm.contact.list', { filter: { EMAIL: email }, order: { DATE_CREATE: 'DESC' },
      select: ['ID', 'DATE_CREATE', 'DATE_MODIFY', 'COMMENTS', 'ASSIGNED_BY_ID', 'SOURCE_ID', 'SOURCE_DESCRIPTION', 'TYPE_ID', 'PHONE', 'UF_*'] }],
    // Deals have no EMAIL field: find them through the contact (bug found in Sept).
    ['deals', 'crm.deal.list', { filter: { CONTACT_ID: C }, select: ['ID', 'STAGE_SEMANTIC_ID'] }],
    ['tlLead', 'crm.timeline.comment.list', { filter: { ENTITY_ID: L, ENTITY_TYPE: 'lead' }, select: ['ID', 'CREATED', 'COMMENT'], order: { ID: 'DESC' } }],
    ['actLead', 'crm.activity.list', { filter: { OWNER_TYPE_ID: 1, OWNER_ID: L }, order: { ID: 'DESC' }, select: ['ID', 'SUBJECT', 'DESCRIPTION', 'COMPLETED', 'DEADLINE', 'CREATED'] }],
    ['tlContact', 'crm.timeline.comment.list', { filter: { ENTITY_ID: C, ENTITY_TYPE: 'contact' }, select: ['ID', 'CREATED', 'COMMENT'], order: { ID: 'DESC' } }],
    ['actContact', 'crm.activity.list', { filter: { OWNER_TYPE_ID: 3, OWNER_ID: C }, order: { ID: 'DESC' }, select: ['ID', 'SUBJECT', 'DESCRIPTION', 'COMPLETED', 'DEADLINE', 'CREATED'] }],
    ['uLead', 'user.get', { ID: '$result[leads][0][ASSIGNED_BY_ID]' }],
    ['uContact', 'user.get', { ID: '$result[contacts][0][ASSIGNED_BY_ID]' }],
  ];
  if (!statusCache || Date.now() - statusAt > 3600000) cmds.push(['statuses', 'crm.status.list', { filter: { ENTITY_ID: 'STATUS' } }]);
  if (!sourceCache || Date.now() - sourceAt > 3600000) cmds.push(['sources', 'crm.status.list', { filter: { ENTITY_ID: 'SOURCE' } }]);
  if (!contactTypeCache || Date.now() - contactTypeAt > 3600000) cmds.push(['ctypes', 'crm.status.list', { filter: { ENTITY_ID: 'CONTACT_TYPE' } }]);
  if (!fieldsFresh('lead')) cmds.push(['fLead', 'crm.lead.fields', {}]);
  if (!fieldsFresh('contact')) cmds.push(['fContact', 'crm.contact.fields', {}]);
  const b = await bxBatch(env, cmds);
  const r = b.result || {};
  if (r.statuses) { statusCache = Object.fromEntries(r.statuses.map(x => [x.STATUS_ID, x.NAME])); statusAt = Date.now(); }
  if (r.sources) { sourceCache = Object.fromEntries(r.sources.map(x => [x.STATUS_ID, x.NAME])); sourceAt = Date.now(); }
  if (r.ctypes) { contactTypeCache = Object.fromEntries(r.ctypes.map(x => [x.STATUS_ID, x.NAME])); contactTypeAt = Date.now(); }
  if (r.fLead) cacheFields('lead', r.fLead);
  if (r.fContact) cacheFields('contact', r.fContact);
  for (const k of ['uLead', 'uContact']) {
    const u = Array.isArray(r[k]) ? r[k][0] : null;
    if (u && u.ID) userNames[u.ID] = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || 'Responsible';
  }
  const leads = Array.isArray(r.leads) ? r.leads : [];
  const contacts = Array.isArray(r.contacts) ? r.contacts : [];
  let paid = contacts.length > 0 && (Array.isArray(r.deals) ? r.deals : []).some(d => d.STAGE_SEMANTIC_ID === 'S');
  if (leads.some(l => l.STATUS_ID === 'CONVERTED')) paid = true;
  const lead = leads[0], contact = contacts[0];
  const created = Math.max(lead ? Date.parse(lead.DATE_CREATE) || 0 : 0, contact ? Date.parse(contact.DATE_CREATE) || 0 : 0);
  const srcs = sourceCache || {};
  const hive = [lead, contact].some(x => x && isHive(srcs[x.SOURCE_ID], x.SOURCE_DESCRIPTION));
  if (hive) return { found: true, hive: true, leadId: lead ? lead.ID : null, contactId: contact ? contact.ID : null, paid };
  const facts = {
    found: !!(lead || contact),
    leadId: lead ? lead.ID : null, status: lead ? lead.STATUS_ID : null,
    contactId: contact ? contact.ID : null,
    created, paid,
  };

  // What the agents and the questionnaire wrote: the left-hand COMMENTS field,
  // the timeline comments and the activities, on the lead and on the contact.
  const texts = [], items = [];
  const when = (x) => Date.parse(x) || 0;
  const listOf = (k) => (Array.isArray(r[k]) ? r[k] : []);
  for (const [rec, tl, act] of [[lead, 'tlLead', 'actLead'], [contact, 'tlContact', 'actContact']]) {
    if (!rec) continue;
    if (rec.COMMENTS) texts.push({ text: rec.COMMENTS, ts: when(rec.DATE_CREATE) });
    for (const c of listOf(tl)) {
      texts.push({ text: c.COMMENT, ts: when(c.CREATED) });
      items.push({ kind: 'comment', text: c.COMMENT, ts: when(c.CREATED) });
    }
    for (const a of listOf(act)) {
      items.push({ kind: 'activity', text: cleanText(a.DESCRIPTION || ''), subject: a.SUBJECT || '', ts: when(a.CREATED),
        completed: a.COMPLETED === 'Y', deadline: when(a.DEADLINE) });
    }
  }
  facts.notes = readAgentNotes(items);
  facts.answers = parseAssessment(texts);
  facts.source = lead ? [lead.SOURCE_DESCRIPTION, lead.UTM_CAMPAIGN].filter(Boolean).join(' ') : '';
  facts.leadForm = leadFormFacts(lead, 'lead');
  // No income/country on the lead (or no lead at all): use the contact's own fields.
  if (contact && !facts.leadForm.income) {
    const cf = leadFormFacts(contact, 'contact');
    facts.leadForm = { ...facts.leadForm, income: cf.income, country: facts.leadForm.country || cf.country, phone: facts.leadForm.phone || cf.phone };
  }
  facts.fit = profileFit(facts.answers, facts.source, facts.leadForm);
  // The latest agent note that talks about Not Interested (the reason is often only written there).
  const niNote = items.filter(it => it.kind === 'comment' && !isOwnComment(it.text) && /\bNI\b|not interest|לא מעוניינ/i.test(cleanText(it.text)))
    .sort((a, b) => b.ts - a.ts)[0];
  const niNoteText = niNote ? cleanText(niNote.text).replace(/\s+/g, ' ').trim().slice(0, 90) : '';
  // Paying clients are worked from the contact, everyone else from the lead.
  facts.assignedId = (paid && contact ? contact.ASSIGNED_BY_ID : (lead || contact || {}).ASSIGNED_BY_ID) || null;
  if (lead) {
    const name = (statusCache || {})[lead.STATUS_ID] || '';
    facts.statusName = name;
    facts.statusTs = when(lead.MOVED_TIME) || when(lead.DATE_MODIFY);
    if (isNotInterestedStatus(name)) facts.ni = { ts: when(lead.MOVED_TIME) || when(lead.DATE_MODIFY), reason: facts.leadForm.niReason || niNoteText };
    if (isFailedPayStatus(name)) facts.failedPay = { ts: when(lead.MOVED_TIME) || when(lead.DATE_MODIFY), status: name };
  }
  // Contact type "NI" (e.g. a client who paid for the assessment and said no to the process).
  if (contact && !facts.ni) {
    const t = (contactTypeCache || {})[contact.TYPE_ID] || '';
    facts.contactType = t;
    if (!facts.statusTs) facts.statusTs = when(contact.DATE_MODIFY);
    if (isNotInterestedStatus(t)) facts.ni = { ts: niNote ? niNote.ts : when(contact.DATE_MODIFY), reason: niNoteText, contact: true };
    if (!facts.failedPay && isFailedPayStatus(t)) facts.failedPay = { ts: when(contact.DATE_MODIFY), status: t };
  }
  // A "did not answer" status / contact type counts like NA notes, even if no one wrote a note.
  const naName = [facts.statusName, facts.contactType].find(x => isNoAnswerStatus(x || ''));
  if (naName) {
    const naTs = lead && isNoAnswerStatus(facts.statusName || '') ? (when(lead.MOVED_TIME) || when(lead.DATE_MODIFY)) : when((contact || {}).DATE_MODIFY);
    const prevNa = facts.notes.noAnswer;
    facts.notes.noAnswer = { count: Math.max(2, prevNa ? prevNa.count : 0), last: Math.max(naTs, prevNa ? prevNa.last : 0), status: naName };
  }
  return facts;
}

// The update command for one entity, or null if its four fields are not in Bitrix.
async function fieldsUpdate(env, entity, id, s) {
  const fm = await entityFields(env, entity);
  const fields = {};
  if (fm.score) fields[fm.score] = String(s.score);
  if (fm.heat) fields[fm.heat] = s.category;
  if (fm.next) fields[fm.next] = `${s.rec.action}: ${s.rec.why}`.slice(0, 250);
  if (fm.signals) fields[fm.signals] = s.signals.slice(0, 250);
  if (!Object.keys(fields).length) return null;
  return [entity, `crm.${entity}.update`, { id, fields, params: { REGISTER_SONET_EVENT: 'N' } }];
}

// ---------------------------------------------------------------- scoring run
async function scoreOne(env, email, opts = {}) {
  const db = env.DB;
  const now = Date.now();
  const { results } = await db.prepare(
    `SELECT type, ts, meta FROM events WHERE email=? AND ts>=? ORDER BY ts`)
    .bind(email, now - 120 * DAY).all();
  const events = results.map(r => ({ type: r.type, ts: r.ts, meta: r.meta ? JSON.parse(r.meta) : null }));
  const prev = await db.prepare(`SELECT rec_key, prof_key FROM state WHERE email=?`).bind(email).first();

  // Cheap path: score without Bitrix first. If it is cold, says "no action" and
  // nothing was ever written for this person, there is nothing to tell Bitrix.
  const pre = scoreEmail(events, {}, now);
  let skip = !opts.dryRun && !opts.forceFull && pre.rec.key === 'none' && pre.category === 'COLD' && (!prev || !prev.rec_key || prev.rec_key === 'none');
  if (skip) {
    // One cheap look first: a lead sitting in "Failed to pay" who opens our email
    // is worth a call even with no other activity.
    const quick = await bx(env, 'crm.lead.list', { filter: { EMAIL: email }, order: { DATE_CREATE: 'DESC' }, select: ['ID', 'STATUS_ID'] }).catch(() => []) || [];
    if (quick.length) {
      const names = await leadStatuses(env);
      if (quick.some(l => isFailedPayStatus(names[l.STATUS_ID]))) skip = false;
    }
  }
  if (skip) {
    await db.prepare(`UPDATE state SET dirty=0, scored_at=?, score=?, heat=?, rec_key='none', note='cold, not written' WHERE email=?`)
      .bind(now, pre.score, pre.category, email).run();
    return { email, ...pre, lead: null, note: 'cold, not written' };
  }

  const facts = await bitrixFacts(env, email);
  if (facts.hive) {
    if (!opts.dryRun) await db.prepare(`UPDATE state SET dirty=0, scored_at=?, heat='HIVE', rec_key='none', note='HIVE source, ignored' WHERE email=?`).bind(now, email).run();
    return { email, note: 'HIVE source, ignored', bitrix: facts };
  }
  const s = scoreEmail(events, facts, now);
  const advice = s.category === 'LOW PRIORITY' ? null : adviseProfile(facts.answers);
  const profileText = advice ? formatProfile(advice, facts.answers._ts) : '';
  const qKey = profileText ? advice.codes.join(',') + '|' + advice.ask.length + '|' + (facts.answers._ts || 0) : '';
  // Advice read from the agents' notes (waiting / trust / visa hints) also triggers a new comment when it changes.
  const noteAdvice = s.advice || [];
  let nh = 0; for (const ch of noteAdvice.join('|')) nh = (nh * 31 + ch.charCodeAt(0)) >>> 0;
  const profKey = [qKey, noteAdvice.length ? 'n' + nh.toString(36) : ''].filter(Boolean).join('#');
  if (advice && advice.codes.length) s.signals = (s.signals + ' | Routes: ' + advice.codes.join(', ')).slice(0, 250);

  const protectedList = (env.SCORE_PROTECTED ? env.SCORE_PROTECTED.split(',') : DEFAULT_PROTECTED).map(x => x.trim());
  const leadOk = !!facts.leadId && !protectedList.includes(facts.status);
  const notes = [];
  if (!facts.found) notes.push('no lead or contact for this email');
  else if (opts.dryRun) notes.push('dry run');
  else {
    // Fields: on the lead (unless its stage is protected) and on the contact.
    if (facts.leadId && !leadOk) notes.push('lead in protected stage ' + facts.status + ', lead not written');
    const writes = [];
    if (leadOk) { const c = await fieldsUpdate(env, 'lead', facts.leadId, s); if (c) writes.push(c); else notes.push('lead fields missing in Bitrix'); }
    if (facts.contactId) { const c = await fieldsUpdate(env, 'contact', facts.contactId, s); if (c) writes.push(c); else notes.push('contact fields missing in Bitrix'); }

    // One timeline comment when the recommendation or the profile advice changes:
    // on the lead if it can be written, otherwise on the contact. Never both.
    const recChanged = (!prev || prev.rec_key !== s.rec.key) && !/^none/.test(s.rec.key) && s.rec.key !== 'client';
    const profChanged = !!profKey && (!prev || prev.prof_key !== profKey);
    if (recChanged || profChanged) {
      // Paying clients are worked from the contact; everyone else from the lead.
      const target = facts.paid && facts.contactId ? ['contact', facts.contactId]
        : leadOk ? ['lead', facts.leadId] : facts.contactId ? ['contact', facts.contactId] : null;
      if (target) {
        const actionable = !/^(none|client|low_)/.test(s.rec.key);
        const lines = [
          ...(await (async () => {
            // Retention clients go to the retention owner (Mark Cross), not the assigned agent.
            if (/^retention/.test(s.rec.key)) {
              const [r] = await usersByName(env, env.RETENTION_ID || '', env.RETENTION_NAME || 'Mark Cross');
              if (r && r.id) return [`[USER=${r.id}]${env.RETENTION_NAME || 'Mark Cross'}[/USER]`];
            }
            return facts.assignedId && actionable ? [`[USER=${facts.assignedId}]${await userName(env, facts.assignedId)}[/USER]`] : [];
          })()),
          `ENGAGEMENT SCORE ${s.score}/100 - ${s.category}`,
          `Next step: ${s.rec.action}`,
          `Why: ${s.rec.why}`,
          `Activity: ${s.signals}`,
        ];
        if (s.rec.email) lines.push('', 'Suggested opening line if writing:', s.rec.email);
        if (noteAdvice.length) lines.push('', 'FROM THE NOTES:', ...noteAdvice);
        if (profChanged && profileText) lines.push('', profileText);
        writes.push(['comment', 'crm.timeline.comment.add', { fields: { ENTITY_ID: target[1], ENTITY_TYPE: target[0], COMMENT: lines.join('\n') } }]);
      }
    }
    // All writes for this person in ONE bundled call.
    if (writes.length) {
      const w = await bxBatch(env, writes);
      for (const [k] of writes) notes.push(w.error && w.error[k] ? `${k} failed: ${JSON.stringify(w.error[k]).slice(0, 80)}` : k === 'comment' ? 'comment written' : `${k} written`);
    }
  }
  const note = notes.join(', ') || 'nothing to write';

  if (!opts.dryRun) {
    await db.prepare(`UPDATE state SET dirty=0, scored_at=?, score=?, heat=?, rec_key=?, lead_id=?, note=?, prof_key=?, assigned=? WHERE email=?`)
      .bind(now, s.score, s.category, s.rec.key, facts.leadId || (facts.contactId ? 'C' + facts.contactId : null), note.slice(0, 200), profKey || null, facts.assignedId ? String(facts.assignedId) : null, email).run();
  }
  const { answers, ...bitrix } = facts;
  return { email, ...s, profile: profileText, bitrix, note };
}

async function runBatch(env) {
  await ensureSchema(env.DB);
  const n = Math.max(1, Math.min(400, parseInt(env.QUEUE_SIZE || '300', 10)));
  const now = Date.now(), deadline = now + 70000;
  // HOT threshold / click rule changed (v35): look again at everyone active in the last 14 days, once.
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, at INTEGER)`).run();
    if (!(await env.DB.prepare(`SELECT v FROM kv WHERE k='rescore_v35'`).first())) {
      await env.DB.prepare(`UPDATE state SET dirty=1 WHERE last_event > ? AND COALESCE(heat,'') IN ('WARM','COLD','HOT')`).bind(now - 14 * DAY).run();
      await env.DB.prepare(`INSERT OR REPLACE INTO kv (k, v, at) VALUES ('rescore_v35', '1', ?)`).bind(now).run();
    }
  } catch (e) { /* not important */ }
  // Changed people first; then people whose heat should decay (scored >24h ago, active in last 30 days).
  const { results } = await env.DB.prepare(
    `SELECT email, rec_key FROM state
      WHERE dirty=1 OR (scored_at < ? AND last_event > ? AND COALESCE(heat,'') NOT IN ('DO NOT CONTACT','CLIENT','LOW PRIORITY','HIVE'))
      ORDER BY dirty DESC, pri DESC, last_event DESC LIMIT ?`)
    .bind(now - DAY, now - 30 * DAY, n).all();

  // 1. Sort the queue without Bitrix: who is "cold, nothing to say" and who needs a full look.
  //    Events are read 100 people per query.
  const evBy = {};
  // D1 allows at most 100 bound values per query (90 emails + the date).
  for (let i = 0; i < results.length; i += 90) {
    const chunk = results.slice(i, i + 90).map(r => r.email);
    const { results: ev } = await env.DB.prepare(
      `SELECT email, type, ts FROM events WHERE ts>=? AND email IN (${chunk.map(() => '?').join(',')}) ORDER BY ts`)
      .bind(now - 120 * DAY, ...chunk).all();
    for (const e of ev) (evBy[e.email] = evBy[e.email] || []).push(e);
  }
  const cold = [], full = [];
  for (const r of results) {
    const pre = scoreEmail(evBy[r.email] || [], {}, now);
    if (pre.rec.key === 'none' && pre.category === 'COLD' && (!r.rec_key || r.rec_key === 'none')) cold.push({ email: r.email, pre });
    else full.push(r.email);
  }

  // 2. Cold ones: one bundled status lookup per 50 people. Anyone in "Failed to pay" moves to the full list.
  const done = [];
  if (cold.length) {
    const names = await leadStatuses(env);
    const take = cold.slice(0, Math.max(0, (budgetLeft() - 2) * 50));
    const b = await bxBatch(env, take.map((c, i) => ['c' + i, 'crm.lead.list', { filter: { EMAIL: c.email }, select: ['ID', 'STATUS_ID'] }])).catch(() => null);
    if (b) {
      for (let i = 0; i < take.length; i++) {
        const leads = b.result['c' + i] || [];
        if (leads.some(l => isFailedPayStatus(names[l.STATUS_ID]))) { full.unshift(take[i].email); continue; }
        await env.DB.prepare(`UPDATE state SET dirty=0, scored_at=?, score=?, heat=?, rec_key='none', note='cold, not written' WHERE email=?`)
          .bind(now, take[i].pre.score, take[i].pre.category, take[i].email).run();
        done.push('cold, not written');
      }
    }
  }

  // 3. Full look, one person at a time, while the call budget lasts (2 bundled calls each).
  for (const email of full) {
    if (Date.now() > deadline || budgetLeft() < 3) break;
    try { done.push((await scoreOne(env, email, { forceFull: true })).note); }
    catch (e) {
      done.push('error: ' + e.message);
      if (/budget/.test(e.message)) break; // not this person's fault; try again next run
      await env.DB.prepare(`UPDATE state SET last_event=last_event-1, note=? WHERE email=?`)
        .bind(('error: ' + e.message).slice(0, 200), email).run();
    }
  }
  return { processed: done.length, queue: results.length, notes: done };
}

// ---------------------------------------------------------------- inputs
const MAILGUN_MAP = { opened: 'open', clicked: 'click', unsubscribed: 'unsub', complained: 'complain' };

async function onMailgun(req, env) {
  const body = await req.json().catch(() => null);
  const sig = body && body.signature;
  if (!sig || !env.MAILGUN_SIGNING_KEY) return json({ ok: false }, 401);
  const expect = await hmacHex(env.MAILGUN_SIGNING_KEY, String(sig.timestamp) + String(sig.token));
  if (!safeEqual(expect, String(sig.signature))) return json({ ok: false }, 401);
  if (Math.abs(Date.now() / 1000 - Number(sig.timestamp)) > 3600) return json({ ok: false, reason: 'stale' }, 401);

  const d = body['event-data'] || {};
  // A campaign email reached someone: remembered, and written onto their lead in bulk later.
  if (d.event === 'delivered') {
    const em = String(d.recipient || '').trim().toLowerCase();
    if (em) {
      const ts = Math.round(Number(d.timestamp || Date.now() / 1000) * 1000);
      await ensureMailed(env.DB);
      await env.DB.prepare(`INSERT INTO mailed (email, last_ts, pending, first_ts, n) VALUES (?, ?, 1, ?, 1)
        ON CONFLICT(email) DO UPDATE SET last_ts = MAX(last_ts, excluded.last_ts), pending = pending + 1,
          first_ts = MIN(COALESCE(first_ts, excluded.first_ts), excluded.first_ts), n = COALESCE(n, 0) + 1`).bind(em, ts, ts).run();
    }
    return json({ ok: true });
  }
  let type = MAILGUN_MAP[d.event];
  if (d.event === 'failed' && d.severity === 'permanent') type = 'bounce';
  if (!type) return json({ ok: true, ignored: d.event }); // Mailgun must get a 200 or it retries
  const meta = {};
  if (d.tags && d.tags.length) meta.campaign = d.tags.join(',');
  if (d['user-variables'] && d['user-variables'].campaign) meta.campaign = String(d['user-variables'].campaign);
  if (d.url) meta.url = String(d.url).slice(0, 200);
  // Mailgun flags opens/clicks made by machines, not people: Apple Mail Privacy
  // Protection preloads every email, Gmail's proxy, and security scanners that
  // "click" every link. Those are stored as open_bot / click_bot and not scored.
  const bot = d['client-info'] && d['client-info'].bot;
  const isBot = !!bot && (type === 'open' || type === 'click');
  if (isBot) { type = type + '_bot'; meta.bot = String(bot).slice(0, 20); }
  const ts = Math.round(Number(d.timestamp || Date.now() / 1000) * 1000);
  await record(env.DB, d.recipient, type, ts, meta, d.id ? 'mg:' + d.id : null, isBot);
  return json({ ok: true });
}

// "Date when the last mailing was sent" / "Number of mailings sent" on leads AND contacts, from
// Mailgun "delivered" events (every email that really reached the person, campaigns included).
// The mailed table itself is the record of truth: /admin/mailed answers "who got nothing in N days".
// Flushed to Bitrix in chunks of 50 people while this run's call budget lasts. Protected lead stages untouched.
const MAILED_TABLE = `CREATE TABLE IF NOT EXISTS mailed (email TEXT PRIMARY KEY, last_ts INTEGER, pending INTEGER)`;
let mailedReady = false;
async function ensureMailed(db) {
  if (mailedReady) return;
  await db.prepare(MAILED_TABLE).run();
  for (const col of ['first_ts INTEGER', 'n INTEGER']) {
    try { await db.prepare(`ALTER TABLE mailed ADD COLUMN ${col}`).run(); } catch (e) { /* already there */ }
  }
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS mailed_last ON mailed(last_ts)`).run(); } catch (e) { /* fine */ }
  mailedReady = true;
}
export async function flushMailed(env, max = 1000) {
  const db = env.DB;
  await ensureMailed(db);
  const lf = await entityFields(env, 'lead').catch(() => ({})) || {};
  const cf = await entityFields(env, 'contact').catch(() => ({})) || {};
  const leadOk = !!(lf.lastMail || lf.mailCount), contactOk = !!(cf.lastMail || cf.mailCount);
  if (!leadOk && !contactOk) return { flushed: 0, error: 'mailing fields not found' };
  const protectedList = (env.SCORE_PROTECTED ? env.SCORE_PROTECTED.split(',') : DEFAULT_PROTECTED).map(x => x.trim());
  // Leave room for scoring in the same run.
  const reserve = Math.max(10, Math.floor(subMax * 0.3));
  let flushed = 0, leadsUpdated = 0, contactsUpdated = 0;
  while (flushed < max && budgetLeft() - reserve >= 6) {
    const { results } = await db.prepare(`SELECT email, last_ts, pending FROM mailed WHERE pending > 0 ORDER BY last_ts LIMIT 50`).all();
    if (!results.length) break;
    const look = [];
    results.forEach((r, i) => {
      if (leadOk) look.push(['l' + i, 'crm.lead.list', { filter: { EMAIL: r.email }, select: ['ID', 'STATUS_ID', ...(lf.mailCount ? [lf.mailCount] : [])] }]);
      if (contactOk) look.push(['c' + i, 'crm.contact.list', { filter: { EMAIL: r.email }, select: ['ID', ...(cf.mailCount ? [cf.mailCount] : [])] }]);
    });
    const b = await bxBatch(env, look);
    const ups = [];
    const fieldsFor = (fm, rec, r) => ({
      ...(fm.lastMail ? { [fm.lastMail]: localParts(r.last_ts).day } : {}),
      ...(fm.mailCount ? { [fm.mailCount]: (parseInt(rec[fm.mailCount], 10) || 0) + r.pending } : {}),
    });
    results.forEach((r, i) => {
      for (const l of (b.result['l' + i] || []).slice(0, 3)) {
        if (protectedList.includes(String(l.STATUS_ID))) continue;
        ups.push(['u' + ups.length, 'crm.lead.update', { id: l.ID, fields: fieldsFor(lf, l, r), params: { REGISTER_SONET_EVENT: 'N' } }]);
        leadsUpdated++;
      }
      for (const c of (b.result['c' + i] || []).slice(0, 3)) {
        ups.push(['u' + ups.length, 'crm.contact.update', { id: c.ID, fields: fieldsFor(cf, c, r), params: { REGISTER_SONET_EVENT: 'N' } }]);
        contactsUpdated++;
      }
    });
    if (ups.length) {
      if (budgetLeft() < Math.ceil(ups.length / 50) + 1) break; // not enough calls left: try again next run
      await bxBatch(env, ups);
    }
    const done = results.filter((r, i) => !b.error['l' + i] && !b.error['c' + i]);
    if (!done.length) break;
    for (let i = 0; i < done.length; i += 50)
      await db.batch(done.slice(i, i + 50).map(r => db.prepare(`UPDATE mailed SET pending = MAX(0, pending - ?) WHERE email = ?`).bind(r.pending, r.email)));
    flushed += done.length;
  }
  return { flushed, leadsUpdated, contactsUpdated };
}

// Who got an email from us, and when, according to Mailgun "delivered" events.
async function mailedReport(env, u) {
  const db = env.DB;
  await ensureMailed(db);
  const days = Math.max(1, parseInt(u.searchParams.get('days') || '30', 10));
  const cut = Date.now() - days * DAY;
  const s = await db.prepare(`SELECT COUNT(*) total, MIN(COALESCE(first_ts, last_ts)) since, MAX(last_ts) latest,
      SUM(last_ts < ?) older, SUM(pending > 0) waiting FROM mailed`).bind(cut).first();
  const day = (ts) => (ts ? localParts(ts).day : null);
  const out = {
    ok: true, days,
    trackingSince: day(s.since), latestDelivery: day(s.latest),
    emailsTracked: s.total || 0,
    mailedWithinDays: (s.total || 0) - (s.older || 0),
    lastMailOlderThanDays: s.older || 0,
    waitingToBeWrittenToBitrix: s.waiting || 0,
    note: 'Only emails delivered since trackingSince are known. An address missing from this table got nothing from us since then.',
  };
  const list = u.searchParams.get('list');
  if (list === 'old' || list === 'all') {
    const q = list === 'old'
      ? db.prepare(`SELECT email, last_ts, n FROM mailed WHERE last_ts < ? ORDER BY last_ts LIMIT 50000`).bind(cut)
      : db.prepare(`SELECT email, last_ts, n FROM mailed ORDER BY last_ts LIMIT 50000`);
    const { results } = await q.all();
    if (u.searchParams.get('format') === 'csv') {
      const csv = 'email,last_delivered,emails_delivered\n' + results.map(r => `${r.email},${day(r.last_ts)},${r.n || ''}`).join('\n');
      return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="mailed-${list}.csv"` } });
    }
    out.list = results.map(r => [r.email, day(r.last_ts), r.n || null]);
  }
  return json(out);
}

// The exact payloads the pages already send to ias-crm, forwarded as-is.
function mapCrmPayload(p) {
  if (!p || !p.e) return null;
  const meta = p.campaign ? { campaign: String(p.campaign).slice(0, 80) } : null;
  switch (p.crm) {
    case 'answer': return { type: String(p.answer).toLowerCase() === 'no' ? 'answer_no' : 'answer_yes', meta };
    case 'assess': return { type: p.partial ? 'assess_partial' : 'assess_full', meta };
    case 'find':
    case 'lookup': return { type: 'view', meta };
    default: return null; // note, prefill: not engagement
  }
}

async function onForward(req, env) {
  if (!keyOk(req, env)) return json({ ok: false }, 401);
  const p = await req.json().catch(() => null);
  const m = mapCrmPayload(p);
  if (!m) return json({ ok: true, ignored: true });
  await record(env.DB, p.e, m.type, Date.now(), m.meta);
  return json({ ok: true });
}

async function onPage(req, env) {
  const h = cors(req);
  if (!h['access-control-allow-origin']) return json({ ok: false }, 403);
  const p = await req.json().catch(() => null);
  if (!p || !PAGE_TYPES.has(p.type)) return json({ ok: false }, 400, h);
  const meta = { page: String(p.page || '').slice(0, 60) };
  if (p.campaign) meta.campaign = String(p.campaign).slice(0, 80);
  // A page visit counts once per page per hour, so refreshing does not inflate anything.
  const hour = Math.floor(Date.now() / 3600000);
  const ext = p.type === 'view' ? `pv:${String(p.email).toLowerCase()}:${meta.page}:${hour}` : null;
  await record(env.DB, p.email, p.type, Date.now(), meta, ext);
  return json({ ok: true }, 200, h);
}

// ---------------------------------------------------------------- setup
const FIELDS = [
  ['IAS_SCORE', 'double', 'Engagement score (0-100)'],
  ['IAS_HEAT', 'string', 'Engagement heat'],
  ['IAS_NEXT', 'string', 'Recommended next step'],
  ['IAS_SIGNALS', 'string', 'Engagement signals'],
];
async function setup(env) {
  const existing = await bx(env, 'crm.lead.userfield.list', { filter: {} }) || [];
  const have = new Set(existing.map(f => f.FIELD_NAME));
  const made = [];
  for (const [name, type, label] of FIELDS) {
    if (have.has('UF_CRM_' + name)) { made.push('exists UF_CRM_' + name); continue; }
    await bx(env, 'crm.lead.userfield.add', {
      fields: { FIELD_NAME: name, USER_TYPE_ID: type, EDIT_FORM_LABEL: label, LIST_COLUMN_LABEL: label, LIST_FILTER_LABEL: label, SHOW_FILTER: 'Y' },
    });
    made.push('created UF_CRM_' + name);
  }
  return made;
}

// ---------------------------------------------------------------- agents
const userNames = {};
async function userName(env, id) {
  if (userNames[id]) return userNames[id];
  const u = await bx(env, 'user.get', { ID: id }).catch(() => null);
  const x = Array.isArray(u) ? u[0] : null;
  userNames[id] = x ? [x.NAME, x.LAST_NAME].filter(Boolean).join(' ') || 'Responsible' : 'Responsible';
  return userNames[id];
}

const topMoves = (a) => Object.entries(a.moveTo).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ');

// Bitrix users that are robots / shared inboxes, not people: no personal message.
const isAutomationUser = (name) => /\bauto\b|automation|update|\bbot\b|^cinfo\b|system|integration/i.test(String(name || '').trim());

// People who should not get the personal "Your day" message (managers, admins).
// Override with NO_PERSONAL (comma-separated names) / NO_PERSONAL_IDS.
const DEFAULT_NO_PERSONAL = 'Gal Pool, Gal Behrend, Thomas De Luca, Nathan Levdanskyi, Jonathan Skariszewski, James Miller, Michael';
const DEFAULT_NO_PERSONAL_IDS = '1,522';
const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
function noPersonal(env, id, name) {
  const ids = (env.NO_PERSONAL_IDS || DEFAULT_NO_PERSONAL_IDS).split(',').map(x => x.trim());
  const names = (env.NO_PERSONAL || DEFAULT_NO_PERSONAL).split(',').map(norm).filter(Boolean);
  return ids.includes(String(id)) || names.includes(norm(name));
}

// ---------------------------------------------------------------- daily summary (18:00 Israel)
const TZ = 'Asia/Jerusalem';
function localParts(ts = Date.now()) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, timeZoneName: 'shortOffset' });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  const off = (p.timeZoneName || 'GMT+3').replace('GMT', '') || '+0';
  const [h, m] = off.split(':');
  const offset = `${off[0] === '-' ? '-' : '+'}${String(Math.abs(parseInt(h, 10))).padStart(2, '0')}:${(m || '00').padStart(2, '0')}`;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24, offset };
}

const REASON_TIPS = [
  [/straight away|immediately|hung up in the middle/i, 'Most said no in the first moments of the call: work on how you open it. Say who you are, mention what they actually did (the questionnaire, the payment page, the email they answered), and ask one question about their plans before any offer.'],
  [/hung up on payment|payment/i, 'They drop at the payment step: stay on the line while they pay, and say exactly what happens after payment.'],
  [/mistake|didn.?t sign|not register/i, 'Many say they signed up by mistake: worth telling the managers which source these came from.'],
  [/not ready|think about|later|not now|timing|next year/i, 'Timing: book a dated follow-up instead of closing as Not Interested.'],
  [/price|expens|cost|money|afford|budget/i, 'Price is the main objection: open with what the client gets and the payment options, not the fee.'],
  [/trust|scam|fraud|legit|fake|review/i, 'Trust is the main objection: say who handles the case, show credentials and reviews, and explain exactly what happens after they pay.'],
  [/complic|complex|process|understand|confus|long/i, 'They find it complicated: explain it as three simple steps and tell them the first one.'],
  [/later|not now|timing|time|next year|think/i, 'Timing: book a dated follow-up instead of closing as Not Interested.'],
  [/spouse|wife|husband|family/i, 'Family decision: offer a short call with the spouse on the line.'],
];

// Who gets what (override with env vars, comma-separated names).
// LEADS_TEAM: lead agents, reported to the team lead (David Russo).
// SALES_TEAM: closers / client agents, reported to the sales manager (Ben Buchnik).
// Only people on one of these two lists get a personal "Your day" message.
const DEFAULT_LEADS_TEAM = 'Lilly Macalister, Daniel Harris, Dave Grant, Richard Basil, Tom Vasquez, Michael Harper, Leonard White, Philip Dvorak, Febe R. Guadalquiver, Caroline Hansen, Emily Daren';
const DEFAULT_SALES_TEAM = 'Mark Cross, Zack Robbins, Stacy Wells, Zurab Dachshvili, Viviane De Luca, Caroline Hansen, Mark Anderson, Nikki Smith, Michael Harper, Emily Daren, Christine Williams';
const listOf = (csv) => String(csv || '').split(',').map(norm).filter(Boolean);
const leadsTeam = (env) => listOf(env.LEADS_TEAM ?? DEFAULT_LEADS_TEAM);
const salesTeam = (env) => listOf(env.SALES_TEAM ?? DEFAULT_SALES_TEAM);

// All pages of a list in 2 Bitrix calls: page 1, then every other page in one batch.
async function bxAllFast(env, method, params, max = 5000) {
  const p = { order: { ID: 'ASC' }, ...params };
  const first = await bxBatch(env, [['p0', method, { ...p, start: 0 }]]);
  if (first.error.p0) throw new Error(`Bitrix ${method}: ${JSON.stringify(first.error.p0).slice(0, 120)}`);
  const rows = [...(first.result.p0 || [])];
  const total = first.total.p0;
  if (total == null) return rows.length < 50 ? rows : bxAll(env, method, params, max);
  const pages = [];
  for (let s = 50; s < Math.min(total, max); s += 50) pages.push(['p' + s, method, { ...p, start: s }]);
  if (pages.length) {
    const b = await bxBatch(env, pages);
    for (const [k] of pages) rows.push(...(b.result[k] || []));
  }
  return rows;
}

const money = (deals) => {
  const by = {};
  for (const d of deals) { const c = d.CURRENCY_ID || ''; by[c] = (by[c] || 0) + (parseFloat(d.OPPORTUNITY) || 0); }
  const parts = Object.entries(by).filter(([, v]) => v).map(([c, v]) => `${Math.round(v).toLocaleString('en-US')}${c ? ' ' + c : ''}`);
  return parts.length ? ' (' + parts.join(' + ') + ')' : '';
};
const isPaidStatus = (id, name) => id === 'CONVERTED' || /\bpaid\b/i.test(name || '');

export async function buildDigest(env, { day, offset } = localParts()) {
  const since = `${day}T00:00:00${offset}`, sinceTs = Date.parse(since);
  // Bitrix ignores the date filter on timeline comments, so today's notes are picked out here.
  const isToday = (c) => Date.parse(c.CREATED || '') >= sinceTs;
  const monthStart = `${day.slice(0, 8)}01T00:00:00${offset}`;
  const T0 = Date.now(), tm = {}; const mark = (k) => { tm[k] = Date.now() - T0; };
  const names = await leadStatuses(env);
  const niIds = Object.entries(names).filter(([, n]) => isNotInterestedStatus(n)).map(([id]) => id);

  // Reason field on leads, if there is one ("reason" in its label).
  const lf = await bx(env, 'crm.lead.fields', {}).catch(() => ({})) || {};
  let reasonCode = null, reasonItems = {};
  for (const [c, f] of Object.entries(lf)) {
    if (!c.startsWith('UF_CRM_')) continue;
    const label = [f.title, f.listLabel, f.formLabel].join(' ');
    if (/reason|סיבה/i.test(label) && /not.?interest|NI|lost|refus|reason/i.test(label)) {
      reasonCode = c; (f.items || []).forEach(it => { reasonItems[it.ID] = it.VALUE; }); break;
    }
  }

  const moved = (x) => (Date.parse(x.MOVED_TIME) || Date.parse(x.DATE_MODIFY) || 0) >= sinceTs;
  const srcs = await sourceNames(env);
  const notHive = (x) => !isHive(srcs[x.SOURCE_ID], x.SOURCE_DESCRIPTION);
  // Who changed the status (not who the lead is assigned to now: NI leads get re-assigned).
  const mover = (l) => l.MOVED_BY_ID && l.MOVED_BY_ID !== '0' ? l.MOVED_BY_ID : l.ASSIGNED_BY_ID;
  const niRaw = niIds.length ? await bxAllFast(env, 'crm.lead.list', {
    filter: { STATUS_ID: niIds, '>=MOVED_TIME': since },
    select: ['ID', 'ASSIGNED_BY_ID', 'MOVED_BY_ID', 'MOVED_TIME', 'DATE_MODIFY', 'SOURCE_ID', 'SOURCE_DESCRIPTION', ...(reasonCode ? [reasonCode] : [])],
  }) : [];
  const ni = niRaw.filter(moved).filter(notHive);
  mark('ni');
  const wonMonth = (await bxAllFast(env, 'crm.deal.list', {
    filter: { STAGE_SEMANTIC_ID: 'S', '>=MOVED_TIME': monthStart },
    select: ['ID', 'ASSIGNED_BY_ID', 'MOVED_TIME', 'DATE_MODIFY', 'SOURCE_ID', 'SOURCE_DESCRIPTION', 'OPPORTUNITY', 'CURRENCY_ID', 'CONTACT_ID'],
  }).catch(() => [])).filter(notHive);
  const won = wonMonth.filter(moved);
  mark('deals');

  // Which of today's Not Interested leads had a completed call or meeting first.
  const called = new Set();
  for (let i = 0; i < ni.length && budgetLeft() > 12; i += 50) {
    const ids = ni.slice(i, i + 50).map(x => x.ID);
    const acts = await bxAll(env, 'crm.activity.list', {
      filter: { OWNER_TYPE_ID: 1, OWNER_ID: ids, TYPE_ID: [1, 2], COMPLETED: 'Y' }, select: ['OWNER_ID'],
    }, 500).catch(() => []);
    acts.forEach(a => called.add(String(a.OWNER_ID)));
  }
  mark('niCalls');

  const agents = {};
  const A = (id) => (agents[id] = agents[id] || { contacts: new Set(), cNotes: 0, cCalls: 0, ctypes: {}, ni: 0, called: 0, sales: 0, salesMonth: 0, wonToday: [], wonMonth: [], reasons: {}, received: 0, rNi: 0, rNa: 0, rWon: 0, untouched: 0, calls: 0, notes: 0, moves: 0, moveTo: {}, worked: new Set() });
  for (const l of ni) {
    const a = A(mover(l)); a.ni++;
    if (called.has(String(l.ID))) a.called++;
    if (reasonCode && l[reasonCode]) {
      const vals = Array.isArray(l[reasonCode]) ? l[reasonCode] : [l[reasonCode]];
      for (const v of vals) { const r = reasonItems[v] || String(v); if (r) a.reasons[r] = (a.reasons[r] || 0) + 1; }
    }
  }
  for (const d of won) { const a = A(d.ASSIGNED_BY_ID); a.sales++; a.wonToday.push(d); }
  for (const d of wonMonth) { const a = A(d.ASSIGNED_BY_ID); a.salesMonth++; a.wonMonth.push(d); }

  // Who is waiting for them tomorrow.
  await ensureSchema(env.DB);
  const { results: hot } = await env.DB.prepare(
    `SELECT assigned, SUM(heat='HOT') hot, SUM(heat='WARM') warm FROM state WHERE assigned IS NOT NULL GROUP BY assigned`).all();
  const waiting = Object.fromEntries(hot.map(r => [String(r.assigned), r]));

  // ---- today's new leads by source, and the status each one is in now
  const created = (await bxAllFast(env, 'crm.lead.list', {
    filter: { '>=DATE_CREATE': since }, select: ['ID', 'SOURCE_ID', 'SOURCE_DESCRIPTION', 'STATUS_ID', 'ASSIGNED_BY_ID'],
  })).filter(notHive);
  mark('created');
  const bySource = {}, bySourceStatus = {}, statusTotals = {};
  let cNi = 0, cNa = 0, cWon = 0;
  for (const l of created) {
    const src = srcs[l.SOURCE_ID] || l.SOURCE_ID || 'Unknown';
    bySource[src] = (bySource[src] || 0) + 1;
    const st = names[l.STATUS_ID] || l.STATUS_ID || '?';
    (bySourceStatus[src] = bySourceStatus[src] || {})[st] = (bySourceStatus[src][st] || 0) + 1;
    statusTotals[st] = (statusTotals[st] || 0) + 1;
    const a = l.ASSIGNED_BY_ID ? A(l.ASSIGNED_BY_ID) : null;
    if (a) a.received++;
    if (isNotInterestedStatus(st)) { cNi++; if (a) a.rNi++; }
    else if (isNoAnswerStatus(st)) { cNa++; if (a) a.rNa++; }
    else if (isPaidStatus(l.STATUS_ID, st)) { cWon++; if (a) a.rWon++; }
    else if (l.STATUS_ID === 'NEW') { if (a) a.untouched++; }
  }
  // Status changes made today, by the person who made them (any status, incl. NA / NI).
  const moves = (await bxAllFast(env, 'crm.lead.list', {
    filter: { '>=MOVED_TIME': since }, select: ['ID', 'ASSIGNED_BY_ID', 'MOVED_BY_ID', 'STATUS_ID', 'MOVED_TIME', 'SOURCE_ID', 'SOURCE_DESCRIPTION'],
  }).catch(() => [])).filter(moved).filter(notHive).filter(l => l.STATUS_ID !== 'NEW');
  mark('moves');
  for (const l of moves) {
    const who = mover(l);
    if (!who) continue;
    const a = A(who); a.moves++; a.worked.add(String(l.ID));
    const st = names[l.STATUS_ID] || l.STATUS_ID; a.moveTo[st] = (a.moveTo[st] || 0) + 1;
  }

  // ---- clients (contacts) created today = paid online today, and what happened with them
  const newClients = (await bxAllFast(env, 'crm.contact.list', {
    filter: { '>=DATE_CREATE': since }, select: ['ID', 'NAME', 'LAST_NAME', 'ASSIGNED_BY_ID', 'SOURCE_ID', 'SOURCE_DESCRIPTION'],
  }).catch(() => [])).filter(notHive).slice(0, 200);
  const clientDeals = {}, clientNotes = {};
  if (newClients.length) {
    const cmds = [];
    for (let i = 0; i < newClients.length; i += 20) {
      cmds.push(['d' + i, 'crm.deal.list', { filter: { CONTACT_ID: newClients.slice(i, i + 20).map(c => c.ID) }, select: ['ID', 'CONTACT_ID', 'STAGE_SEMANTIC_ID', 'ASSIGNED_BY_ID', 'OPPORTUNITY', 'CURRENCY_ID'] }]);
    }
    for (const c of newClients) cmds.push(['n' + c.ID, 'crm.timeline.comment.list', { filter: { ENTITY_TYPE: 'contact', ENTITY_ID: c.ID, '>=CREATED': since }, select: ['ID', 'AUTHOR_ID', 'CREATED', 'COMMENT'], order: { ID: 'DESC' } }]);
    const b = await bxBatch(env, cmds).catch(() => ({ result: {} }));
    for (const [k, list] of Object.entries(b.result || {})) {
      if (k[0] === 'd') for (const d of list || []) (clientDeals[d.CONTACT_ID] = clientDeals[d.CONTACT_ID] || []).push(d);
      if (k[0] === 'n') clientNotes[k.slice(1)] = (list || []).filter(c => c.AUTHOR_ID && isToday(c) && !isOwnComment(c.COMMENT)).length;
    }
  }
  mark('newClients');
  let upgraded = 0, handled = 0;
  const notHandled = [];
  for (const c of newClients) {
    const wonDeals = (clientDeals[c.ID] || []).filter(d => d.STAGE_SEMANTIC_ID === 'S');
    if (wonDeals.length >= 2) { upgraded++; handled++; }
    else if (clientNotes[c.ID]) handled++;
    else notHandled.push(c);
  }

  // ---- sales agents work on contacts: contacts they touched today, their notes and calls there
  const salesUsers = (await usersByName(env, env.SALES_TEAM_IDS, env.SALES_TEAM ?? DEFAULT_SALES_TEAM).catch(() => [])).filter(u => u.id);
  const salesIdSet = new Set(salesUsers.map(u => String(u.id)));
  for (const u of salesUsers) if (!userNames[u.id]) userNames[u.id] = u.name;
  if (!contactTypeCache) {
    const ct = await bx(env, 'crm.status.list', { filter: { ENTITY_ID: 'CONTACT_TYPE' } }).catch(() => []) || [];
    contactTypeCache = Object.fromEntries(ct.map(x => [x.STATUS_ID, x.NAME])); contactTypeAt = Date.now();
  }
  const touched = salesIdSet.size ? (await bxAllFast(env, 'crm.contact.list', {
    filter: { '>=DATE_MODIFY': since, ASSIGNED_BY_ID: [...salesIdSet] }, select: ['ID', 'ASSIGNED_BY_ID', 'MODIFY_BY_ID', 'TYPE_ID'], order: { DATE_MODIFY: 'DESC' },
  }, 300).catch(() => [])) : [];
  mark('touched');
  for (const c of touched) {
    // Only count it as worked by the agent if the agent made the change (not automation or this system);
    // a note the agent wrote on it (below) also counts.
    if (String(c.MODIFY_BY_ID) !== String(c.ASSIGNED_BY_ID)) continue;
    const a = A(String(c.ASSIGNED_BY_ID)); a.contacts.add(String(c.ID));
    const t = contactTypeCache[c.TYPE_ID] || c.TYPE_ID || '';
    if (t) a.ctypes[t] = (a.ctypes[t] || 0) + 1;
  }
  // Capped so the whole summary stays well under a minute (each batch of 50 lookups takes seconds).
  const cRoom = Math.max(0, Math.min(touched.length, 200, (budgetLeft() - 12) * 50));
  if (cRoom) {
    const cb = await bxBatch(env, touched.slice(0, cRoom).map(c => ['n' + c.ID, 'crm.timeline.comment.list', {
      filter: { ENTITY_TYPE: 'contact', ENTITY_ID: c.ID, '>=CREATED': since }, select: ['ID', 'AUTHOR_ID', 'CREATED', 'COMMENT'], order: { ID: 'DESC' },
    }])).catch(() => ({ result: {} }));
    for (const [k, list] of Object.entries(cb.result || {})) {
      for (const c of list || []) {
        if (!c.AUTHOR_ID || !isToday(c) || isOwnComment(c.COMMENT)) continue;
        const a = A(String(c.AUTHOR_ID)); a.cNotes++; a.contacts.add(k.slice(1));
      }
    }
  }

  mark('contactNotes');
  // Notes written today, by author, on the leads moved or created today (bundled, 50 leads per call).
  const leadIds = [...new Set([...moves.map(l => String(l.ID)), ...created.map(l => String(l.ID))])];
  const room = Math.min(Math.max(0, budgetLeft() - 8), 8) * 50;
  const nb = leadIds.length && room ? await bxBatch(env, leadIds.slice(0, room).map(id => ['n' + id, 'crm.timeline.comment.list', {
    filter: { ENTITY_TYPE: 'lead', ENTITY_ID: id, '>=CREATED': since }, select: ['ID', 'AUTHOR_ID', 'CREATED', 'COMMENT'], order: { ID: 'DESC' },
  }])).catch(() => ({ result: {} })) : { result: {} };
  mark('leadNotes');
  let notesTotal = 0;
  for (const [k, list] of Object.entries(nb.result || {})) {
    for (const c of list || []) {
      if (!c.AUTHOR_ID || !isToday(c) || isOwnComment(c.COMMENT)) continue;
      const a = A(c.AUTHOR_ID); a.notes++; a.worked.add(k.slice(1)); notesTotal++;
    }
  }

  // Calls logged today on leads per agent, and agent names: one bundled request.
  const ids = Object.keys(agents).filter(id => id && id !== 'null');
  const b = ids.length ? await bxBatch(env, [
    ...ids.map(id => ['c' + id, 'crm.activity.list', { filter: { OWNER_TYPE_ID: 1, TYPE_ID: 2, '>=CREATED': since, RESPONSIBLE_ID: id }, select: ['ID'] }]),
    ...ids.filter(id => salesIdSet.has(id)).map(id => ['k' + id, 'crm.activity.list', { filter: { OWNER_TYPE_ID: 3, TYPE_ID: 2, '>=CREATED': since, RESPONSIBLE_ID: id }, select: ['ID'] }]),
    ...ids.filter(id => !userNames[id]).map(id => ['u' + id, 'user.get', { ID: id }]),
  ]).catch(() => ({ result: {}, total: {} })) : { result: {}, total: {} };
  mark('callsNames');
  let callsTotal = 0;
  for (const id of ids) {
    const n = b.total['c' + id] ?? (b.result['c' + id] || []).length;
    agents[id].calls = n; callsTotal += n;
    if (salesIdSet.has(id)) agents[id].cCalls = b.total['k' + id] ?? (b.result['k' + id] || []).length;
    const u = b.result['u' + id];
    if (u && u[0]) userNames[id] = [u[0].NAME, u[0].LAST_NAME].filter(Boolean).join(' ') || 'Responsible';
  }
  const inLeads = (id) => leadsTeam(env).includes(norm(userNames[id]));
  const inSales = (id) => salesIdSet.has(String(id)) || salesTeam(env).includes(norm(userNames[id]));

  const topSt = (o, n = 5) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, n).map(([s, c]) => `${s} ${c}`).join(', ');
  const messages = [];
  for (const [id, a] of Object.entries(agents)) {
    if (!id || id === 'null') continue;
    if (!inLeads(id) && !inSales(id)) continue;
    if (isAutomationUser(userNames[id]) || noPersonal(env, id, userNames[id])) continue;
    if (!a.ni && !a.sales && !a.salesMonth && !a.received && !a.notes && !a.moves && !a.contacts.size) continue;
    const lines = [`[B]Your day - ${day.split('-').reverse().join('/')}[/B]`, `Sales today: ${a.sales}${money(a.wonToday)} · this month: ${a.salesMonth}${money(a.wonMonth)}`];
    if (inLeads(id) || a.ni) lines.push(`Moved to Not Interested: ${a.ni}`);
    if (a.received) lines.push(`New leads you received today: ${a.received}` + (a.untouched ? ` (${a.untouched} still New, not worked yet)` : ''));
    if (inSales(id)) lines.push(`Clients (contacts) you worked today: ${a.contacts.size} (notes written: ${a.cNotes}${a.cCalls ? `, calls logged: ${a.cCalls}` : ''})` + (Object.keys(a.ctypes).length ? ` - ${topSt(a.ctypes, 4)}` : ''));
    if (inLeads(id)) lines.push(`Leads you worked today: ${a.worked.size} (notes written: ${a.notes}, status changes: ${a.moves}${a.moves ? ' - ' + topMoves(a) : ''})`);
    const top = Object.entries(a.reasons).sort((x, y) => y[1] - x[1]).slice(0, 3);
    if (top.length) {
      lines.push('Top Not Interested reasons: ' + top.map(([r, c]) => `${r} (${c})`).join(', '));
      const tip = REASON_TIPS.find(([re]) => re.test(top[0][0]));
      if (tip && a.ni >= 3) lines.push(tip[1]);
    } else if (a.ni >= 5) {
      lines.push(`No reason was recorded for these ${a.ni} - please fill in the Not Interested reason so the pattern can be seen.`);
    }
    const w = waiting[id];
    if (w && (w.hot || w.warm)) lines.push(`Waiting for you: ${w.hot || 0} HOT and ${w.warm || 0} WARM leads. In Leads, filter by Engagement heat = HOT.`);
    messages.push({ userId: id, text: lines.join('\n'), stats: { ...a, worked: a.worked.size, contacts: a.contacts.size, wonToday: a.wonToday.length, wonMonth: a.wonMonth.length } });
  }

  const d = day.split('-').reverse().join('/');
  const agentLines = Object.entries(agents).filter(([id]) => id && id !== 'null').map(([id, a]) => ({ id, a, name: userNames[id] || 'User ' + id }));
  const salesRows = agentLines.filter(x => inSales(x.id)).sort((x, y) => y.a.salesMonth - x.a.salesMonth || y.a.sales - x.a.sales);
  const leadRows = agentLines.filter(x => inLeads(x.id));
  const link = (c) => `[URL=https://immiworld.org/crm/contact/details/${c.ID}/]${[c.NAME, c.LAST_NAME].filter(Boolean).join(' ') || 'Contact ' + c.ID}[/URL]`;

  const clientsBlock = [
    `New clients today (contacts created - paid online): ${newClients.length}`,
    `  Upgraded today: ${upgraded} · handled (note written): ${handled - upgraded} · not handled yet: ${notHandled.length}`,
    ...(notHandled.length ? ['  Not handled yet: ' + notHandled.slice(0, 15).map(link).join(', ') + (notHandled.length > 15 ? ` +${notHandled.length - 15} more` : '')] : []),
  ];
  const sales = [
    `[B]Sales team - ${d}[/B]`,
    `Sales today: ${won.length}${money(won)} · this month: ${wonMonth.length}${money(wonMonth)} (all agents)`,
    ...clientsBlock,
    '',
    '[B]By agent (today · this month)[/B]',
    ...(salesRows.length ? salesRows.map(({ name, a }) => `${name}: sales ${a.sales}${money(a.wonToday)} · month ${a.salesMonth}${money(a.wonMonth)} · worked ${a.contacts.size} clients (${a.cNotes} notes${a.cCalls ? `, ${a.cCalls} calls` : ''})` + (Object.keys(a.ctypes).length ? ` - ${topSt(a.ctypes, 3)}` : '')) : ['No sales recorded for the team this month.']),
  ].join('\n');

  const mgr = [
    `[B]Leads today - ${d}[/B]`,
    `New leads: ${created.length}. HIVE not counted.`,
    `Status now of today's new leads: ${topSt(statusTotals, 8) || 'none'}.`,
    ...Object.entries(bySource).sort((x, y) => y[1] - x[1]).map(([s, n]) => `  ${s}: ${n} - ${topSt(bySourceStatus[s], 4)}`),
    `Paid today: ${won.length} won deals${money(won)} · this month: ${wonMonth.length}${money(wonMonth)}.`,
    `Moved to Not Interested today (all leads): ${ni.length}.`,
    ...clientsBlock,
    '',
    '[B]Lead agents[/B]',
    ...(leadRows.length ? leadRows.sort((x, y) => y.a.received - x.a.received).map(({ name, a }) => `${name}: received ${a.received}, worked ${a.worked.size} (${a.notes} notes, ${a.moves} status changes), ${a.ni} Not Interested, ${a.sales} sales` + (Object.keys(a.reasons).length ? ` - top reason: ${Object.entries(a.reasons).sort((x, y) => y[1] - x[1])[0][0]}` : '')) : ['-']),
    '',
    '[B]Sales agents (today · this month)[/B]',
    ...(salesRows.length ? salesRows.map(({ name, a }) => `${name}: ${a.sales}${money(a.wonToday)} · ${a.salesMonth}${money(a.wonMonth)} · worked ${a.contacts.size} clients (${a.cNotes} notes)`) : ['-']),
  ].join('\n');

  const team = [
    `[B]Team on leads - ${d}[/B]`,
    `New leads today: ${created.length} (HIVE not counted). Status changes today: ${moves.length}. Calls logged in Bitrix: ${callsTotal}.`,
    '',
    ...(leadRows.length ? leadRows.sort((x, y) => y.a.received - x.a.received || y.a.moves - x.a.moves).map(({ name, a }) =>
      `${name}: received ${a.received}` +
      (a.received ? ` (${a.rNa} did not answer, ${a.rNi} Not Interested, ${a.rWon} paid, ${a.untouched} still New)` : '') +
      ` · worked ${a.worked.size} leads (${a.notes} notes, ${a.moves} status changes${a.moves ? ': ' + topMoves(a) : ''})` +
      ` · ${a.ni} moved to Not Interested` + (a.calls ? ` · ${a.calls} calls logged` : '') + ` · ${a.sales} sales`)
      : ['No lead activity recorded today.']),
  ].join('\n');

  const debug = { since, niRaw: niRaw.length, niMovedToday: ni.length, movesToday: moves.length, created: created.length, newClients: newClients.length, wonMonth: wonMonth.length, leadsCheckedForNotes: Math.min(leadIds.length, room), touched: touched.length, notesTotal, callsBudgetLeft: budgetLeft(), ms: tm };
  return { day, debug, teamMessage: team, salesMessage: sales, niStatuses: niIds.map(id => `${id}=${names[id]}`), noAnswerStatuses: Object.entries(names).filter(([, n]) => isNoAnswerStatus(n)).map(([id, n]) => `${id}=${n}`), reasonField: reasonCode, messages, managerMessage: mgr };
}

// Managers who get the full overview (MANAGERS / MANAGER_IDS to override), the team
// lead who gets the lead-agent report (TEAM_LEADS) and the sales manager (SALES_MANAGERS).
const DEFAULT_MANAGERS = 'James Miller, Jonathan Skariszewski, Nathan Levdanskyi, Ben Buchnik';
const DEFAULT_TEAM_LEADS = 'David Russo';
const DEFAULT_SALES_MANAGERS = 'Ben Buchnik';
async function managerIds(env) { return usersByName(env, env.MANAGER_IDS, env.MANAGERS || DEFAULT_MANAGERS); }
async function teamLeadIds(env) { return usersByName(env, env.TEAM_LEAD_IDS, env.TEAM_LEADS || DEFAULT_TEAM_LEADS); }
async function salesManagerIds(env) { return usersByName(env, env.SALES_MANAGER_IDS, env.SALES_MANAGERS || DEFAULT_SALES_MANAGERS); }
async function usersByName(env, ids, namesCsv) {
  if (ids) return ids.split(',').map(x => x.trim()).filter(Boolean).map(id => ({ id, name: id }));
  const people = namesCsv.split(',').map(x => x.trim()).filter(Boolean);
  const b = await bxBatch(env, people.map((full, i) => {
    const [first, ...rest] = full.split(/\s+/);
    return ['p' + i, 'user.get', { FILTER: { NAME: first, LAST_NAME: rest.join(' ') } }];
  })).catch(() => ({ result: {} }));
  return people.map((full, i) => {
    const list = b.result['p' + i] || [];
    const u = list.find(x => x.ACTIVE === true || x.ACTIVE === 'Y') || list[0];
    return u ? { id: String(u.ID), name: full } : { id: null, name: full };
  });
}

// Every kind of summary, sent to ONE person to check them (labelled with who would get each).
async function sendSample(env, to) {
  const d = await buildDigest(env, localParts());
  const pick = (re) => d.messages.find(m => re.test(m.text));
  const msgs = [
    ['Managers (James, Jonathan, Nathan)', d.managerMessage],
    ['Team lead (David Russo)', d.teamMessage],
    ['Sales manager (Ben Buchnik)', d.salesMessage],
    ...[pick(/Leads you worked today/), pick(/Clients \(contacts\) you worked today/)].filter(Boolean)
      .map(m => [`Agent ${userNames[m.userId] || m.userId}`, m.text]),
  ];
  const b = await bxBatch(env, msgs.map(([who, text], i) => ['m' + i, 'im.message.add', { DIALOG_ID: to, MESSAGE: `[I]Preview - what ${who} gets:[/I]\n${text}` }]));
  return { to, sent: msgs.map(([who], i) => who + (b.error['m' + i] ? ': ' + JSON.stringify(b.error['m' + i]).slice(0, 100) : '')), agentsWithMessage: d.messages.length, debug: d.debug };
}

async function sendDigest(env, force = false) {
  const lp = localParts();
  await ensureSchema(env.DB);
  if (!force) {
    const done = await env.DB.prepare(`SELECT day FROM digest_log WHERE day=?`).bind(lp.day).first();
    if (done) return { skipped: 'already sent today' };
  }
  const d = await buildDigest(env, lp);
  const out = d.messages.map(m => [m.userId, m.text, m.userId]);
  for (const m of await managerIds(env)) out.push([m.id, d.managerMessage, 'manager ' + m.name]);
  for (const m of await teamLeadIds(env)) out.push([m.id, d.teamMessage, 'team lead ' + m.name]);
  for (const m of await salesManagerIds(env)) out.push([m.id, d.salesMessage, 'sales manager ' + m.name]);
  const sent = out.filter(([id]) => !id).map(([, , who]) => who + ': not found in Bitrix');
  const go = out.filter(([id]) => id);
  const b = await bxBatch(env, go.map(([id, text], i) => ['m' + i, 'im.message.add', { DIALOG_ID: id, MESSAGE: text }]))
    .catch(e => ({ result: {}, error: Object.fromEntries(go.map((_, i) => ['m' + i, e.message])) }));
  go.forEach(([, , who], i) => sent.push(b.error['m' + i] ? who + ': ' + JSON.stringify(b.error['m' + i]).slice(0, 120) : who));
  await env.DB.prepare(`INSERT OR REPLACE INTO digest_log (day, sent_at, summary) VALUES (?,?,?)`)
    .bind(lp.day, Date.now(), JSON.stringify(sent).slice(0, 2000)).run();
  return { day: lp.day, sent };
}

// ---------------------------------------------------------------- morning campaign report (09:00 Israel)
// Sales = won deals. Each deal is credited to the campaign of the lead it came from.
const CAMPAIGN_IDEAS = [
  [/not ready|think|later|timing|time|lost interest|future/i, 'A "whenever you are ready" check-in: one plain email, no price, asks one question about their timeline, one link to the questionnaire.'],
  [/price|pay|afford|expens|money|cost/i, 'A payment-options email: plain text, the monthly amount or a smaller first step stated up front, one link to the payment page.'],
  [/straight away|hung up|understand|complicat|confus/i, 'An "in 3 steps" email: what we do, what it costs, what happens next - written as one person, one link.'],
  [/trust|scam|fraud|afraid|suspic|legit/i, 'A trust email: who handles the case, how the process works step by step, an offer of a short video call.'],
  [/spouse|wife|husband|family|partner/i, 'A family email: invite both partners to a short call together.'],
];
const STYLE_TIP = 'Keep it plain: written as one person, no design, one specific true reason, one link (in September plain emails converted 41% vs 16% for designed ones).';

const campKey = (x, srcs) => {
  const utm = String(x.UTM_CAMPAIGN || '').trim();
  if (utm) return utm;
  const desc = String(x.SOURCE_DESCRIPTION || '').trim();
  if (/automation\s*\d/i.test(desc)) return desc.match(/automation\s*\d/i)[0].replace(/\s+/, '');
  return (srcs[x.SOURCE_ID] || x.SOURCE_ID || 'Unknown') + (desc && desc.length < 40 ? ' / ' + desc : '');
};

export async function buildCampaignReport(env, { day, offset } = localParts()) {
  const DAYMS = 86400000;
  const today0 = Date.parse(`${day}T00:00:00${offset}`);
  const iso = (ts) => new Date(ts).toISOString();
  const since7 = iso(today0 - 7 * DAYMS), sinceY = iso(today0 - DAYMS);
  const srcs = await sourceNames(env);
  const names = await leadStatuses(env);
  const notHive = (x) => !isHive(srcs[x.SOURCE_ID], x.SOURCE_DESCRIPTION);

  // Leads created in the last 7 days, by campaign.
  const leads = (await bxAllFast(env, 'crm.lead.list', {
    filter: { '>=DATE_CREATE': since7, '<DATE_CREATE': iso(today0) },
    select: ['ID', 'SOURCE_ID', 'SOURCE_DESCRIPTION', 'UTM_CAMPAIGN', 'STATUS_ID', 'DATE_CREATE'],
  }, 8000).catch(() => [])).filter(notHive);
  const byId = Object.fromEntries(leads.map(l => [String(l.ID), l]));
  const C = {};
  const K = (k) => (C[k] = C[k] || { leads: 0, leadsY: 0, ni: 0, na: 0, sales: [], salesY: [] });
  for (const l of leads) {
    const c = K(campKey(l, srcs)); c.leads++;
    if (Date.parse(l.DATE_CREATE) >= today0 - DAYMS) c.leadsY++;
    const st = names[l.STATUS_ID] || '';
    if (isNotInterestedStatus(st)) c.ni++; else if (isNoAnswerStatus(st)) c.na++;
  }

  // Won deals in the last 7 days, credited to their lead's campaign.
  const deals = (await bxAllFast(env, 'crm.deal.list', {
    filter: { STAGE_SEMANTIC_ID: 'S', '>=MOVED_TIME': since7, '<MOVED_TIME': iso(today0) },
    select: ['ID', 'LEAD_ID', 'UTM_CAMPAIGN', 'SOURCE_ID', 'SOURCE_DESCRIPTION', 'OPPORTUNITY', 'CURRENCY_ID', 'MOVED_TIME'],
  }).catch(() => [])).filter(notHive);
  const missing = [...new Set(deals.filter(d => !d.UTM_CAMPAIGN && d.LEAD_ID && !byId[d.LEAD_ID]).map(d => String(d.LEAD_ID)))];
  if (missing.length) {
    const b = await bxBatch(env, Array.from({ length: Math.ceil(missing.length / 50) }, (_, i) =>
      ['l' + i, 'crm.lead.list', { filter: { ID: missing.slice(i * 50, i * 50 + 50) }, select: ['ID', 'SOURCE_ID', 'SOURCE_DESCRIPTION', 'UTM_CAMPAIGN'] }])).catch(() => ({ result: {} }));
    for (const list of Object.values(b.result || {})) for (const l of list || []) byId[String(l.ID)] = l;
  }
  for (const d of deals) {
    const src = d.UTM_CAMPAIGN ? d : (d.LEAD_ID && byId[String(d.LEAD_ID)]) || d;
    const c = K(campKey(src, srcs)); c.sales.push(d);
    if (Date.parse(d.MOVED_TIME) >= today0 - DAYMS) c.salesY.push(d);
  }

  // Email engagement per campaign (Mailgun tags / page links), people not machines.
  await ensureSchema(env.DB);
  const { results: eng } = await env.DB.prepare(
    `SELECT json_extract(meta,'$.campaign') c, type, COUNT(DISTINCT email) n FROM events
     WHERE ts >= ? AND ts < ? AND meta IS NOT NULL AND json_extract(meta,'$.campaign') IS NOT NULL
       AND type IN ('open','click','unsub','checkout','assess_full','view') GROUP BY c, type`).bind(today0 - 7 * DAYMS, today0).all();
  const E = {};
  for (const r of eng) (E[r.c] = E[r.c] || {})[r.type] = r.n;

  // Not Interested reasons this week -> idea for a new campaign.
  let reasonCode = null, reasonItems = {};
  const lf = await bx(env, 'crm.lead.fields', {}).catch(() => ({})) || {};
  for (const [c, f] of Object.entries(lf)) {
    if (!c.startsWith('UF_CRM_')) continue;
    const label = [f.title, f.listLabel, f.formLabel].join(' ');
    if (/reason|סיבה/i.test(label) && /not.?interest|NI|lost|refus|reason/i.test(label)) { reasonCode = c; (f.items || []).forEach(it => { reasonItems[it.ID] = it.VALUE; }); break; }
  }
  const niIds = Object.entries(names).filter(([, n]) => isNotInterestedStatus(n)).map(([id]) => id);
  const reasons = {};
  if (reasonCode && niIds.length) {
    const niLeads = await bxAllFast(env, 'crm.lead.list', { filter: { STATUS_ID: niIds, '>=MOVED_TIME': since7 }, select: ['ID', reasonCode] }, 3000).catch(() => []);
    for (const l of niLeads) for (const v of [].concat(l[reasonCode] || [])) { const r = reasonItems[v] || String(v); if (r) reasons[r] = (reasons[r] || 0) + 1; }
  }

  // ---- the message
  const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '-';
  const rows = Object.entries(C).map(([k, c]) => ({ k, ...c, rate: c.leads ? c.sales.length / c.leads : 0 }));
  const withSales = rows.filter(r => r.sales.length).sort((a, b) => b.sales.length - a.sales.length);
  const ranked = rows.filter(r => r.leads >= 10 && r.sales.length).sort((a, b) => b.rate - a.rate);
  const best = ranked.find(r => r.sales.length >= 2);
  const weak = rows.filter(r => r.leads >= 100).sort((a, b) => a.rate - b.rate)[0];
  const allSales = deals, ySales = deals.filter(d => Date.parse(d.MOVED_TIME) >= today0 - DAYMS);
  const d = (ts) => new Date(ts).toLocaleDateString('en-GB', { timeZone: TZ });
  const line = (r) => `${r.k}: ${r.leads} leads -> ${r.sales.length} sales (${pct(r.sales.length, r.leads)})${money(r.sales)}` + (r.ni ? ` · ${r.ni} NI` : '');

  const engRows = Object.entries(E).map(([c, e]) => ({ c, ...e })).sort((a, b) => (b.click || 0) - (a.click || 0)).slice(0, 6);
  const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const idea = topReasons.map(([r]) => CAMPAIGN_IDEAS.find(([re]) => re.test(r))).find(Boolean);

  const lines = [
    `[B]Campaigns - ${d(today0)}[/B] (sales = won deals, credited to the lead's campaign)`,
    `Yesterday: ${leads.filter(l => Date.parse(l.DATE_CREATE) >= today0 - DAYMS).length} new leads, ${ySales.length} sales${money(ySales)}.`,
    `Last 7 days: ${leads.length} new leads, ${allSales.length} sales${money(allSales)}. HIVE not counted.`,
    '',
    '[B]Where the sales came from (7 days)[/B]',
    ...(withSales.length ? withSales.slice(0, 8).map(line) : ['No won deals in the last 7 days.']),
    ...(ranked.length ? ['', '[B]Best conversion (10+ leads)[/B]', ...ranked.slice(0, 3).map(line)] : []),
    ...(weak && weak.rate < 0.02 ? ['', '[B]Needs attention[/B]', line(weak) + ' - high volume, very few sales.'] : []),
    ...(engRows.length ? ['', '[B]Email engagement (7 days, real people, not machine opens)[/B]', ...engRows.map(e =>
      `${e.c}: opened ${e.open || 0}, clicked ${e.click || 0}` + (e.assess_full ? `, questionnaire ${e.assess_full}` : '') + (e.checkout ? `, payment page ${e.checkout}` : '') + (e.unsub ? `, unsubscribed ${e.unsub}` : ''))] : []),
    '',
    '[B]Recommendation[/B]',
    best ? `1. Send another campaign like "${best.k}": ${best.sales.length} sales from ${best.leads} leads (${pct(best.sales.length, best.leads)}) this week. Same style and offer, a fresh audience or a new subject line.`
      : '1. No campaign had 2+ sales from 10+ leads this week - not enough to call a winner yet.',
    idea ? `2. New idea: the top Not Interested reason this week was "${topReasons[0][0]}" (${topReasons[0][1]}). ${idea[1]}`
      : topReasons.length ? `2. Top Not Interested reason this week: "${topReasons[0][0]}" (${topReasons[0][1]}) - worth a campaign that answers it.` : '2. No Not Interested reasons recorded this week.',
    ...(weak && weak.rate < 0.02 ? [`3. Review "${weak.k}": ${weak.leads} leads for ${weak.sales.length} sales.`] : []),
    STYLE_TIP,
  ];
  return { day, text: lines.join('\n'), debug: { leads: leads.length, deals: deals.length, campaigns: rows.length, reasons: topReasons } };
}

async function sendCampaignReport(env, { force = false, to = null } = {}) {
  const lp = localParts();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS campaign_log (day TEXT PRIMARY KEY, sent_at INTEGER, summary TEXT)`).run();
  if (!force && !to) {
    const done = await env.DB.prepare(`SELECT day FROM campaign_log WHERE day=?`).bind(lp.day).first();
    if (done) return { skipped: 'already sent today' };
  }
  const r = await buildCampaignReport(env, lp);
  const people = to ? [{ id: to, name: 'preview ' + to }] : await managerIds(env);
  const go = people.filter(p => p.id);
  const b = await bxBatch(env, go.map((p, i) => ['m' + i, 'im.message.add', { DIALOG_ID: p.id, MESSAGE: r.text }]));
  const sent = go.map((p, i) => p.name + (b.error['m' + i] ? ': ' + JSON.stringify(b.error['m' + i]).slice(0, 100) : ''));
  if (!to) await env.DB.prepare(`INSERT OR REPLACE INTO campaign_log (day, sent_at, summary) VALUES (?,?,?)`).bind(lp.day, Date.now(), JSON.stringify(sent)).run();
  return { sent, debug: r.debug, text: r.text };
}

// ---------------------------------------------------------------- "We Tried to Reach You" email
// When one of these people changes a contact's type to NA / NA 5 / NA- No Line / Wrong Number,
// the client gets the email once (at most once every 7 days). Starts in 'dry' mode: nothing is
// sent, James gets a note of who WOULD have got it. /admin/na-mail?mode=live switches it on.
const DEFAULT_NA_SENDERS = 'James Miller, Nathan Levdanskyi, Mark Cross, Zack Robbins, Stacy Wells, Zurab Dachshvili, Viviane De Luca, Caroline Hansen, Mark Anderson, Nikki Smith, Michael Harper, Emily Daren, Christine Williams';
const NA_MAIL_TYPES = /^(NA|NA 5|NA-? ?No Line|Wrong Number)$/i;
const NA_MAIL_SUBJECT = 'We Tried to Reach You';
const NA_MAIL_FROM = 'U.S. Immigration Services <support@immigrationadviceservice.org>';
const esc = (s) => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const CALENDLY = 'https://calendly.com/support-ias/immigration-process-guidance';
const FU_SUBJECT = "You Haven't Booked Your Call Yet";
const PUBLIC_BASE = 'https://ias-score.calm-rain-5660.workers.dev';
// Short signature so only our own links can log opens and clicks.
async function trackSig(env, id, m) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SCORE_KEY || 'k'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const b = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(id + '|' + m)));
  return [...b.slice(0, 6)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function trackLinks(env, id, m) {
  if (!id) return { book: CALENDLY, pixel: '' };
  const q = `c=${encodeURIComponent(id)}&m=${m}&s=${await trackSig(env, String(id), m)}`;
  const base = env.PUBLIC_URL || PUBLIC_BASE;
  return { book: `${base}/t/c?${q}`, pixel: `<img src="${base}/t/o?${q}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;">` };
}
// Follow-up: the client opened "We Tried to Reach You" but did not book.
function fuMailHtml(name, t = {}) {
  return naMailHtml(name, t, {
    title: "You Haven't Booked Your Call Yet",
    body: [
      'You recently opened our request to schedule a call with one of our immigration advisors, but your call has not been booked yet.',
      'Booking takes <b>less than a minute</b>, and this call is important for your U.S. immigration case. Simply choose a time that is convenient for you, and an advisor will call you at that exact time.',
    ],
    button: 'Book My Call Now',
  });
}
function naMailHtml(name, t = {}, o = {}) {
  const dear = name ? `Dear ${esc(name)},` : 'Dear Client,';
  const title = o.title || 'We Tried to Reach You';
  const body = o.body || [
    'We recently tried to reach you by phone regarding an important update on your U.S. immigration case. Unfortunately, we were unable to get through.',
    'We would love to connect with you at a time that works best for you. Please use the link below to schedule a short call with one of our immigration advisors at your convenience — it only takes a minute to book.',
  ];
  return `<div><table width="100%" cellpadding="0" cellspacing="0" style="background:#dde3ec;padding:40px 0;"><tbody><tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0" style="background:#f4f1ea;border:1px solid #c7bfa8;border-radius:2px;"><tbody>
<tr><td style="padding:0;border-bottom:3px double #1a3a6b;"><table width="100%" cellpadding="0" cellspacing="0"><tbody><tr><td style="padding:22px 40px 18px;text-align:center;">
<div style="font-family:Georgia,serif;font-size:11px;letter-spacing:4px;color:#7a6f52;text-transform:uppercase;margin-bottom:6px;">Immigration Advice Service</div>
<div style="font-family:Georgia,serif;font-size:19px;font-weight:bold;color:#1a3a6b;line-height:1.4;">${title}</div>
</td></tr></tbody></table></td></tr>
<tr><td style="padding:34px 48px 28px;">
<p style="margin:0 0 18px;font-size:15px;color:#2a2a28;font-family:Georgia,serif;">${dear}</p>
${body.map(x => `<p style="margin:0 0 20px;font-size:14px;color:#3a3a36;font-family:Georgia,serif;line-height:1.8;">${x}</p>`).join('\n')}
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:26px;"><tbody><tr><td align="center">
<a href="${t.book || CALENDLY}" style="display:inline-block;background:#1a3a6b;color:#f4f1ea;font-family:Georgia,serif;font-size:15px;letter-spacing:0.5px;padding:14px 44px;border-radius:2px;text-decoration:none;border:1px solid #1a3a6b;">${o.button || 'Schedule My Call'}</a>
</td></tr></tbody></table>
<p style="margin:0;font-size:13px;color:#8a8270;font-family:Georgia,serif;line-height:1.7;">If you have any questions in the meantime, simply reply to this email and we will be happy to assist you.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;"><tbody><tr><td style="border-top:1px solid #d8d2c0;padding-top:18px;">
<p style="margin:0;font-size:14px;color:#1a3a6b;font-family:Georgia,serif;font-style:italic;">Sincerely,</p>
<p style="margin:4px 0 0;font-size:14px;color:#2a2a28;font-family:Georgia,serif;font-weight:bold;">The Immigration Advice Service Team</p>
<a href="mailto:support@immigrationadviceservice.org" style="color:#7a6f52;text-decoration:none;font-size:12px;font-family:Georgia,serif;">support@immigrationadviceservice.org</a>
</td></tr></tbody></table></td></tr>
<tr><td style="background:#eceae2;padding:16px 40px;border-top:1px solid #c7bfa8;text-align:center;"><p style="margin:0;font-size:11px;color:#9a917c;font-family:Georgia,serif;letter-spacing:0.5px;">IMMIGRATION ADVICE SERVICE &nbsp;·&nbsp; <a href="https://immigrationadviceservice.org" style="color:#9a917c;text-decoration:none;">immigrationadviceservice.org</a></p></td></tr>
</tbody></table>${t.pixel || ''}</td></tr></tbody></table></div>`;
}

export async function naMailRun(env) {
  const db = env.DB;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, at INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS ctype (contact_id TEXT PRIMARY KEY, type_id TEXT, at INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS na_mail (id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id TEXT, email TEXT, type TEXT, by_id TEXT, mode TEXT, at INTEGER, result TEXT)`),
    db.prepare(TRACK_TABLE),
  ]);
  const get = async (k) => (await db.prepare(`SELECT v FROM kv WHERE k=?`).bind(k).first() || {}).v;
  const set = (k, v) => db.prepare(`INSERT OR REPLACE INTO kv (k, v, at) VALUES (?,?,?)`).bind(k, String(v), Date.now()).run();
  const mode = (await get('na_mail_mode')) || 'dry';
  if (mode === 'off') return { mode };
  const now = Date.now();
  const sinceTs = Number(await get('na_mail_since')) || now - 20 * 60000;
  const since = new Date(sinceTs - 60000).toISOString();

  if (!contactTypeCache || Date.now() - contactTypeAt > 3600000) {
    const ct = await bx(env, 'crm.status.list', { filter: { ENTITY_ID: 'CONTACT_TYPE' } }).catch(() => []) || [];
    contactTypeCache = Object.fromEntries(ct.map(x => [x.STATUS_ID, x.NAME])); contactTypeAt = Date.now();
  }
  const naIds = Object.entries(contactTypeCache).filter(([, n]) => NA_MAIL_TYPES.test(String(n).trim())).map(([id]) => id);
  // Who may trigger it (cached for a day).
  let senders = JSON.parse((await get('na_mail_senders2')) || 'null');
  if (!senders || !senders.missing || now - senders.at > 86400000) {
    const us = await usersByName(env, env.NA_MAIL_SENDER_IDS, env.NA_MAIL_SENDERS || DEFAULT_NA_SENDERS).catch(() => []);
    // Known Bitrix ids for people whose name search can miss (e.g. a middle name in Bitrix).
    senders = { at: now, ids: [...new Set([...us.filter(u => u.id).map(u => String(u.id)), ...(env.NA_MAIL_SENDER_IDS ? [] : ['147', '276', '537', '861', '1361', '159', '1148', '90'])])], missing: us.filter(u => !u.id).map(u => u.name),
      names: Object.fromEntries(us.filter(u => u.id).map(u => [String(u.id), u.name])) };
    await set('na_mail_senders2', JSON.stringify(senders));
  }
  // A contact seen for the first time has no "before" type. Once every contact that already has
  // an NA type is recorded, a first-seen NA contact really did just change; until then, skip them.
  const seeded = await seedCtype(env, naIds, now, get, set).catch(() => false);
  const cf = await entityFields(env, 'contact').catch(() => ({})) || {};
  const changed = await bxAllFast(env, 'crm.contact.list', {
    filter: { '>=DATE_MODIFY': since }, select: ['ID', 'NAME', 'LAST_NAME', 'EMAIL', 'TYPE_ID', 'MODIFY_BY_ID', 'DATE_MODIFY', 'SOURCE_ID', 'SOURCE_DESCRIPTION', ...(cf.mailCount ? [cf.mailCount] : [])],
  }, 1000).catch(() => null);
  if (!changed) return { mode, error: 'contact list failed' };
  const srcs = sourceCache || {};
  const prev = {};
  for (let i = 0; i < changed.length; i += 90) {
    const ids = changed.slice(i, i + 90).map(c => String(c.ID));
    const { results } = await db.prepare(`SELECT contact_id, type_id FROM ctype WHERE contact_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    for (const r of results) prev[r.contact_id] = r.type_id;
  }
  const out = [];
  for (const c of changed) {
    const id = String(c.ID), t = String(c.TYPE_ID || '');
    const was = prev[id];
    if (was === undefined && !seeded) continue;
    if (naIds.includes(t) && was !== t && senders.ids.includes(String(c.MODIFY_BY_ID)) && !isHive(srcs[c.SOURCE_ID], c.SOURCE_DESCRIPTION)) {
      const email = (Array.isArray(c.EMAIL) && c.EMAIL[0] && c.EMAIL[0].VALUE) || '';
      const recent = await db.prepare(`SELECT at FROM na_mail WHERE contact_id=? AND mode='live' AND at > ? LIMIT 1`).bind(id, now - 7 * 86400000).first();
      if (email && !recent) out.push({ c, id, email, type: contactTypeCache[t], by: String(c.MODIFY_BY_ID) });
    }
  }
  // Remember every contact's current type so only real changes count next time.
  const stmts = changed.map(c => db.prepare(`INSERT OR REPLACE INTO ctype (contact_id, type_id, at) VALUES (?,?,?)`).bind(String(c.ID), String(c.TYPE_ID || ''), now));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));

  const results = [];
  if (out.length && mode === 'live') {
    for (const x of out.slice(0, 40)) x.html = naMailHtml([x.c.NAME, x.c.LAST_NAME].filter(Boolean).join(' '), await trackLinks(env, x.id, 'na'));
    const b = await bxBatch(env, out.slice(0, 40).map((x, i) => ['e' + i, 'crm.activity.add', { fields: {
      OWNER_TYPE_ID: 3, OWNER_ID: x.id, TYPE_ID: 4, DIRECTION: 2, COMPLETED: 'Y', RESPONSIBLE_ID: x.by,
      SUBJECT: NA_MAIL_SUBJECT, DESCRIPTION: x.html, DESCRIPTION_TYPE: 3,
      COMMUNICATIONS: [{ VALUE: x.email, ENTITY_ID: x.id, ENTITY_TYPE_ID: 3 }],
      SETTINGS: { MESSAGE_FROM: NA_MAIL_FROM },
    } }])).catch(e => ({ result: {}, error: { all: String(e.message || e) } }));
    out.slice(0, 40).forEach((x, i) => results.push([x, b.error['e' + i] || b.error.all ? 'error ' + JSON.stringify(b.error['e' + i] || b.error.all).slice(0, 150) : 'sent']));
    // Keep the contact's own "last mailing sent" date (and count) up to date.
    await markMailed(env, cf, results.filter(([, r]) => r === 'sent').map(([x]) => ({ id: x.id, count: x.c[cf.mailCount] })), now);
  } else for (const x of out) results.push([x, 'dry-run']);
  for (const [x, r] of results) {
    await db.prepare(`INSERT INTO na_mail (contact_id, email, type, by_id, mode, at, result) VALUES (?,?,?,?,?,?,?)`)
      .bind(x.id, x.email, x.type, x.by, r === 'sent' ? 'live' : mode, now, r).run();
  }
  // In dry mode, tell James who would have got it, so it can be checked before switching on.
  if (mode === 'dry' && results.length) {
    const lines = results.map(([x]) => `[URL=https://immiworld.org/crm/contact/details/${x.id}/]${esc([x.c.NAME, x.c.LAST_NAME].filter(Boolean).join(' ') || x.id)}[/URL] - ${x.type} by ${(senders.names && senders.names[x.by]) || userNames[x.by] || 'user ' + x.by}`);
    await bxBatch(env, [['n', 'im.message.add', { DIALOG_ID: env.NA_MAIL_REPORT_TO || '147', MESSAGE: `[B]TEST MODE - "We Tried to Reach You" would have gone to ${results.length}:[/B]\n` + lines.join('\n') }]]).catch(() => null);
  }
  await set('na_mail_since', now);
  const followUps = mode === 'live' ? await naFollowUps(env, cf, now).catch(e => ({ error: String(e.message || e) })) : null;
  return { mode, checked: changed.length, matched: out.length, results: results.map(([x, r]) => ({ id: x.id, type: x.type, r })), followUps };
}

// Record the type of every contact that is already NA / NA 5 / No Line / Wrong Number, 2,500 per run.
async function seedCtype(env, naIds, now, get, set) {
  const st = await get('ctype_seed');
  if (st === 'done') return true;
  if (!naIds.length) return false;
  const cursor = Number(st) || 0;
  const cmds = [];
  for (let s = 0; s < 2500; s += 50) cmds.push(['s' + s, 'crm.contact.list', { filter: { TYPE_ID: naIds, '>ID': cursor }, order: { ID: 'ASC' }, select: ['ID', 'TYPE_ID'], start: s }]);
  const b = await bxBatch(env, cmds);
  if (Object.keys(b.error || {}).length) return false;
  const rows = cmds.flatMap(([k]) => b.result[k] || []);
  const stmts = rows.map(c => env.DB.prepare(`INSERT OR IGNORE INTO ctype (contact_id, type_id, at) VALUES (?,?,?)`).bind(String(c.ID), String(c.TYPE_ID || ''), now));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  if (rows.length < 2500) { await set('ctype_seed', 'done'); return true; }
  await set('ctype_seed', Math.max(...rows.map(c => Number(c.ID))));
  return false;
}

// The contact's own "Date when the last mailing was sent" (a date field) and "Number of mailings sent".
async function markMailed(env, cf, list, now) {
  if (!list.length || !(cf.lastMail || cf.mailCount)) return;
  await bxBatch(env, list.map((x, i) => ['u' + i, 'crm.contact.update', { id: x.id, fields: {
    ...(cf.lastMail ? { [cf.lastMail]: localParts(now).day } : {}),
    ...(cf.mailCount ? { [cf.mailCount]: (parseInt(x.count, 10) || 0) + 1 } : {}),
  }, params: { REGISTER_SONET_EVENT: 'N' } }])).catch(() => null);
}

// Opened "We Tried to Reach You" (a real open, not Apple's automatic one), did not click the
// booking button, and 5+ minutes have passed: send one follow-up. Once per contact per 7 days.
const FU_DELAY = 5 * 60000;
async function naFollowUps(env, cf, now) {
  const db = env.DB;
  const { results: due } = await db.prepare(`SELECT o.contact_id, MIN(o.at) opened FROM na_track o
    WHERE o.m='na' AND o.kind='open' AND o.machine=0 AND o.at <= ? AND o.at > ?
      AND NOT EXISTS (SELECT 1 FROM na_track c WHERE c.contact_id=o.contact_id AND c.kind='click' AND c.machine=0 AND c.at > ?)
      AND NOT EXISTS (SELECT 1 FROM na_mail f WHERE f.contact_id=o.contact_id AND f.type='followup' AND f.at > ?)
    GROUP BY o.contact_id LIMIT 20`).bind(now - FU_DELAY, now - 3 * 86400000, now - 7 * 86400000, now - 7 * 86400000).all();
  if (!due.length) return { due: 0 };
  const ids = due.map(d => String(d.contact_id));
  const cs = await bx(env, 'crm.contact.list', { filter: { ID: ids }, select: ['ID', 'NAME', 'LAST_NAME', 'EMAIL', 'ASSIGNED_BY_ID', ...(cf.mailCount ? [cf.mailCount] : [])] }) || [];
  const last = {};
  for (const id of ids) last[id] = await db.prepare(`SELECT by_id, email FROM na_mail WHERE contact_id=? AND mode='live' AND type!='followup' ORDER BY id DESC LIMIT 1`).bind(id).first();
  const list = [];
  for (const c of cs) {
    const id = String(c.ID);
    const email = (Array.isArray(c.EMAIL) && c.EMAIL[0] && c.EMAIL[0].VALUE) || (last[id] && last[id].email) || '';
    if (!email) continue;
    list.push({ c, id, email, by: (last[id] && last[id].by_id) || String(c.ASSIGNED_BY_ID || ''),
      html: fuMailHtml([c.NAME, c.LAST_NAME].filter(Boolean).join(' '), await trackLinks(env, id, 'fu')) });
  }
  if (!list.length) return { due: due.length, sent: 0 };
  const b = await bxBatch(env, list.map((x, i) => ['f' + i, 'crm.activity.add', { fields: {
    OWNER_TYPE_ID: 3, OWNER_ID: x.id, TYPE_ID: 4, DIRECTION: 2, COMPLETED: 'Y', RESPONSIBLE_ID: x.by,
    SUBJECT: FU_SUBJECT, DESCRIPTION: x.html, DESCRIPTION_TYPE: 3,
    COMMUNICATIONS: [{ VALUE: x.email, ENTITY_ID: x.id, ENTITY_TYPE_ID: 3 }],
    SETTINGS: { MESSAGE_FROM: NA_MAIL_FROM },
  } }])).catch(e => ({ result: {}, error: { all: String(e.message || e) } }));
  const res = list.map((x, i) => [x, b.error['f' + i] || b.error.all ? 'error ' + JSON.stringify(b.error['f' + i] || b.error.all).slice(0, 150) : 'sent']);
  for (const [x, r] of res) {
    await db.prepare(`INSERT INTO na_mail (contact_id, email, type, by_id, mode, at, result) VALUES (?,?,?,?,?,?,?)`)
      .bind(x.id, x.email, 'followup', x.by, 'live', now, r).run();
  }
  await markMailed(env, cf, res.filter(([, r]) => r === 'sent').map(([x]) => ({ id: x.id, count: x.c[cf.mailCount] })), now);
  return { due: due.length, sent: res.filter(([, r]) => r === 'sent').length };
}

// Open pixel and booking link in the emails above.
const TRACK_TABLE = `CREATE TABLE IF NOT EXISTS na_track (id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id TEXT, m TEXT, kind TEXT, at INTEGER, machine INTEGER, ua TEXT)`;
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));
async function onTrack(req, env, ctx, kind) {
  const u = new URL(req.url);
  const id = String(u.searchParams.get('c') || ''), m = u.searchParams.get('m') === 'fu' ? 'fu' : 'na';
  const ok = id && u.searchParams.get('s') === await trackSig(env, id, m);
  if (ok) ctx.waitUntil((async () => {
    const db = env.DB, now = Date.now();
    await db.prepare(TRACK_TABLE).run();
    const ua = req.headers.get('user-agent') || '';
    // Apple Mail Privacy Protection loads images by itself from Apple's network (AS714), and mail
    // scanners hit links straight after delivery; neither is the client.
    const sent = await db.prepare(`SELECT MAX(at) at FROM na_mail WHERE contact_id=? AND mode='live'`).bind(id).first().catch(() => null);
    const machine = (req.cf && Number(req.cf.asn) === 714) || (sent && sent.at && now - sent.at < 60000) || /bot|scanner|preview|safelinks/i.test(ua) ? 1 : 0;
    await db.prepare(`INSERT INTO na_track (contact_id, m, kind, at, machine, ua) VALUES (?,?,?,?,?,?)`).bind(id, m, kind, now, machine, ua.slice(0, 200)).run();
  })().catch(() => null));
  if (kind === 'click') return Response.redirect(CALENDLY, 302);
  return new Response(GIF, { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, max-age=0' } });
}

// ---------------------------------------------------------------- router
export default {
  async fetch(req, env, ctx) {
    resetBudget(env);
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    try {
      if (u.pathname === '/health') return json({ ok: true, build: BUILD });
      if (u.pathname === '/t/o') return await onTrack(req, env, ctx, 'open');
      if (u.pathname === '/t/c') return await onTrack(req, env, ctx, 'click');
      if (req.method === 'POST' && u.pathname === '/mailgun') return await onMailgun(req, env);
      if (req.method === 'POST' && u.pathname === '/forward') return await onForward(req, env);
      if (req.method === 'POST' && u.pathname === '/e') return await onPage(req, env);

      // Admin, all need ?key=SCORE_KEY
      if (u.pathname.startsWith('/admin/')) {
        if (!keyOk(req, env)) return json({ ok: false }, 401);
        await ensureSchema(env.DB);
        if (u.pathname === '/admin/setup') return json({ ok: true, fields: await setup(env) });
        if (u.pathname === '/admin/fields') {
          delete fieldCache.lead; delete fieldCache.contact;
          const q = String(u.searchParams.get('find') || '').toLowerCase();
          if (q) {
            const ent = u.searchParams.get('entity') === 'lead' ? 'lead' : 'contact';
            const all = await bx(env, `crm.${ent}.fields`, {}) || {};
            return json({ ok: true, entity: ent, found: Object.entries(all).filter(([, f]) => [f.title, f.listLabel, f.formLabel, f.filterLabel].join(' | ').toLowerCase().includes(q)).map(([c, f]) => ({ code: c, type: f.type, label: f.listLabel || f.formLabel || f.title })) });
          }
          return json({ ok: true, lead: await entityFields(env, 'lead'), contact: await entityFields(env, 'contact') });
        }
        if (u.pathname === '/admin/agentnotes') {
          // Today's comments written under one user's name on the contacts assigned to them (to check the summary).
          const uid = String(u.searchParams.get('user') || '');
          const { day, offset } = localParts(); const since = `${day}T00:00:00${offset}`;
          const cs = await bx(env, 'crm.contact.list', { filter: { '>=DATE_MODIFY': since, ASSIGNED_BY_ID: uid }, select: ['ID', 'MODIFY_BY_ID', 'TYPE_ID'] }) || [];
          const b = await bxBatch(env, cs.slice(0, 40).map(c => ['n' + c.ID, 'crm.timeline.comment.list', { filter: { ENTITY_TYPE: 'contact', ENTITY_ID: c.ID, '>=CREATED': since }, select: ['ID', 'AUTHOR_ID', 'CREATED', 'COMMENT'], order: { ID: 'DESC' } }])).catch(() => ({ result: {} }));
          const notes = Object.entries(b.result || {}).flatMap(([k, l]) => (l || []).filter(n => Date.parse(n.CREATED || '') >= Date.parse(since)).map(n => ({ contact: k.slice(1), author: n.AUTHOR_ID, at: n.CREATED, text: cleanText(n.COMMENT || '').slice(0, 140) })));
          return json({ ok: true, contacts: cs.map(c => ({ id: c.ID, modifiedBy: c.MODIFY_BY_ID, type: c.TYPE_ID })), notes });
        }
        if (u.pathname === '/admin/run') return json({ ok: true, ...(await runBatch(env)) });
        if (u.pathname === '/admin/score') {
          const email = String(u.searchParams.get('email') || '').toLowerCase();
          const dry = u.searchParams.get('write') !== '1';
          return json({ ok: true, ...(await scoreOne(env, email, { dryRun: dry })) });
        }
        if (u.pathname === '/admin/digest') {
          // ?bg=1 runs it in the background and keeps the result; ?result=1 reads it back.
          await env.DB.prepare(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, at INTEGER)`).run();
          if (u.searchParams.get('result') === '1') {
            const r = await env.DB.prepare(`SELECT v, at FROM kv WHERE k='digest_bg'`).first();
            return json({ ok: true, at: r && r.at, ...(r ? JSON.parse(r.v) : { status: 'nothing yet' }) });
          }
          if (u.searchParams.get('queue')) {
            const qv = u.searchParams.get('queue');
            const mode = qv === 'send' || qv === 'campaigns' ? qv : /^(sample|campaigns|manager):\d+$/.test(qv) ? qv : 'preview';
            await env.DB.prepare(`INSERT OR REPLACE INTO kv (k, v, at) VALUES ('digest_queue', ?, ?)`).bind(mode, Date.now()).run();
            return json({ ok: true, queued: mode, note: 'runs on the next 15-minute tick; read it with ?result=1' });
          }
          if (u.searchParams.get('bg') === '1') {
            const send = u.searchParams.get('send') === '1';
            await env.DB.prepare(`INSERT OR REPLACE INTO kv (k, v, at) VALUES ('digest_bg', ?, ?)`).bind(JSON.stringify({ status: 'running', send }), Date.now()).run();
            ctx.waitUntil((async () => {
              let res;
              try {
                res = send ? await sendDigest(env, true)
                  : { managers: await managerIds(env), teamLeads: await teamLeadIds(env), salesManagers: await salesManagerIds(env), ...(await buildDigest(env)) };
                res.status = 'done';
              } catch (e) { res = { status: 'error', error: String(e && e.message || e) }; }
              await env.DB.prepare(`INSERT OR REPLACE INTO kv (k, v, at) VALUES ('digest_bg', ?, ?)`).bind(JSON.stringify(res).slice(0, 900000), Date.now()).run();
            })());
            return json({ ok: true, started: true, send });
          }
          if (u.searchParams.get('send') === '1') return json({ ok: true, ...(await sendDigest(env, true)) });
          return json({ ok: true, preview: true, managers: await managerIds(env), teamLeads: await teamLeadIds(env), salesManagers: await salesManagerIds(env), ...(await buildDigest(env)) });
        }
        if (u.pathname === '/admin/na-mail') {
          await env.DB.prepare(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, at INTEGER)`).run();
          const m = u.searchParams.get('mode');
          if (['dry', 'live', 'off'].includes(m)) await env.DB.prepare(`INSERT OR REPLACE INTO kv (k, v, at) VALUES ('na_mail_mode', ?, ?)`).bind(m, Date.now()).run();
          const pv = u.searchParams.get('preview');
          if (pv) return new Response(pv === 'fu' ? fuMailHtml('Brett Dunn') : naMailHtml('Brett Dunn'), { headers: { 'content-type': 'text/html; charset=utf-8' } });
          const cur = await env.DB.prepare(`SELECT v FROM kv WHERE k='na_mail_mode'`).first();
          const log = await env.DB.prepare(`SELECT contact_id, type, by_id, mode, at, result FROM na_mail ORDER BY id DESC LIMIT 30`).all().catch(() => ({ results: [] }));
          await env.DB.prepare(TRACK_TABLE).run();
          const tr = await env.DB.prepare(`SELECT contact_id, m, kind, machine, at FROM na_track ORDER BY id DESC LIMIT 30`).all().catch(() => ({ results: [] }));
          return json({ ok: true, mode: (cur && cur.v) || 'dry', recent: log.results, tracking: tr.results });
        }
        if (u.pathname === '/admin/statuses') {
          const n = await leadStatuses(env);
          const ct = Object.fromEntries((await bx(env, 'crm.status.list', { filter: { ENTITY_ID: 'CONTACT_TYPE' } }).catch(() => []) || []).map(x => [x.STATUS_ID, x.NAME]));
          return json({ ok: true, failedToPay: Object.entries(n).filter(([, v]) => isFailedPayStatus(v)), notInterested: Object.entries(n).filter(([, v]) => isNotInterestedStatus(v)), noAnswer: Object.entries(n).filter(([, v]) => isNoAnswerStatus(v)), hiveSources: Object.entries(await sourceNames(env)).filter(([, v]) => isHive(v)), all: n, contactTypes: ct });
        }
        if (u.pathname === '/admin/mailed') return await mailedReport(env, u);
        if (u.pathname === '/admin/flush-mailed') return json({ ok: true, ...(await flushMailed(env)) });
        if (u.pathname === '/admin/top') {
          const { results } = await env.DB.prepare(
            `SELECT email, score, heat, rec_key, lead_id, assigned, note, scored_at FROM state
              WHERE heat IN ('HOT','WARM') ORDER BY score DESC LIMIT 50`).all();
          return json({ ok: true, results });
        }
      }
      return json({ ok: false, reason: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e).replace(/\/rest\/\S+/g, '[path]') }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // The 18:00 Israel-time summary rides on the 15-minute trigger: the first run
    // at or after 18:00 sends it, digest_log stops a second send the same day.
    resetBudget(env);
    // A summary asked for by hand (/admin/digest?queue=send|preview) runs on the next tick:
    // a scheduled run has no 100-second limit, a web request does.
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, at INTEGER)`).run();
      const q = await env.DB.prepare(`SELECT v FROM kv WHERE k='digest_queue'`).first();
      if (q) {
        await env.DB.prepare(`DELETE FROM kv WHERE k='digest_queue'`).run();
        ctx.waitUntil((async () => {
          let res;
          try {
            res = q.v === 'send' ? await sendDigest(env, true)
              : q.v.startsWith('sample:') ? await sendSample(env, q.v.slice(7))
              : q.v.startsWith('campaigns:') ? await sendCampaignReport(env, { to: q.v.slice(10) })
              : q.v.startsWith('manager:') ? await (async () => { const d = await buildDigest(env); await bxBatch(env, [['m', 'im.message.add', { DIALOG_ID: q.v.slice(8), MESSAGE: d.managerMessage }]]); return { sent: ['manager summary to ' + q.v.slice(8)] }; })()
              : q.v === 'campaigns' ? await sendCampaignReport(env, { force: true })
              : { managers: await managerIds(env), teamLeads: await teamLeadIds(env), salesManagers: await salesManagerIds(env), ...(await buildDigest(env)) };
            res.status = 'done'; res.mode = q.v;
          } catch (e) { res = { status: 'error', mode: q.v, error: String(e && e.message || e) }; }
          await env.DB.prepare(`INSERT OR REPLACE INTO kv (k, v, at) VALUES ('digest_bg', ?, ?)`).bind(JSON.stringify(res).slice(0, 900000), Date.now()).run();
        })());
        return;
      }
    } catch (e) { /* fall through to the normal run */ }
    // 09:00 Israel: the campaign report to the managers (once a day).
    if (localParts(event.scheduledTime || Date.now()).hour === 9) {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS campaign_log (day TEXT PRIMARY KEY, sent_at INTEGER, summary TEXT)`).run();
      const done = await env.DB.prepare(`SELECT day FROM campaign_log WHERE day=?`).bind(localParts().day).first();
      if (!done) { ctx.waitUntil(sendCampaignReport(env).catch(() => null)); return; }
    }
    if (localParts(event.scheduledTime || Date.now()).hour === 18) {
      await ensureSchema(env.DB);
      const done = await env.DB.prepare(`SELECT day FROM digest_log WHERE day=?`).bind(localParts().day).first();
      if (!done) { ctx.waitUntil(sendDigest(env)); return; } // the summary gets this run's whole call budget
    }
    if (event.cron === '0 * * * *') return;
    ctx.waitUntil((async () => {
      await naMailRun(env).catch(() => null); // a few calls; the rest of the budget goes to scoring
      await flushMailed(env).catch(() => null);
      await runBatch(env);
    })());
  },
};
