/**
 * Diversity Visa update list handler.
 *
 * Called by dv-notify.html when the client presses YES or NO.
 *
 * On YES it does three things, on the lead and on the contact:
 *   1. sets "Interested in Visa" (UF_CRM_1547484113) to the DV value
 *   2. appends a line to the COMMENTS field, which is the note panel on the card
 *   3. adds a timeline comment, which is the activity feed beside it
 *
 * On NO it writes the note only, with the reason the client picked, and changes no field.
 *
 * Deploy: Deploy > New deployment > Web app, Execute as Me, Who has access Anyone.
 * After any edit: Deploy > Manage deployments > pencil > New version.
 */

var B24 = 'https://immiworld.org/rest/147/47yrflms2cje1cbe/';

// "Interested in Visa" — lead and contact use different field codes.
var F_VISA_LEAD    = 'UF_CRM_1547484113';
var F_VISA_CONTACT = 'UF_CRM_5C5843FC11F1D';

/* The list value ID for the Diversity Visa option.
   Run listVisaOptions() once and copy the ID printed for the DV entry. */
var VISA_DV_LEAD    = 'PUT_LEAD_LIST_ID_HERE';
var VISA_DV_CONTACT = 'PUT_CONTACT_LIST_ID_HERE';

var NOTE_YES = 'DV: client received the Diversity Visa update and asked to be kept on the update list.';
var NOTE_NO  = 'DV: client received the Diversity Visa update and said they are not interested.';


function doGet(e)  { return handle(e); }
function doPost(e) { return handle(e); }

function handle(e) {
  var p = (e && e.parameter) || {};
  if (String(p.action || '') === 'lookup') return lookup(p);

  var email    = String(p.email  || '').trim().toLowerCase();
  var answer   = String(p.answer || '').trim().toLowerCase();
  var campaign = String(p.utm_campaign || '').trim();
  var reason   = String(p.reason || '').trim().slice(0, 250);
  var phone    = String(p.phone  || '').trim().slice(0, 25);

  var out = { ok: false, email: email, answer: answer, lead: null, contact: null, note: '' };

  if (!email || email.indexOf('@') < 0) { out.note = 'no valid email'; return json(out); }
  if (answer !== 'yes' && answer !== 'no') { out.note = 'answer must be yes or no'; return json(out); }

  var note = (answer === 'yes' ? NOTE_YES : NOTE_NO) +
             (answer === 'no' && reason ? ' Reason given: ' + reason + '.' : '') +
             ' Campaign ' + (campaign || 'n/a') + ', ' + new Date().toISOString().slice(0, 10) + '.';

  if (phone) note += ' Phone given by the client: ' + phone + '.';

  out.lead    = mark('lead', email, answer, note, phone);
  out.contact = mark('contact', email, answer, note, phone);
  out.ok = true;
  return json(out);
}


function mark(kind, email, answer, note, phone) {
  var ids = findByEmail(kind === 'lead' ? 'LEAD' : 'CONTACT', email);
  if (!ids.length) return { found: 0, updated: 0 };

  var field  = kind === 'lead' ? F_VISA_LEAD : F_VISA_CONTACT;
  var dvValue = kind === 'lead' ? VISA_DV_LEAD : VISA_DV_CONTACT;
  var updated = 0;

  ids.forEach(function (id) {
    var rec = call('crm.' + kind + '.get', { id: id });
    if (!rec) return;

    // 1. the field, only on yes
    if (answer === 'yes' && dvValue.indexOf('PUT_') !== 0) {
      var fields = {};
      fields[field] = dvValue;
      call('crm.' + kind + '.update', {
        id: id, fields: fields, params: { REGISTER_SONET_EVENT: 'N' }
      });
    }

    // 2. the phone the client typed, added alongside the numbers already on file.
    //    Existing entries are sent back with their IDs so none of them is dropped.
    if (phone && !hasPhone(rec, phone)) {
      var list = (rec.PHONE || []).map(function (ph) {
        return { ID: ph.ID, VALUE: ph.VALUE, VALUE_TYPE: ph.VALUE_TYPE };
      });
      list.push({ VALUE: phone, VALUE_TYPE: 'MOBILE' });
      call('crm.' + kind + '.update', {
        id: id, fields: { PHONE: list }, params: { REGISTER_SONET_EVENT: 'N' }
      });
    }

    // 3. the COMMENTS field, in its own call so the request stays short
    var existing = String(rec.COMMENTS || '');
    call('crm.' + kind + '.update', {
      id: id,
      fields: { COMMENTS: (existing ? existing + '<br>' : '') + note },
      params: { REGISTER_SONET_EVENT: 'N' }
    });

    // 4. the timeline
    call('crm.timeline.comment.add', {
      fields: { ENTITY_ID: id, ENTITY_TYPE: kind, COMMENT: note }
    });

    updated++;
  });

  return { found: ids.length, updated: updated };
}


