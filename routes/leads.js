import { Router } from "express";
import axios from "axios";
import dayjs from "dayjs";
import https from "https";
import fs from "fs";

const router = Router();

// =================== CONFIG ===================
const DOMAIN = "https://suporteexodosaudecom.kommo.com";

// ⚠️ TOKEN DIRETO NO CÓDIGO (como você pediu)
const TOKEN =
  "Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6Ijg3ZDM3MTQ2YmQ2YzJlMTNhMjdhZjRmYzVkYTNkNWUwZTkyNDkxYjMyY2I0MGYwYTJjYmYyMWRkMjg0YzI1MmM0YmZiMjlhNzhiZmE4ZmEwIn0.eyJhdWQiOiI5MDdlYTRlMS0wNWU4LTQ5NTktYjUwYi0yM2JlYTU5OWFmNTMiLCJqdGkiOiI4N2QzNzE0NmJkNmMyZTEzYTI3YWY0ZmM1ZGEzZDVlMGU5MjQ5MWIzMmNiNDBmMGEyY2JmMjFkZDI4NGMyNTJjNGJmYjI5YTc4YmZhOGZhMCIsImlhdCI6MTc3NTY5NTQ1OSwibmJmIjoxNzc1Njk1NDU5LCJleHAiOjE4MTQ0ODY0MDAsInN1YiI6IjEwNTY1Mzk1IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjMyMTU1NDM1LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJwdXNoX25vdGlmaWNhdGlvbnMiLCJmaWxlcyIsImNybSIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiMmYzOThhYjMtY2FhNy00YjEwLTg0OGQtYjk2MDQ1ZWI4MzdkIiwiYXBpX2RvbWFpbiI6ImFwaS1nLmtvbW1vLmNvbSJ9.kIllfN-LwRo5s6j62v9prZ0Fj1SkQZicT_Q4yMG0kGbxmKrL73aLVb-xwD817QC_9LvMcWXMAC9L02nYHXX2gKDgJpq7MfiIME6jy2rQRiBZRWVVqLG4FncIDuX9yhvI-2Irhv9O16teF7UbPWYtiUXc6CvDtujMP5TpMSyNptXZkaxlsjDwNUXlut8SEsYAilMiUukOR9JCCfqUPDyP-iS6Dn-ccX9VyYqZdLlYPtyM74K8vFuBhzFx7W8Tfwa-Iqxj5vIzpMW0VzOyLuMwq6UsNbw8LDtsqBoRImqvSLvdjFgMg3kchZq4dveY40TZQ_XwoxFRjYhduYLbeswC5g";

const START_DATE_DEFAULT = "2025-11-01";
const LIMIT_PER_PAGE = 250;
const CONTACTS_CHUNK = 40;
const CACHE_FILE = "./cache.json";
const UPDATE_INTERVAL_MINUTES = 30;

// 🔥 LIMITE REAL (seguro abaixo de 7 req/s)
const MIN_INTERVAL_MS = 250; // 4 req/s
const MAX_RETRIES = 2;

// =================== INFRA ===================
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 20,
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;

async function throttle() {
  const now = Date.now();
  const diff = now - lastRequestAt;

  if (diff < MIN_INTERVAL_MS) {
    await wait(MIN_INTERVAL_MS - diff);
  }

  lastRequestAt = Date.now();
}

// =================== SAFE GET ===================
async function safeGet(path, params = {}) {
  const url = `${DOMAIN}${path}`;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      await throttle();

      const res = await axios.get(url, {
        headers: {
          Authorization: TOKEN,
          Accept: "application/json",
        },
        params,
        timeout: 30000,
        httpsAgent,
        validateStatus: () => true,
      });

      // ✅ sucesso
      if (res.status >= 200 && res.status < 300) {
        return res.data || {};
      }

      console.error("[safeGet error]", {
        url,
        status: res.status,
      });

      // ❌ NÃO RETRY
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Auth error ${res.status}`);
      }

      // 🔥 RATE LIMIT
      if (res.status === 429) {
        await wait(5000 * attempt);
        continue;
      }

      // 🔁 5xx retry
      if (res.status >= 500 && attempt <= MAX_RETRIES) {
        await wait(2000 * attempt);
        continue;
      }

      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt > MAX_RETRIES) {
        throw err;
      }

      await wait(2000 * attempt);
    }
  }

  throw new Error(`Failed: ${url}`);
}

// =================== CACHE ===================
let IN_MEMORY = {
  rows: [],
  lastSync: null,
  status: "never",
};

let isSyncing = false;

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(IN_MEMORY, null, 2));
}

function loadCache() {
  try {
    IN_MEMORY = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {}
}

// =================== FETCH ===================
async function fetchUsersMap() {
  const data = await safeGet("/api/v4/users", { limit: 250 });
  return new Map((data?._embedded?.users ?? []).map((u) => [u.id, u.name]));
}

async function fetchPipelineStatusMaps() {
  const data = await safeGet("/api/v4/leads/pipelines");

  const pipelines = data?._embedded?.pipelines ?? [];

  const pipelineNameById = new Map();
  const statusInfoById = new Map();

  for (const p of pipelines) {
    pipelineNameById.set(p.id, p.name);

    for (const s of p.statuses ?? []) {
      statusInfoById.set(s.id, {
        status_name: s.name,
      });
    }
  }

  return { pipelineNameById, statusInfoById };
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
    });

    const rows = data?._embedded?.leads ?? [];

    if (!rows.length) break;

    all.push(...rows);

    if (rows.length < LIMIT_PER_PAGE) break;

    page++;
  }

  return all;
}

// =================== BUILD ===================
async function buildAndCache() {
  if (isSyncing) return;
  isSyncing = true;

  try {
    console.log("🔄 Sync started");

    const maps = await fetchPipelineStatusMaps();
    const usersMap = await fetchUsersMap();
    const leads = await fetchLeadsSince();

    IN_MEMORY.rows = leads.map((l) => ({
      id: l.id,
      name: l.name,
      status_id: l.status_id,
      pipeline_id: l.pipeline_id,
      responsible_user_name: usersMap.get(l.responsible_user_id) || null,
    }));

    IN_MEMORY.lastSync = new Date().toISOString();
    IN_MEMORY.status = "ok";

    saveCache();

    console.log("✅ Sync finished");
  } catch (err) {
    console.error("❌ Sync error:", err.message);

    IN_MEMORY.status = "error";
    IN_MEMORY.error = err.message;

    saveCache();
  }

  isSyncing = false;
}

// =================== ROUTES ===================

// 🔥 BI sempre lê cache (NUNCA chama API direto)
router.get("/", async (req, res) => {
  loadCache();
  res.json(IN_MEMORY);
});

// 🔧 rota manual de sync
router.get("/sync", async (req, res) => {
  await buildAndCache();
  res.json({ ok: true });
});

// 🧪 teste auth
router.get("/test-kommo", async (req, res) => {
  try {
    const data = await safeGet("/api/v4/account");
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// =================== AUTO SYNC ===================
setInterval(buildAndCache, UPDATE_INTERVAL_MINUTES * 60000);

export default router;
