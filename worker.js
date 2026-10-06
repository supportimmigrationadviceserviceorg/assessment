// ias-chat — the "Ask IAS" chat on GitHub Pages talks to this Worker only.
//
// Secrets (Cloudflare → ias-chat → Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY  Claude API key
//   BITRIX_WEBHOOK     inbound webhook URL, ending in /rest/<user>/<code>/
// Optional plain-text variables:
//   MODEL              default claude-sonnet-5-5
//   ALLOWED_ORIGINS    comma separated, default the GitHub Pages origin
//
// Actions (POST, JSON body, "action" field):
//   start     {e}                                → {name}            first name for the greeting
//   chat      {e, messages}                      → {reply}           one assistant reply
//   register  {name, e, phone, campaign, source} → {ok}              finds or creates the lead
//   log       {e, campaign, transcript, cid}     → {ok, cid}         one timeline comment per conversation
//
// Rules carried over from ias-crm:
//   - pages send an email address, never a record id; the Worker resolves the record
//   - pages never name Bitrix fields
//   - nothing here changes a lead's stage

const BUILD = "chat-v1";
const PROMPT = "You are the online immigration assistant of Immigration Advice Service (IAS), a U.S. immigration consulting company. People reach you from an email inviting them to ask anything about moving to the United States. Your two jobs: give genuinely useful answers, and learn enough about the person to point them to the right next step. You are not a lawyer and you never give legal advice about their specific case.\n\nHOW TO REPLY\n- Answer what they actually asked first, plainly and concretely, in 2-5 short sentences. Name the real visa categories that apply (for example CR-1/IR-1, K-1, F2A, H-1B, EB-2 NIW, EB-1, EB-3, O-1, L-1, H-2B, E-2, EB-5, F-1, the Diversity Visa lottery).\n- Then ask ONE short follow-up question that tells you which route fits. Never ask two questions at once. Never list a questionnaire.\n- Questions to work through over the conversation, in whatever order feels natural: what they want (live, work, invest, study, join family, retire); their country of citizenship and of birth; marital status and spouse; any spouse, parent, adult child or sibling who is a U.S. citizen or Green Card holder; a U.S. employer willing to sponsor; education and field; years of experience and standout achievements; budget they could invest; timing. Skip what they already told you.\n- Write like a calm, experienced consultant talking to one person. Warm, direct, no hype, no exclamation marks, no emoji, no bullet lists unless they ask to compare options. No markdown headings or bold.\n- Reply in the language the person writes in.\n\nBEING HONEST\n- Never promise or imply approval, a timeline or a success rate for their case. When asked how long something takes, explain which steps the route involves and that timing depends mainly on the route and the applicant's country, then ask which route they are considering or what their situation is. Do not quote fees or processing times as figures; they change, and the review gives current ones.\n- If a route does not fit, say so kindly and point to what could. A weak profile still deserves a useful answer.\n- Never invent urgency, deadlines, discounts, limited spots or statistics.\n- If asked, say you are IAS's AI assistant and that a real consultant can follow up.\n- If they go off topic, answer briefly if harmless and bring it back to their move.\n- Do not ask for passport numbers, ID numbers or card details.\n\nNEXT STEPS YOU CAN OFFER\nYou may attach ONE next step to a reply by ending it with a line containing only [[GO:key]]. The page turns it into a button. Mention the step naturally in your sentence before it. Never write URLs.\n- pay: the $29 attorney review. A licensed immigration attorney reviews their full profile, a personal consultant is assigned, and they get a detailed report of every route open to them. This is the main next step. Offer it once you know enough to see at least one realistic route (usually after 4-6 answers), or as soon as they ask how to start, what it costs, or whether you can help. Present it as the sensible way to get a definite answer on their own case, not as a sale. If they decline or ignore it, keep helping and do not offer it again for at least four replies.\n- assessment: a free online eligibility check. For someone unsure of everything who prefers to fill in a form.\n- salary: U.S. salary range for their field. For work-visa conversations, when salary or their market value comes up.\n- e2_call: free investor visa consultation call. For E-2 or EB-5 interest once they mention a budget or ask about buying or starting a business.\n- dream_map: compare U.S. cities. When they are undecided where to live or ask about lifestyle and cost of living.\n- dv: Green Card lottery update list. When they ask about the lottery and their birth country may be eligible.\nNever use a next step in your first reply. At most one per reply. Most replies have none.\n\nKEY FACTS TO GET RIGHT\n- Spouse of a U.S. citizen: immediate relative (CR-1/IR-1), no annual cap. Spouse of a Green Card holder: F2A, subject to visa availability.\n- E-2 needs citizenship of a treaty country and a substantial investment in a real U.S. business they will direct. It is renewable but not a Green Card by itself.\n- EB-5 needs a much larger investment and leads to a Green Card.\n- EB-2 NIW lets qualified professionals self-petition without an employer.\n- The Diversity Visa lottery depends on country of birth (a spouse's birth country can sometimes be used) and needs a high school education or two years of qualifying work experience.";
const DEFAULT_ORIGINS = ["https://supportimmigrationadviceserviceorg.github.io"];

