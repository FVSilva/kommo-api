import { Router } from "express";
import axios from "axios";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import https from "https";
import axiosRetry from "axios-retry";
import fs from "fs";

const router = Router();

// ================= CONFIG =================
const DOMAIN = "https://suporteexodosaudecom.kommo.com";
const TOKEN = process.env.KOMMO_TOKEN;
const START_DATE_DEFAULT = "2025-11-01";
const LIMIT_PER_PAGE = 250;
const CONTACTS_CHUNK = 40;
const THROTTLE_MS = 150;
const CACHE_FILE = "./cache_fechados.json";

if (!TOKEN) {
  console.error("KOMMO_TOKEN não definido.");
}

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("America/Sao_Paulo");

// ================= INFRA =================
axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });

const httpAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 15,
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
      timeout: 45000,
      httpAgent,
    });

    return res.data || {};
  } catch (err) {
    console.error("Erro HTTP:", err.message);
    return {};
  }
}

// ================= FETCH LEADS =================
async function fetchLeadsPorMes(inicio, fim) {
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

    const filtrados = rows.filter(
      (l) => l.status_id === 142 || l.status_id === 143
    );

    all.push(...filtrados);

    if (rows.length < LIMIT_PER_PAGE) break;
    page++;
  }

  return all;
}

// ================= USERS =================
async function fetchUsersMap() {
  const data = await safeGet(`${DOMAIN}/api/v4/users`, { limit: 500 });
  const users = data?._embedded?.users ?? [];
  return new Map(users.map((u) => [u.id, u.name]));
}

// ================= CONTACTS =================
async function fetchContactsByIds(ids) {
  if (!ids.length) return new Map();

  const uniq = [...new Set(ids)];
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

// ================= FLATTEN =================
function flattenLead(lead, contactsMap, usersMap) {
  const rel = lead?._embedded?.contacts ?? [];
  const main = rel.find((c) => c.is_main) || rel[0];
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

// ================= BUILD =================
async function buildData() {
  console.log("Iniciando build...");

  const usersMap = await fetchUsersMap();

  let cursor = dayjs(START_DATE_DEFAULT);
  const hoje = dayjs();
  const leads = [];

  while (cursor.isBefore(hoje)) {
    const inicio = cursor.startOf("month").unix();
    const fim = cursor.endOf("month").unix();

    console.log(`Processando ${cursor.format("MM/YYYY")}`);

    const mes = await fetchLeadsPorMes(inicio, fim);
    leads.push(...mes);

    cursor = cursor.add(1, "month");
  }

  console.log("Total leads:", leads.length);

  const contactIds = leads.flatMap(
    (l) => l._embedded?.contacts?.map((c) => c.id) ?? []
  );

  const contactsMap = await fetchContactsByIds(contactIds);

  const finalData = leads.map((l) =>
    flattenLead(l, contactsMap, usersMap)
  );

  return finalData;
}

// ================= CACHE =================
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

// ================= ROUTE =================
router.get("/", async (req, res) => {
  try {
    const cache = loadCache();

    // Se cache existe → responde instantâneo
    if (Array.isArray(cache) && cache.length) {
      console.log("Respondendo via cache");
      res.json(cache);

      // Atualiza em background
      buildData()
        .then(saveCache)
        .catch((err) =>
          console.error("Erro atualização background:", err.message)
        );

      return;
    }

    console.log("Primeira execução - gerando cache");

    const data = await buildData();
    saveCache(data);

    res.json(data); // SEMPRE retorna lista
  } catch (err) {
    console.error("Erro geral:", err);
    res.json([]); // NUNCA retorna Record
  }
});

export default router;
