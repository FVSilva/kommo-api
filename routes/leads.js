import { Router } from "express";
import axios from "axios";
import dayjs from "dayjs";
import https from "https";
import axiosRetry from "axios-retry";
import fs from "fs";

const router = Router();

// =================== CONFIG ===================
const DOMAIN = "https://suporteexodosaudecom.kommo.com";

// 🔥 COLOQUE SEU TOKEN CORRETO AQUI (SEM QUEBRAR)
const TOKEN = "Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6IjlmN2ZkMmU2YTA5YTQ1YWVhMjUxMmE0YmFkMTAyZGQ5YmY0NzZlNTg4MDgwOGU2MmUxNjE3ODc4N2MxN2E4M2Y1NjAzMjk5Njg0YTQ4ZDhiIn0.eyJhdWQiOiI5MDdlYTRlMS0wNWU4LTQ5NTktYjUwYi0yM2JlYTU5OWFmNTMiLCJqdGkiOiI5ZjdmZDJlNmEwOWE0NWFlYTI1MTJhNGJhZDEwMmRkOWJmNDc2ZTU4ODA4MDhlNjJlMTYxNzg3ODdjMTdhODNmNTYwMzI5OTY4NGE0OGQ4YiIsImlhdCI6MTc3NTU5NDE4MiwibmJmIjoxNzc1NTk0MTgyLCJleHAiOjE4OTg1NTM2MDAsInN1YiI6IjEwNTY1Mzk1IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjMyMTU1NDM1LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJwdXNoX25vdGlmaWNhdGlvbnMiLCJmaWxlcyIsImNybSIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiZmJhZGY2ZDQtNjAzNi00MmY0LThhMDMtYWRlZThjN2E1OGM2IiwiYXBpX2RvbWFpbiI6ImFwaS1nLmtvbW1vLmNvbSJ9.HSKKSPnrq3EX87nWvVgu8xiSDNavqXkwkXKGHQcbnHyaTqeZAGROQuhvY5VtxIO3ilwNJcXYq3zLEWSR7MU4nQ5xohMiDu6y_yyO-AgT8jFLkqDukIKouzv1Cdd2C-Cqf5NGEssqEdh3quDjlqq_TziZnZdV03Gas2YQpNdyP8EUd9N4RAV-KzIKaJu0vj82caHnDFpslrBdHT-9fNOYeF9g4Do41Y5Roo3k23__xJQsvT7atk0kwihWfWaB25x35bZmOo8i6Tq4ia_KQKQoAlqLqY4dhE-JAyWuQUFVXNuhLL0X6YhhryHGkfspm08be394-qYEaY3FpXDt78BLIQ";

const START_DATE_DEFAULT = "2025-11-01";
const LIMIT_PER_PAGE = 250;
const CONTACTS_CHUNK = 40;
const THROTTLE_MS = 500; // 🔥 reduz 429
const UPDATE_INTERVAL_MINUTES = 30;
const CACHE_FILE = "./cache.json";

// =================== HTTP INFRA ===================
axiosRetry(axios, { retries: 5, retryDelay: axiosRetry.exponentialDelay });

const httpAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeGet(url, params = {}) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await wait(THROTTLE_MS);

      const res = await axios.get(url, {
        headers: {
          Authorization: TOKEN,
          Accept: "application/json",
        },
        params,
        timeout: 120000,
        httpAgent,
      });

      return res.data || {};
    } catch (err) {
      console.error("Erro real:", err.response?.data || err.message);
      await wait(2000);
    }
  }

  return {};
}

// =================== USERS ===================
async function fetchUsersMap() {
  const data = await safeGet(`${DOMAIN}/api/v4/users`, { limit: 500 });
  return new Map((data?._embedded?.users ?? []).map((u) => [u.id, u.name]));
}