const MAX_TURNS = 60;          // messages per request (user + assistant)
const MAX_CHARS = 1500;        // per message
const MAX_TRANSCRIPT = 60000;
const RATE = { windowMs: 60000, max: 20 };   // chat calls per IP per minute, per isolate

// Lead fields whose labels contain one of these words may be told to the assistant.
// Notes, comments and anything an agent wrote are never sent.
const PROFILE_WORDS = ["country", "citizen", "nationality", "birth", "marital", "married", "spouse",
  "children", "kids", "education", "degree", "profession", "occupation", "job", "work", "experience",
  "income", "salary", "budget", "invest", "english", "age", "visa", "goal", "interest", "about business"];
const PROFILE_SKIP = ["comment", "note", "agent", "call", "score", "heat", "signal", "recommend", "utm",
  "source", "assessment call", "id", "link", "url", "file", "pdf", "stage", "responsible"];
const STANDARD_OK = ["ADDRESS_COUNTRY", "POST", "BIRTHDATE"];   // the only built-in fields considered; the rest are custom (UF_)

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const origins = allowed.length ? allowed : DEFAULT_ORIGINS;
    const okOrigin = origins.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? origin : origins[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    const json = (o, status) => new Response(JSON.stringify(o), {
      status: status || 200, headers: { ...cors, "Content-Type": "application/json" }
    });

    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, build: BUILD, anthropic: !!env.ANTHROPIC_API_KEY, bitrix: !!env.BITRIX_WEBHOOK });
    }
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ error: "method" }, 405);
    if (!okOrigin) return json({ error: "origin" }, 403);

    let body;
    try { body = JSON.parse(await req.text()); } catch (e) { return json({ error: "bad_json" }, 400); }
    const action = String(body.action || "");
    const email = cleanEmail(body.e);

    try {
      if (action === "start") {
        if (!email) return json({ name: "" });
        const rec = await findRecord(env, email);
        return json({ name: rec ? firstName(rec.data.NAME) : "" });
      }

      if (action === "chat") {
        const ip = req.headers.get("CF-Connecting-IP") || "?";
        if (limited(ip)) return json({ error: "rate_limited" }, 429);
        const messages = cleanMessages(body.messages);
        if (!messages) return json({ error: "bad_messages" }, 400);
        let known = "";
        if (email && env.BITRIX_WEBHOOK) {
          try {
            const rec = await findRecord(env, email);
            if (rec) known = await profileText(env, rec);
          } catch (e) { /* answer without the profile rather than fail */ }
        }
        const reply = await claude(env, systemPrompt(known), messages);
        return json({ reply });
      }

      if (action === "register") {
        if (!email) return json({ error: "email" }, 400);
        const name = String(body.name || "").trim().slice(0, 120);
        const phone = String(body.phone || "").replace(/[^\d+()\-\s]/g, "").trim().slice(0, 30);
        let rec = await findRecord(env, email);
        if (!rec) {
          const parts = name.split(/\s+/);
          const campaign = String(body.campaign || "").slice(0, 100);
          const source = String(body.source || "").slice(0, 100);
          const id = await bx(env, "crm.lead.add", {
            fields: {
              TITLE: "Ask IAS chat - " + (name || email),
              NAME: parts[0] || "",
              LAST_NAME: parts.slice(1).join(" "),
              EMAIL: [{ VALUE: email, VALUE_TYPE: "WORK" }],
              PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : [],
              SOURCE_DESCRIPTION: "Ask IAS chat" + (source ? " (" + source + ")" : ""),
              UTM_SOURCE: source || "ias_chat",
              UTM_CAMPAIGN: campaign
            },
            params: { REGISTER_SONET_EVENT: "Y" }
          });
          return json({ ok: true, created: !!id });
        }
        // Existing record: leave its fields alone, note what they typed.
        await bx(env, "crm.timeline.comment.add", { fields: {
          ENTITY_ID: rec.id, ENTITY_TYPE: rec.type,
          COMMENT: "Ask IAS chat: left contact details to continue. Name: " + (name || "-") + ", phone: " + (phone || "-")
        } });
        return json({ ok: true, created: false });
      }

      if (action === "log") {
        if (!email) return json({ error: "email" }, 400);
        const rec = await findRecord(env, email);
        if (!rec) return json({ error: "not_found" }, 404);
        const text = "Ask IAS chat" + (body.campaign ? " (campaign " + String(body.campaign).slice(0, 60) + ")" : "") +
          "\n\n" + String(body.transcript || "").slice(0, MAX_TRANSCRIPT);
        const cid = parseInt(body.cid, 10);
        if (cid > 0) {
          // Only update a comment that really sits on this person's record.
          try {
            const c = await bx(env, "crm.timeline.comment.get", { id: cid });
            if (c && String(c.ENTITY_ID) === String(rec.id) && String(c.ENTITY_TYPE).toLowerCase() === rec.type) {
              await bx(env, "crm.timeline.comment.update", { id: cid, fields: { COMMENT: text, ENTITY_ID: rec.id, ENTITY_TYPE: rec.type } });
              return json({ ok: true, cid });
            }
          } catch (e) { /* fall through and add a fresh comment */ }
        }
        const id = await bx(env, "crm.timeline.comment.add", { fields: { ENTITY_ID: rec.id, ENTITY_TYPE: rec.type, COMMENT: text } });
        return json({ ok: true, cid: id });
      }

      return json({ error: "action" }, 400);
    } catch (e) {
      return json({ error: e.code || "failed", detail: scrub(e.message) }, 502);
    }
  }
};

