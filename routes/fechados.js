import { Router } from "express";
import axios from "axios";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import https from "https";
import axiosRetry from "axios-retry";
import fs from "fs";

const router = Router();

// =================== CONFIG ===================

const TOKEN = `Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6IjE0NGQ3YjY3Nzg0ODVjZmIwMmMxMDRmNzkwOTg4YmIxYmVlMDNmNjkzNzIyNGJlMGFiZTI3NGVjMzZiNDhlYjIwODVkYjY3ODA3NWM1MTg5In0.eyJhdWQiOiJlMDhkMWRkNy04MTE0LTQ1MGUtYmRlNS01NTRmNGEzZjU3N2EiLCJqdGkiOiIxNDRkN2I2Nzc4NDg1Y2ZiMDJjMTA0Zjc5MDk4OGJiMWJlZTAzZjY5MzcyMjRiZTBhYmUyNzRlYzM2YjQ4ZWIyMDg1ZGI2NzgwNzVjNTE4OSIsImlhdCI6MTc2MzA3Nzc0NiwibmJmIjoxNzYzMDc3NzQ2LCJleHAiOjE4NTkxNTUyMDAsInN1YiI6IjEwNTY1Mzk1IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjMyMTU1NDM1LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJjcm0iLCJmaWxlcyIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiLCJwdXNoX25vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiODIzYzVkZTQtMjdiMS00MjAzLTk4M2YtNjAyN2Q4OGU0NmRhIiwidXNlcl9mbGFncyI6MCwiYXBpX2RvbWFpbiI6ImFwaS1nLmtvbW1vLmNvbSJ9.mVylUY-n2xSzn5vt8ldTMPY03K0IQBvRUsmgvXdSZasLJFZo8lbkaKbEzpKUSrYoDztZ8tzTD4vxILOUzb05S0teG0RYnOIzwb7Y_kpVzn_oV8-BeGpRDWPnHzBkY0MLTKGZMD-ll5PnhtLrj3TF-6umDGkzq_uJvPUauEIOu3rET-AGrWVz0UsURvlvaQ5h53v0Hc2-Daoya4iz6_JXNnNQyMEHA0sz3wJLg9v1ofF--IRNyo5WeY2R41ppQ1AfniRlvq5Iwkj1W10LJZOUJpHsU8B16PpU1VQJV1gI7WwPIaqOZaqpny8xnL6OVRbF0aGfJS0gOnflR6eCRLR25w`;
const SUBDOMAIN = "https://suporteexodosaudecom.kommo.com"; // ex: v4company
const START_DATE_DEFAULT = "2025-11-01";
const LIMIT_PER_PAGE = 250;
const CONTACTS_CHUNK = 40;
const THROTTLE_MS = 250;
const CACHE_FILE = "./cache_fechados.json";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("America/Sao_Paulo");

// =================== INFRA ===================
axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

const httpAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 30,
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeGet(url, params = {}) {
  try {
    await wait(THROTTLE_MS);
    const res = await axios.get(url, {
      headers: { Authorization: TOKEN, Accept: "application/json" },
      params,
      timeout: 60000,
      httpAgent,
    });
    return res.data || {};
  } catch (err) {
    console.error("Erro HTTP:", err.message);
    return {};
  }
}

// =================== FETCH LEADS EM BLOCOS ===================
async function fetchLeadsFechadosPorMes(inicio, fim) {
  let page = 1;
  const all = [];

  while (true) {
    const data = await safeGet(`${DOMAIN}/api/v4/leads`, {
      limit: LIMIT_PER_PAGE,
      page,
      filter: {
        closed_at: {
          from: inicio,
          to: fim,
        },
      },
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

// =================== FETCH USERS ===================
async function fetchUsersMap() {
  const data = await safeGet(`${DOMAIN}/api/v4/users`, { limit: 500 });
  const users = data?._embedded?.users ?? [];
  return new Map(users.map((u) => [u.id, u.name]));
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
    for (const c of data?._embedded?.contacts ?? []) {
      out.set(c.id, c);
    }
  }

  return out;
}

// =================== FLATTEN ===================
function flattenLead(lead, contactsMap, usersMap) {
  const contactRel = lead?._embedded?.contacts ?? [];
  const main = contactRel.find((c) => c.is_main) || contactRel[0];
  const contact = main ? contactsMap.get(main.id) : null;

  return {
    id: lead.id,
    name: lead.name,
    price: lead.price || 0,
    status_id: lead.status_id,
    status_name: lead.status_id === 142 ? "Lead - Convertido" : "Lead - Perdido",
    responsible_user_id: lead.responsible_user_id || null,
    responsible_user_name:
      usersMap.get(lead.responsible_user_id) || "Sem responsável",
    created_at: lead.created_at
      ? dayjs.unix(lead.created_at).format("YYYY-MM-DD HH:mm:ss")
      : null,
    closed_at: lead.closed_at
      ? dayjs.unix(lead.closed_at).format("YYYY-MM-DD HH:mm:ss")
      : null,
    contact_id: contact?.id || null,
    contact_name: contact?.name || null,
  };
}

// =================== BUILD COM BLOCO MENSAL ===================
async function buildData() {
  const usersMap = await fetchUsersMap();

  let cursor = dayjs(START_DATE_DEFAULT);
  const hoje = dayjs();
  const allLeads = [];

  while (cursor.isBefore(hoje)) {
    const inicio = cursor.startOf("month").unix();
    const fim = cursor.endOf("month").unix();

    console.log(
      `Processando mês: ${cursor.format("MM/YYYY")}`
    );

    const leadsMes = await fetchLeadsFechadosPorMes(inicio, fim);
    allLeads.push(...leadsMes);

    cursor = cursor.add(1, "month");
  }

  const contactIds = allLeads.flatMap(
    (l) => l._embedded?.contacts?.map((c) => c.id) ?? []
  );

  const contactsMap = await fetchContactsByIds(contactIds);

  return allLeads.map((l) =>
    flattenLead(l, contactsMap, usersMap)
  );
}

// =================== CACHE ===================
function saveCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return [];
  }
}

// =================== ROUTE ===================
router.get("/", async (req, res) => {
  const cache = loadCache();

  // se já existe cache → responde instantâneo
  if (cache.length) {
    res.json(cache);

    // atualiza em background
    buildData()
      .then(saveCache)
      .catch(() => {});
    return;
  }

  // primeira execução
  const data = await buildData();
  saveCache(data);
  res.json(data);
});

export default router;