// =================== LEADS ===================
async function fetchLeadsSince() {
  const startUnix = dayjs(START_DATE_DEFAULT).startOf("day").unix();
  const endUnix = dayjs().unix();

  let page = 1;
  const all = [];

  while (true) {
    const data = await safeGet(`${DOMAIN}/api/v4/leads`, {
      limit: LIMIT_PER_PAGE,
      page,

      // 🔥 FORMATO CORRETO PRA KOMMO
      "filter[created_at][from]": startUnix,
      "filter[created_at][to]": endUnix,

      with: "contacts",
    });

    const rows = data?._embedded?.leads ?? [];

    console.log(`Página ${page}: ${rows.length}`);

    if (!rows.length) break;

    all.push(...rows);

    if (rows.length < LIMIT_PER_PAGE) break;
    page++;
  }

  console.log("TOTAL LEADS:", all.length);

  return all;
}

// =================== CONTACTS ===================
async function fetchContactsByIds(idList) {
  if (!idList.length) return new Map();

  const uniq = [...new Set(idList)];
  const out = new Map();

  for (let i = 0; i < uniq.length; i += CONTACTS_CHUNK) {
    const chunk = uniq.slice(i, i + CONTACTS_CHUNK);
    const params = {};

    chunk.forEach((id, idx) => {
      params[`id[${idx}]`] = id;
    });

    const data = await safeGet(`${DOMAIN}/api/v4/contacts`, params);

    for (const c of data?._embedded?.contacts ?? []) {
      out.set(c.id, c);
    }
  }

  return out;
}

// =================== HELPERS ===================
function normalizeCF(arr, prefix = "") {
  const out = {};

  (arr || []).forEach((f) => {
    const key = prefix + (f.field_name || `field_${f.field_id}`);
    const val = (f.values || [])
      .map((v) => v.value)
      .filter(Boolean)
      .join(", ");

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

// =================== FLATTEN ===================
function flattenLead(lead, usersMap, contactsMap) {
  const contact = pickMainContact(lead, contactsMap);

  return {
    id: lead.id,
    name: lead.name,
    price: lead.price || 0,

    status_id: lead.status_id,

    responsible_user_id: lead.responsible_user_id || null,
    responsible_user_name:
      usersMap.get(lead.responsible_user_id) || null,

    created_at: dayjs.unix(lead.created_at).format("YYYY-MM-DD HH:mm:ss"),
    updated_at: lead.updated_at
      ? dayjs.unix(lead.updated_at).format("YYYY-MM-DD HH:mm:ss")
      : null,
    closed_at: lead.closed_at
      ? dayjs.unix(lead.closed_at).format("YYYY-MM-DD HH:mm:ss")
      : null,

    ...normalizeCF(lead.custom_fields_values),
    ...normalizeCF(contact?.custom_fields_values, "contact_"),

    contact_id: contact?.id || null,
    contact_name: contact?.name || null,
  };
}

// =================== CACHE ===================
let IN_MEMORY = { rows: [] };

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(IN_MEMORY.rows));
}

function loadCache() {
  try {
    IN_MEMORY.rows = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {}
}

// =================== BUILD ===================
async function buildAndCache() {
  console.log("🚀 Iniciando build...");

  const leads = await fetchLeadsSince();
  const usersMap = await fetchUsersMap();

  const contactIds = leads.flatMap(
    (l) => l._embedded?.contacts?.map((c) => c.id) ?? []
  );

  const contactsMap = await fetchContactsByIds(contactIds);

  IN_MEMORY.rows = leads.map((l) =>
    flattenLead(l, usersMap, contactsMap)
  );

  saveCache();

  console.log("✅ Finalizado. Total:", IN_MEMORY.rows.length);
}

// =================== ROUTE ===================
router.get("/", async (req, res) => {
  try {
    if (!IN_MEMORY.rows.length) {
      loadCache();

      if (!IN_MEMORY.rows.length) {
        await buildAndCache();
      }
    }

    res.json(IN_MEMORY.rows);
  } catch (err) {
    console.error("Erro geral:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

// atualização automática
setInterval(buildAndCache, UPDATE_INTERVAL_MINUTES * 60000);

export default router;