// ── Claude ───────────────────────────────────────────────────────
function systemPrompt(known) {
  if (!known) return PROMPT;
  return PROMPT + "\n\nWHAT WE ALREADY KNOW ABOUT THIS PERSON\n" +
    "They gave us these details earlier. Use them so you do not ask again. Refer to them naturally and confirm rather than assume " +
    "(for example: \"You mentioned you are in Brazil, is that still right?\"). Never read the list back or call it a record.\n" + known;
}

async function claude(env, system, messages) {
  if (!env.ANTHROPIC_API_KEY) throw codeErr("not_configured", "ANTHROPIC_API_KEY missing");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({ model: env.MODEL || "claude-sonnet-5-5", max_tokens: 700, system, messages })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw codeErr(res.status === 429 ? "rate_limited" : "upstream_error", (j.error && j.error.message) || ("HTTP " + res.status));
  const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (!text) throw codeErr("upstream_error", "empty reply");
  return text;
}

function cleanMessages(m) {
  if (!Array.isArray(m) || !m.length) return null;
  let out = m.slice(-MAX_TURNS).map(x => ({
    role: x && x.role === "assistant" ? "assistant" : "user",
    content: String((x && x.content) || "").slice(0, MAX_CHARS).trim()
  })).filter(x => x.content);
  // Merge same-role neighbours and make sure it starts and ends with the client.
  const merged = [];
  for (const x of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === x.role) last.content += "\n\n" + x.content; else merged.push({ ...x });
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  if (!merged.length || merged[merged.length - 1].role !== "user") return null;
  return merged;
}

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < RATE.windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE.max;
}

