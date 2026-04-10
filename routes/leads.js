import { Router } from "express";
import axios from "axios";
import dayjs from "dayjs";
import https from "https";
import fs from "fs";

const router = Router();

// =================== CONFIG ===================
const DOMAIN = "https://suporteexodosaudecom.kommo.com";
const TOKEN = "Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6IjM5MDhiZmRiNWVkNTE0N2ZjOTYzMjU1MDAyNTAxMzBhZDZmNTRmYWI1NWZhZTRjZWJhYzg5ODFlNGU0ZTc2OWVkNjQ2Zjg4MmZiMTQ2ODM3In0.eyJhdWQiOiIyZjExZGYxNC04ZTc4LTQyZmEtYTQxOC1mOWZkMmMxM2JkYjIiLCJqdGkiOiIzOTA4YmZkYjVlZDUxNDdmYzk2MzI1NTAwMjUwMTMwYWQ2ZjU0ZmFiNTVmYWU0Y2ViYWM4OTgxZTRlNGU3NjllZDY0NmY4ODJmYjE0NjgzNyIsImlhdCI6MTc3NDcxNDU2MSwibmJmIjoxNzc0NzE0NTYxLCJleHAiOjE4NTEzNzkyMDAsInN1YiI6IjEwNTY1Mzk1IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjMyMTU1NDM1LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJwdXNoX25vdGlmaWNhdGlvbnMiLCJmaWxlcyIsImNybSIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiZWY5YjE3NDgtMzY3Ny00MGU2LWJkMjYtMmZiM2E2M2Q3NzYwIiwiYXBpX2RvbWFpbiI6ImFwaS1nLmtvbW1vLmNvbSJ9.SVkjNnjG6gtFfjcC9kpVniBLHosmZKbfxDt7Q8fo6Wx676ZYYyRDWk-4fGEmV85Wd9xjtGwLQcHtHk25eXFXRsGsLY8_uIdf1OkXt67n0JLmK5LN_tPlPnzfk32rQcJRaZH7uXDSa8J2xwE2A9yhU15v_KmAfjlz7dcYooy-oXoLzd_O9tLcRdDcequ1Gpefl6ZWVNh8a46k7GCM-_tHUDHlBZOTT5hWYURl18-HsOAb0e11WE9Fmo_IiYMRIPTBDv1zkVuIS9NAbCFtsEQscW3V2U1UQdxHlo6szzGk5QbnCLJdy_yu_hS7DUQJ6K4VKH-3r2cNVX-uedxZ_dx6Ng";

const START_DATE_DEFAULT = "2025-11-01";
const LIMIT_PER_PAGE = 250;
const CONTACTS_CHUNK = 40;
const CONTACTS_CONCURRENCY = 2;
const CACHE_FILE = "./cache.json";
const UPDATE_INTERVAL_MINUTES = 30;

// abaixo do limite da Kommo, com folga
const MIN_INTERVAL_MS = 200; // 5 req/s
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 30000;

// =================== INFRA ===================
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
let isSyncing = false;
let syncPromise = null;

let IN_MEMORY = {
  rows: [],
  meta: {
    lastSync: null,
    lastSuccessSync: null,
    status: "never",
    error: null,
    rowCount: 0,
    durationMs: null,
  },
};

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(IN_MEMORY, null, 2));
}

