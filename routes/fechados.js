import { Router } from "express";
import axios from "axios";
import cors from "cors";
import compression from "compression";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import https from "https";
import axiosRetry from "axios-retry";
import fs from "fs";

const router = Router();

// =================== CONFIG ===================
const DOMAIN = "https://suporteexodosaudecom.kommo.com";
const TOKEN = "Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6IjE0NGQ3YjY3Nzg0ODVjZmIwMmMxMDRmNzkwOTg4YmIxYmVlMDNmNjkzNzIyNGJlMGFiZTI3NGVjMzZiNDhlYjIwODVkYjY3ODA3NWM1MTg5In0.eyJhdWQiOiJlMDhkMWRkNy04MTE0LTQ1MGUtYmRlNS01NTRmNGEzZjU3N2EiLCJqdGkiOiIxNDRkN2I2Nzc4NDg1Y2ZiMDJjMTA0Zjc5MDk4OGJiMWJlZTAzZjY5MzcyMjRiZTBhYmUyNzRlYzM2YjQ4ZWIyMDg1ZGI2NzgwNzVjNTE4OSIsImlhdCI6MTc2MzA3Nzc0NiwibmJmIjoxNzYzMDc3NzQ2LCJleHAiOjE4NTkxNTUyMDAsInN1YiI6IjEwNTY1Mzk1IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjMyMTU1NDM1LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJjcm0iLCJmaWxlcyIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiLCJwdXNoX25vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiODIzYzVkZTQtMjdiMS00MjAzLTk4M2YtNjAyN2Q4OGU0NmRhIiwidXNlcl9mbGFncyI6MCwiYXBpX2RvbWFpbiI6ImFwaS1nLmtvbW1vLmNvbSJ9.mVylUY-n2xSzn5vt8ldTMPY03K0IQBvRUsmgvXdSZasLJFZo8lbkaKbEzpKUSrYoDztZ8tzTD4vxILOUzb05S0teG0RYnOIzwb7Y_kpVzn_oV8-BeGpRDWPnHzBkY0MLTKGZMD-ll5PnhtLrj3TF-6umDGkzq_uJvPUauEIOu3rET-AGrWVz0UsURvlvaQ5h53v0Hc2-Daoya4iz6_JXNnNQyMEHA0sz3wJLg9v1ofF--IRNyo5WeY2R41ppQ1AfniRlvq5Iwkj1W10LJZOUJpHsU8B16PpU1VQJV1gI7WwPIaqOZaqpny8xnL6OVRbF0aGfJS0gOnflR6eCRLR25w";

const START_DATE_DEFAULT = "2025-10-01";
const LIMIT_PER_PAGE = 250;
const CONTACTS_CHUNK = 40;
const THROTTLE_MS = 300;
const CACHE_FILE = "./cache_fechados.json";
const META_FILE = "./cache_meta_fechados.json";

// =================== TIMEZONE ===================
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("America/Sao_Paulo");

// =================== INFRA ===================
axiosRetry(axios, { retries: 5, retryDelay: axiosRetry.exponentialDelay });
const httpAgent = new https.Agent({ keepAlive: true, maxSockets: 60 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeGet(url, params = {}) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await wait(THROTTLE_MS);
      const res = await axios.get(url, {
        headers: { Authorization: TOKEN, Accept: "application/json" },
        params,
        timeout: 120000,
        httpAgent,
      });
      return res.data || {};
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        await wait(2000);
        continue;
      }
      console.error("❌ HTTP:", status, err.message);
      return {};
    }
  }
  return {};
}

// =================== STATUS MAP ===================
const FIXED_STATUS_MAP = {
  142: "Lead - Convertido",
  143: "Lead - Perdido",
};

// =================== HELPERS ===================
function normalizeCF(arr, prefix = "") {
  const out = {};
  (arr || []).forEach((f) => {
    const key = prefix + (f.field_name || `field_${f.field_id}`);
    const val = (f.values || []).map((v) => v.value).filter(Boolean).join(", ");
    out[key] = val || null;
  });
  return out;
}

