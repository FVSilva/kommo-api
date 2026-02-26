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

const DOMAIN = "https://suporteexodosaudecom.kommo.com";
const TOKEN = process.env.KOMMO_TOKEN; // ⚠️ NUNCA hardcode token
const START_DATE_DEFAULT = "2025-11-01";
const LIMIT_PER_PAGE = 250;
const CONTACTS_CHUNK = 40;
const THROTTLE_MS = 200;
const CACHE_FILE = "./cache_fechados.json";

if (!TOKEN) {
  throw new Error("KOMMO_TOKEN não definido nas variáveis de ambiente.");
}

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("America/Sao_Paulo");

// =================== INFRA ===================
axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

const httpAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeGet(url, params = {}) {
  try {
    await wait(THROTTLE_MS);

    const res = await axios.get(url, {
      headers: {
        Authorization: TOKEN,
        Accept: "application/json",
      },
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

// =================== FETCH LEADS ===================
async function fetchLeadsFechadosPorMes(inicio, fim) {
  let page = 1;
  const all = [];

  while (true) {
    const data = await safeGet(`${DOMAIN}/api/v4/leads`, {
      limit: LIMIT_PER_PAGE,
      page,
      filter: {
        closed_at: { from: inicio, to: fim },
      },
      with: "contacts",
    });

    const rows = data?._embedded?.leads ?? [];
    if (!rows.length) break;

    // filtra já aqui pra reduzir memória
    const fechados = rows.filter(
      (l) => l.status_id === 142 || l.status_id === 143
    );

    all.push(...fechados);

    if (rows.length < LIMIT_PER_PAGE) break;
    page++;
  }

  return all;
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
    status_name:
      lead.status_id === 142
        ? "Lead - Convertido"
        : "Lead - Perdido",
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

// =================== BUILD ===================
async function buildData() {
  console.log("Iniciando build...");

  const usersMap = await fetchUsersMap();

  let cursor = dayjs(START_DATE_DEFAULT);
  const hoje = dayjs();
  const allLeads = [];

  while (cursor.isBefore(hoje)) {
    const inicio = cursor.startOf("month").unix();
    const fim = cursor.endOf("month").unix();

    console.log(`Processando ${cursor.format("MM/YYYY")}`);

    const leadsMes = await fetchLeadsFechadosPorMes(inicio, fim);
    allLeads.push(...leadsMes);

    cursor = cursor.add(1, "month");
  }

  console.log("Total leads encontrados:", allLeads.length);

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
  try {
    const cache = loadCache();

    if (cache.length) {
      console.log("Respondendo via cache...");
      res.json(cache);

      // atualiza em background
      buildData()
        .then(saveCache)
        .catch((err) =>
          console.error("Erro atualização background:", err.message)
        );

      return;
    }

    console.log("Primeira execução, gerando cache...");
    const data = await buildData();
    saveCache(data);

    res.json(data);
  } catch (err) {
    console.error("Erro geral:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

export default router;