function loadCache() {
  try {
    IN_MEMORY = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {}
}

async function throttle() {
  const now = Date.now();
  const diff = now - lastRequestAt;

  if (diff < MIN_INTERVAL_MS) {
    await wait(MIN_INTERVAL_MS - diff);
  }

  lastRequestAt = Date.now();
}

function getErrorMessage(err) {
  return (
    err?.response?.data?.title ||
    err?.response?.data?.detail ||
    err?.response?.data?.message ||
    err?.message ||
    "Unknown error"
  );
}

async function safeGet(path, params = {}) {
  const url = `${DOMAIN}${path}`;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    await throttle();

    try {
      const res = await axios.get(url, {
        headers: {
          Authorization: TOKEN,
          Accept: "application/json",
        },
        params,
        timeout: REQUEST_TIMEOUT_MS,
        httpsAgent,
        validateStatus: () => true,
      });

      if (res.status >= 200 && res.status < 300) {
        return res.data || {};
      }

      if (res.status === 401 || res.status === 403) {
        throw new Error(`Kommo auth/block error ${res.status}`);
      }

      if (res.status === 429) {
        if (attempt <= MAX_RETRIES) {
          await wait(4000 * attempt);
          continue;
        }
        throw new Error("Kommo rate limit exceeded 429");
      }

      if ((res.status >= 500 || res.status === 408) && attempt <= MAX_RETRIES) {
        await wait(1500 * attempt);
        continue;
      }

      throw new Error(`Kommo HTTP ${res.status}`);
    } catch (err) {
      const msg = getErrorMessage(err);

      if (msg.includes("auth/block error") || attempt > MAX_RETRIES) {
        throw new Error(msg);
      }

      if (
        err?.code === "ECONNABORTED" ||
        err?.code === "ETIMEDOUT" ||
        err?.code === "ECONNRESET" ||
        err?.code === "ENOTFOUND"
      ) {
        await wait(1500 * attempt);
        continue;
      }

      await wait(1000 * attempt);
    }
  }

  throw new Error(`safeGet failed: ${url}`);
}

// =================== STATUS MAP ===================
const FIXED_STATUS_MAP = {
  63763579: "Leads de Entrada",
  66551103: "WhatsApp",
  63763583: "Contato Inicial",
  65147703: "Leads Nativo",
  66735635: "Lista de Transmissão",
  65962599: "Recaptação",
  65158735: "Em Atendimento",
  63763587: "Em Negociação",
  67871247: "Cliente Futuro",
  63763591: "Aguardando Documentos",
  63763595: "Gerar Proposta",
  64012623: "Aguardando Declaração de Saúde",
  64012627: "Aguardando Operadora",
  64012631: "Pendente Informação ADM",
  64012635: "Aguardando Assinatura / 2° Aceite",
  64012639: "Acompanhar 1° Pagamento",
  69374483: "Lead Ganho | Indicação",
  142: "Lead - Convertido",
  143: "Lead - Perdido",
};

// =================== FETCH ===================
async function fetchPipelineStatusMaps() {
  const data = await safeGet("/api/v4/leads/pipelines");
  const pipelines = data?._embedded?.pipelines ?? [];

  const pipelineNameById = new Map();
  const statusInfoById = new Map();

  for (const p of pipelines) {
    pipelineNameById.set(p.id, p.name);

    for (const s of p.statuses ?? []) {
      statusInfoById.set(s.id, {
        pipeline_id: p.id,
        pipeline_name: p.name,
        status_id: s.id,
        status_name: s.name,
      });
    }
  }

  for (const [id, name] of Object.entries(FIXED_STATUS_MAP)) {
    const sid = Number(id);
    const old = statusInfoById.get(sid) || {};
    statusInfoById.set(sid, {
      ...old,
      status_id: sid,
      status_name: name,
    });
  }

  return { pipelineNameById, statusInfoById };
}

async function fetchUsersMap() {
  const data = await safeGet("/api/v4/users", { limit: 250 });
  return new Map((data?._embedded?.users ?? []).map((u) => [u.id, u.name]));
}

async function fetchLeadsSince() {
  const startUnix = dayjs(START_DATE_DEFAULT).startOf("day").unix();
  const endUnix = dayjs().unix();

  let page = 1;
  const all = [];

  while (true) {
    const data = await safeGet("/api/v4/leads", {
      limit: LIMIT_PER_PAGE,
      page,
      "filter[created_at][from]": startUnix,
      "filter[created_at][to]": endUnix,
      with: "contacts",
    });

    const rows = data?._embedded?.leads ?? [];

    if (!rows.length) break;

    all.push(...rows);

    if (rows.length < LIMIT_PER_PAGE) break;
    page++;
  }

  return all;
}

async function fetchContactsChunk(chunk) {
  const params = {};

  chunk.forEach((id, idx) => {
    params[`id[${idx}]`] = id;
  });

  const data = await safeGet("/api/v4/contacts", params);
  return data?._embedded?.contacts ?? [];
}