// ── Bitrix ───────────────────────────────────────────────────────
async function bx(env, method, params) {
  if (!env.BITRIX_WEBHOOK) throw codeErr("not_configured", "BITRIX_WEBHOOK missing");
  const base = env.BITRIX_WEBHOOK.replace(/\/(profile|[a-z]+\.[a-z.]+)\/?$/i, "").replace(/\/?$/, "/");
  const res = await fetch(base + method + ".json", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {})
  });
  const j = await res.json().catch(() => ({}));
  if (j.error) throw codeErr("bitrix", j.error + ": " + (j.error_description || ""));
  return j.result;
}

// Lead first, unless it was already converted; then contact.
async function findRecord(env, email) {
  const dup = async (type) => {
    const r = await bx(env, "crm.duplicate.findbycomm", { type: "EMAIL", values: [email], entity_type: type });
    const ids = (r && (r[type] || r[type.toLowerCase()])) || [];
    return ids.map(Number).sort((a, b) => b - a);
  };
  for (const id of await dup("LEAD")) {
    const lead = await bx(env, "crm.lead.get", { id });
    if (lead && lead.STATUS_ID !== "CONVERTED") return { type: "lead", id, data: lead };
  }
  const contacts = await dup("CONTACT");
  if (contacts.length) {
    const c = await bx(env, "crm.contact.get", { id: contacts[0] });
    if (c) return { type: "contact", id: contacts[0], data: c };
  }
  return null;
}

const fieldCache = {};
async function fieldsOf(env, type) {
  if (!fieldCache[type]) fieldCache[type] = await bx(env, "crm." + type + ".fields", {});
  return fieldCache[type];
}

async function profileText(env, rec) {
  const meta = await fieldsOf(env, rec.type);
  const lines = [];
  const name = [rec.data.NAME, rec.data.LAST_NAME].filter(Boolean).join(" ").trim();
  if (name) lines.push("Name: " + name);
  for (const key of Object.keys(rec.data)) {
    const m = meta[key];
    if (!m || !(key.indexOf("UF_") === 0 || STANDARD_OK.includes(key))) continue;
    const label = String(m.formLabel || m.listLabel || m.title || "").trim();
    const low = label.toLowerCase();
    if (!label || !PROFILE_WORDS.some(w => low.includes(w)) || PROFILE_SKIP.some(w => low.split(/[^a-z]+/).includes(w) || (w.includes(" ") && low.includes(w)))) continue;
    let v = rec.data[key];
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (m.items && m.items.length) {
      const byId = Object.fromEntries(m.items.map(i => [String(i.ID), i.VALUE]));
      v = (Array.isArray(v) ? v : [v]).map(x => byId[String(x)] || "").filter(Boolean).join(", ");
    } else if (Array.isArray(v)) {
      v = v.map(x => (x && x.VALUE) || x).join(", ");
    }
    v = String(v).replace(/\s+/g, " ").trim().slice(0, 200);
    if (!v || v === "0" || v === "N") continue;
    if (v === "Y") v = "yes";
    lines.push(label + ": " + v);
    if (lines.length >= 20) break;
  }
  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────
function cleanEmail(v) {
  v = String(v || "").trim().toLowerCase();
  return /^[^\s@#]+@[^\s@#]+\.[^\s@#]+$/.test(v) && v.length < 200 ? v : "";
}
function firstName(n) { return String(n || "").trim().split(/\s+/)[0].slice(0, 40); }
function codeErr(code, message) { const e = new Error(message); e.code = code; return e; }
function scrub(s) { return String(s || "").replace(/\/rest\/[^\s"']*/g, "/rest/…").slice(0, 200); }