function pickMainContact(lead, contactsMap) {
  const rel = lead?._embedded?.contacts ?? [];
  if (!rel.length) return null;
  const main = rel.find((c) => c.is_main) || rel[0];
  return contactsMap.get(main.id) || null;
}

// =================== USERS ===================
async function fetchUsersMap() {
  const data = await safeGet(`${DOMAIN}/api/v4/users`, { limit: 500 });
  const users = data?._embedded?.users ?? [];
  return new Map(users.map((u) => [u.id, u.name]));
}

// =================== LEADS FECHADOS ===================
async function fetchLeadsFechados() {
  const startUnix = dayjs(START_DATE_DEFAULT).startOf("day").unix();
  const endUnix = dayjs().endOf("day").unix();

  let page = 1;
  const all = [];

  while (true) {
    const data = await safeGet(`${DOMAIN}/api/v4/leads`, {
      limit: LIMIT_PER_PAGE,
      page,
      filter: { closed_at: { from: startUnix, to: endUnix } },
      with: "contacts",
    });

    const rows = data?._embedded?.leads ?? [];
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < LIMIT_PER_PAGE) break;
    page++;
  }

  return all.filter((l) => l.status_id === 142 || l.status_id === 143);
}

// =================== CONTACTS ===================
async function fetchContactsByIds(idList) {
  if (!idList.length) return new Map();
  const uniq = [...new Set(idList)];
  const out = new Map();

  for (let i = 0; i < uniq.length; i += CONTACTS_CHUNK) {
    const chunk = uniq.slice(i, i + CONTACTS_CHUNK);
    const params = {};
    chunk.forEach((id, idx) => (params[`id[${idx}]`] = id));
    const data = await safeGet(`${DOMAIN}/api/v4/contacts`, params);
    for (const c of data?._embedded?.contacts ?? []) out.set(c.id, c);
  }
  return out;
}

// =================== FLATTEN ===================
function flattenLead(lead, contactsMap, usersMap) {
  const contact = pickMainContact(lead, contactsMap);
  const contactCF = contact ? normalizeCF(contact.custom_fields_values, "contact_") : {};

  return {
    id: lead.id,
    name: lead.name,
    price: lead.price || 0,
    status_id: lead.status_id,
    status_name: FIXED_STATUS_MAP[lead.status_id] || "Outro",
    responsible_user_id: lead.responsible_user_id || null,
    responsible_user_name: usersMap.get(lead.responsible_user_id) || "Sem responsável",
    created_at: lead.created_at ? dayjs.unix(lead.created_at).format("YYYY-MM-DD HH:mm:ss") : null,
    updated_at: lead.updated_at ? dayjs.unix(lead.updated_at).format("YYYY-MM-DD HH:mm:ss") : null,
    closed_at: lead.closed_at ? dayjs.unix(lead.closed_at).format("YYYY-MM-DD HH:mm:ss") : null,
    contact_id: contact?.id || null,
    contact_name: contact?.name || null,
    ...contactCF,
  };
}

// =================== CACHE ===================
let IN_MEMORY = { rows: [], last_update: null };

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(IN_MEMORY.rows, null, 2));
  fs.writeFileSync(META_FILE, JSON.stringify({ last_update: IN_MEMORY.last_update }, null, 2));
}

async function buildAndCache() {
  const [leads, usersMap] = await Promise.all([
    fetchLeadsFechados(),
    fetchUsersMap(),
  ]);

  const contactIds = leads.flatMap((l) => l._embedded?.contacts?.map((c) => c.id) ?? []);
  const contactsMap = await fetchContactsByIds(contactIds);

  IN_MEMORY.rows = leads.map((l) => flattenLead(l, contactsMap, usersMap));
  IN_MEMORY.last_update = dayjs().format("YYYY-MM-DD HH:mm:ss");
  saveCache();
}

// =================== ROUTE ===================
router.get("/", async (req, res) => {
  await buildAndCache();
  res.json(IN_MEMORY.rows);
});

export default router;