async function fetchContactsByIds(idList) {
  if (!idList.length) return new Map();

  const uniq = [...new Set(idList)];
  const chunks = [];

  for (let i = 0; i < uniq.length; i += CONTACTS_CHUNK) {
    chunks.push(uniq.slice(i, i + CONTACTS_CHUNK));
  }

  const out = new Map();

  for (let i = 0; i < chunks.length; i += CONTACTS_CONCURRENCY) {
    const batch = chunks.slice(i, i + CONTACTS_CONCURRENCY);
    const results = await Promise.all(batch.map(fetchContactsChunk));

    for (const contacts of results) {
      for (const c of contacts) {
        out.set(c.id, c);
      }
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

function flattenLead(lead, usersMap, pipelineNameById, statusInfoById, contactsMap) {
  const statusId = Number(lead.status_id);
  const statusInfo = statusInfoById.get(statusId) ?? {};
  const contact = pickMainContact(lead, contactsMap);

  return {
    id: lead.id,
    name: lead.name,
    price: lead.price || 0,

    pipeline_id: lead.pipeline_id,
    pipeline_name: pipelineNameById.get(lead.pipeline_id) || null,

    status_id: statusId,
    status_name: statusInfo.status_name || FIXED_STATUS_MAP[statusId] || null,

    responsible_user_id: lead.responsible_user_id || null,
    responsible_user_name: usersMap.get(lead.responsible_user_id) || null,

    created_at: lead.created_at
      ? dayjs.unix(lead.created_at).format("YYYY-MM-DD HH:mm:ss")
      : null,
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

// =================== BUILD ===================
async function buildAndCache(force = false) {
  if (isSyncing && !force) return syncPromise;

  isSyncing = true;
  IN_MEMORY.meta.status = "syncing";
  IN_MEMORY.meta.error = null;
  saveCache();

  const startedAt = Date.now();

  syncPromise = (async () => {
    try {
      const maps = await fetchPipelineStatusMaps();
      const usersMap = await fetchUsersMap();
      const leads = await fetchLeadsSince();

      const contactIds = leads.flatMap(
        (l) => l._embedded?.contacts?.map((c) => c.id) ?? []
      );

      const contactsMap = await fetchContactsByIds(contactIds);

      const rows = leads.map((l) =>
        flattenLead(
          l,
          usersMap,
          maps.pipelineNameById,
          maps.statusInfoById,
          contactsMap
        )
      );

      IN_MEMORY.rows = rows;
      IN_MEMORY.meta.lastSync = new Date().toISOString();
      IN_MEMORY.meta.lastSuccessSync = IN_MEMORY.meta.lastSync;
      IN_MEMORY.meta.status = "ok";
      IN_MEMORY.meta.error = null;
      IN_MEMORY.meta.rowCount = rows.length;
      IN_MEMORY.meta.durationMs = Date.now() - startedAt;

      saveCache();
      return IN_MEMORY;
    } catch (err) {
      IN_MEMORY.meta.lastSync = new Date().toISOString();
      IN_MEMORY.meta.status = "error";
      IN_MEMORY.meta.error = getErrorMessage(err);
      IN_MEMORY.meta.durationMs = Date.now() - startedAt;

      saveCache();
      return IN_MEMORY;
    } finally {
      isSyncing = false;
      syncPromise = null;
    }
  })();

  return syncPromise;
}

// =================== ROUTES ===================
router.get("/", async (req, res) => {
  loadCache();

  // primeira carga: espera popular o cache para nao responder []
  if (!IN_MEMORY.rows.length) {
    const result = await buildAndCache();
    return res.json(result.rows);
  }

  // se ja existe cache, responde instantaneamente
  if (!isSyncing) {
    buildAndCache().catch(() => {});
  }

  return res.json(IN_MEMORY.rows);
});

router.get("/status", async (req, res) => {
  loadCache();
  res.json(IN_MEMORY.meta);
});

router.get("/sync", async (req, res) => {
  const result = await buildAndCache(true);

  res.json({
    ok: result.meta.status === "ok",
    meta: result.meta,
    rowCount: result.rows.length,
  });
});

router.get("/test-kommo", async (req, res) => {
  try {
    const data = await safeGet("/api/v4/account");
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: getErrorMessage(err),
    });
  }
});

// =================== STARTUP ===================
loadCache();

if (!IN_MEMORY.rows.length && !isSyncing) {
  buildAndCache().catch(() => {});
}

setInterval(() => {
  buildAndCache().catch(() => {});
}, UPDATE_INTERVAL_MINUTES * 60000);

export default router;
