import { Router } from "express";
import axios from "axios";
import dayjs from "dayjs";
import https from "https";
import axiosRetry from "axios-retry";
import fs from "fs";

const router = Router();

// =================== CONFIG ===================
const DOMAINS = [
  "https://suporteexodosaudecom.kommo.com",
  "https://api-g.kommo.com",
];

const TOKEN =
  "Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6Ijg3ZDM3MTQ2YmQ2YzJlMTNhMjdhZjRmYzVkYTNkNWUwZTkyNDkxYjMyY2I0MGYwYTJjYmYyMWRkMjg0YzI1MmM0YmZiMjlhNzhiZmE4ZmEwIn0.eyJhdWQiOiI5MDdlYTRlMS0wNWU4LTQ5NTktYjUwYi0yM2JlYTU5OWFmNTMiLCJqdGkiOiI4N2QzNzE0NmJkNmMyZTEzYTI3YWY0ZmM1ZGEzZDVlMGU5MjQ5MWIzMmNiNDBmMGEyY2JmMjFkZDI4NGMyNTJjNGJmYjI5YTc4YmZhOGZhMCIsImlhdCI6MTc3NTY5NTQ1OSwibmJmIjoxNzc1Njk1NDU5LCJleHAiOjE4MTQ0ODY0MDAsInN1YiI6IjEwNTY1Mzk1IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjMyMTU1NDM1LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJwdXNoX25vdGlmaWNhdGlvbnMiLCJmaWxlcyIsImNybSIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiMmYzOThhYjMtY2FhNy00YjEwLTg0OGQtYjk2MDQ1ZWI4MzdkIiwiYXBpX2RvbWFpbiI6ImFwaS1nLmtvbW1vLmNvbSJ9.kIllfN-LwRo5s6j62v9prZ0Fj1SkQZicT_Q4yMG0kGbxmKrL73aLVb-xwD817QC_9LvMcWXMAC9L02nYHXX2gKDgJpq7MfiIME6jy2rQRiBZRWVVqLG4FncIDuX9yhvI-2Irhv9O16teF7UbPWYtiUXc6CvDtujMP5TpMSyNptXZkaxlsjDwNUXlut8SEsYAilMiUukOR9JCCfqUPDyP-iS6Dn-ccX9VyYqZdLlYPtyM74K8vFuBhzFx7W8Tfwa-Iqxj5vIzpMW0VzOyLuMwq6UsNbw8LDtsqBoRImqvSLvdjFgMg3kchZq4dveY40TZQ_XwoxFRjYhduYLbeswC5g";

const START_DATE_DEFAULT = "2025-11-01";
const LIMIT_PER_PAGE = 250;
const CONTACTS_CHUNK = 40;
const THROTTLE_MS = 300;
const UPDATE_INTERVAL_MINUTES = 30;
const CACHE_FILE = "./cache.json";

// =================== HTTP INFRA ===================
axiosRetry(axios, {
  retries: 2,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    const status = error?.response?.status;
    if (status === 401 || status === 403) return false;
    return axiosRetry.isNetworkOrIdempotentRequestError(error);
  },
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 60,
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeGet(path, params = {}) {
  let lastError = null;

  for (const domain of DOMAINS) {
    const url = `${domain}${path}`;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await wait(THROTTLE_MS);

        const res = await axios.get(url, {
          headers: {
            Authorization: TOKEN,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          params,
          timeout: 30000,
          httpsAgent,
          validateStatus: () => true,
        });

        if (res.status >= 200 && res.status < 300) {
          return res.data || {};
        }

        console.error(`[safeGet] attempt ${attempt} failed`, {
          url,
          status: res.status,
          body: typeof res.data === "string" ? res.data : JSON.stringify(res.data),
        });

        lastError = {
          domain,
          url,
          status: res.status,
          body: res.data,
        };

        if (res.status === 401 || res.status === 403) {
          break;
        }

        await wait(1500 * attempt);
      } catch (err) {
        const status = err?.response?.status ?? null;
        const body = err?.response?.data ?? err.message;

        console.error(`[safeGet] attempt ${attempt} exception`, {
          url,
          status,
          body,
        });

        lastError = {
          domain,
          url,
          status,
          body,
        };

        if (status === 401 || status === 403) {
          break;
        }

        await wait(1500 * attempt);
      }
    }
  }

  console.error("[safeGet] all attempts failed", lastError);
  return {};
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

// =================== PIPELINES ===================
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
    statusInfoById.set(sid, { ...old, status_id: sid, status_name: name });
  }

  return { pipelineNameById, statusInfoById };
}

// =================== USERS ===================
async function fetchUsersMap() {
  const data = await safeGet("/api/v4/users", { limit: 500 });
  return new Map((data?._embedded?.users ?? []).map((u) => [u.id, u.name]));
}

// =================== LEADS ===================
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

    const data = await safeGet("/api/v4/contacts", params);
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

// =================== FLATTEN ===================
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
  fs.writeFileSync(CACHE_FILE, JSON.stringify(IN_MEMORY.rows, null, 2));
}

function loadCache() {
  try {
    IN_MEMORY.rows = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    IN_MEMORY.rows = [];
  }
}

async function buildAndCache() {
  const [leads, usersMap, maps] = await Promise.all([
    fetchLeadsSince(),
    fetchUsersMap(),
    fetchPipelineStatusMaps(),
  ]);

  const contactIds = leads.flatMap((l) => l._embedded?.contacts?.map((c) => c.id) ?? []);
  const contactsMap = await fetchContactsByIds(contactIds);

  IN_MEMORY.rows = leads.map((l) =>
    flattenLead(l, usersMap, maps.pipelineNameById, maps.statusInfoById, contactsMap)
  );

  saveCache();
}

// =================== ROUTES ===================
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
    res.status(500).json({
      ok: false,
      error: err?.message || "Erro interno",
    });
  }
});

router.get("/debug", async (req, res) => {
  try {
    const startUnix = dayjs(START_DATE_DEFAULT).startOf("day").unix();
    const endUnix = dayjs().unix();

    const raw = await safeGet("/api/v4/leads", {
      limit: 5,
      page: 1,
      "filter[created_at][from]": startUnix,
      "filter[created_at][to]": endUnix,
      with: "contacts",
    });

    res.json({
      ok: true,
      filter: { from: startUnix, to: endUnix },
      leads_count: raw?._embedded?.leads?.length ?? 0,
      raw_sample: raw,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || "Erro no debug",
    });
  }
});

router.get("/test-kommo", async (req, res) => {
  const results = [];

  for (const domain of DOMAINS) {
    try {
      const response = await axios.get(`${domain}/api/v4/account`, {
        headers: {
          Authorization: TOKEN,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 30000,
        httpsAgent,
        validateStatus: () => true,
      });

      results.push({
        domain,
        status: response.status,
        data: response.data,
      });
    } catch (err) {
      results.push({
        domain,
        status: err?.response?.status || null,
        data: err?.response?.data || err.message,
      });
    }
  }

  res.json({
    ok: true,
    results,
  });
});

setInterval(() => {
  buildAndCache().catch((err) => {
    console.error("[buildAndCache] error", err?.message || err);
  });
}, UPDATE_INTERVAL_MINUTES * 60000);

export default router;