/* ---------------- phone ---------------- */

function digits(v) { return String(v || '').replace(/[^0-9]/g, ''); }

/** True when this number, ignoring spaces and symbols, is already on the record. */
function hasPhone(rec, phone) {
  var d = digits(phone);
  if (d.length < 6) return true;   // too short to be a real number, so do not add it
  return (rec.PHONE || []).some(function (ph) {
    var e = digits(ph.VALUE);
    return e === d || e.slice(-9) === d.slice(-9);
  });
}

/** Shows only the last three digits, e.g. 972 50 123 4567 becomes ......567 */
function mask(phone) {
  var d = digits(phone);
  if (d.length < 4) return '';
  return '\u2022'.repeat(Math.min(d.length - 3, 9)) + d.slice(-3);
}

/** Answers the page's phone lookup. Returns a masked number and nothing else. */
function lookup(p) {
  var email = String(p.email || '').trim().toLowerCase();
  var cb    = String(p.callback || '').replace(/[^A-Za-z0-9_$]/g, '').slice(0, 40) || '__dvPhone';
  var out   = { phone: '' };

  if (email && email.indexOf('@') > 0) {
    ['LEAD', 'CONTACT'].forEach(function (type) {
      if (out.phone) return;
      var ids = findByEmail(type, email);
      ids.forEach(function (id) {
        if (out.phone) return;
        var rec = call('crm.' + (type === 'LEAD' ? 'lead' : 'contact') + '.get', { id: id });
        var first = rec && rec.PHONE && rec.PHONE[0];
        if (first) out.phone = mask(first.VALUE);
      });
    });
  }

  return ContentService
    .createTextOutput(cb + '(' + JSON.stringify(out) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}


/* ---------------- helpers ---------------- */

function findByEmail(entityType, email) {
  var res = call('crm.duplicate.findbycomm', {
    entity_type: entityType, type: 'EMAIL', values: [email]
  });
  if (res && res[entityType] && res[entityType].length) return res[entityType];

  var method = entityType === 'LEAD' ? 'crm.lead.list' : 'crm.contact.list';
  var rows = call(method, { filter: { EMAIL: email }, select: ['ID'] }) || [];
  return rows.map(function (r) { return r.ID; });
}

function call(method, params) {
  var resp = UrlFetchApp.fetch(B24 + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(params || {}),
    muteHttpExceptions: true
  });
  var body = {};
  try { body = JSON.parse(resp.getContentText()); } catch (err) { return null; }
  if (body.error) {
    console.log(method + ' error: ' + body.error + ' ' + (body.error_description || ''));
    return null;
  }
  return body.result;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


/* ---------------- run these two once, before deploying ---------------- */

/** Prints every option of "Interested in Visa" with its ID.
 *  Copy the ID of the Diversity Visa option into VISA_DV_LEAD / VISA_DV_CONTACT above. */
function listVisaOptions() {
  [['lead', F_VISA_LEAD], ['contact', F_VISA_CONTACT]].forEach(function (pair) {
    var fields = call('crm.' + pair[0] + '.fields', {});
    var f = fields && fields[pair[1]];
    if (!f) { console.log(pair[0] + ': field ' + pair[1] + ' not found'); return; }
    console.log('--- ' + pair[0] + ' ' + pair[1] + ' ---');
    (f.items || []).forEach(function (item) {
      console.log(item.ID + '  =  ' + item.VALUE);
    });
  });
}

/** End to end test against one real record. */
function testDvYes() {
  var out = handle({ parameter: {
    email: 'put-a-test-address@example.com',
    name: 'Test',
    answer: 'yes',
    phone: '',
    utm_campaign: 'TEST'
  }});
  console.log(out.getContent());
}

/** Check what the page would show in the Phone row for one address. */
function testLookup() {
  console.log(lookup({ email: 'put-a-test-address@example.com', callback: 'cb' }).getContent());
}
