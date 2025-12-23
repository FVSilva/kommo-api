import { Router } from "express";
import axios from "axios";
import cors from "cors";
import compression from "compression";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import https from "https";
import axiosRetry from "axios-retry";
import fs from "fs";

dayjs.extend(utc);

const router = Router();

// =================== CONFIG ===================
const DOMAIN = "https://suporteexodosaudecom.kommo.com";
const TOKEN = "Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6IjE0NGQ3YjY3Nzg0ODVjZmIwMmMxMDRmNzkwOTg4YmIxYmVlMDNmNjkzNzIyNGJlMGFiZTI3NGVjMzZiNDhlYjIwODVkYjY3ODA3NWM1MTg5In0.eyJhdWQiOiJlMDhkMWRkNy04MTE0LTQ1MGUtYmRlNS01NTRmNGEzZjU3N2EiLCJqdGkiOiIxNDRkN2I2Nzc4NDg1Y2ZiMDJjMTA0Zjc5MDk4OGJiMWJlZTAzZjY5MzcyMjRiZTBhYmUyNzRlYzM2YjQ4ZWIyMDg1ZGI2NzgwNzVjNTE4OSIsImlhdCI6MTc2MzA3Nzc0NiwibmJmIjoxNzYzMDc3NzQ2LCJleHAiOjE4NTkxNTUyMDAsInN1YiI6IjEwNTY1Mzk1IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjMyMTU1NDM1LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJjcm0iLCJmaWxlcyIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiLCJwdXNoX25vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiODIzYzVkZTQtMjdiMS00MjAzLTk4M2YtNjAyN2Q4OGU0NmRhIiwidXNlcl9mbGFncyI6MCwiYXBpX2RvbWFpbiI6ImFwaS1nLmtvbW1vLmNvbSJ9.mVylUY-n2xSzn5vt8ldTMPY03K0IQBvRUsmgvXdSZasLJFZo8lbkaKbEzpKUSrYoDztZ8tzTD4vxILOUzb05S0teG0RYnOIzwb7Y_kpVzn_oV8-BeGpRDWPnHzBkY0MLTKGZMD-ll5PnhtLrj3TF-6umDGkzq_uJvPUauEIOu3rET-AGrWVz0UsURvlvaQ5h53v0Hc2-Daoya4iz6_JXNnNQyMEHA0sz3wJLg9v1ofF--IRNyo5WeY2R41ppQ1AfniRlvq5Iwkj1W10LJZOUJpHsU8B16PpU1VQJV1gI7WwPIaqOZaqpny8xnL6OVRbF0aGfJS0gOnflR6eCRLR25w";

const START_DATE_DEFAULT = "2025-11-01";
const LIMIT_PER_PAGE = 250;
const CONTACTS_CHUNK = 40;
const THROTTLE_MS = 300;
const UPDATE_INTERVAL_MINUTES = 30;
const CACHE_FILE = "./cache.json";

// =================== HTTP INFRA ===================
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
    } catch {
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
      filter: { created_at: { from: startUnix, to: endUnix } },
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

// =================== FLATTEN ===================
function flattenLead(lead, usersMap) {
  const responsibleId =
    lead.responsible_user_id ||
    lead.created_by ||
    null;

  return {
    id: lead.id,
    name: lead.name,
    price: lead.price || 0,

    pipeline_id: lead.pipeline_id,
    status_id: lead.status_id,

    responsible_user_id: responsibleId,
    responsible_user_name: responsibleId
      ? usersMap.get(responsibleId) || "Usuário não encontrado"
      : "Sem responsável",

    created_at: lead.created_at
      ? dayjs.unix(lead.created_at).utc().format("YYYY-MM-DD HH:mm:ss")
      : null,

    updated_at: lead.updated_at
      ? dayjs.unix(lead.updated_at).utc().format("YYYY-MM-DD HH:mm:ss")
      : null,

    closed_at: lead.closed_at
      ? dayjs.unix(lead.closed_at).utc().format("YYYY-MM-DD HH:mm:ss")
      : null,
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
  } catch {}
}

// =================== BUILD ===================
async function buildAndCache() {
  const [leads, usersMap] = await Promise.all([
    fetchLeadsSince(),
    fetchUsersMap(),
  ]);

  IN_MEMORY.rows = leads.map((l) =>
    flattenLead(l, usersMap)
  );

  saveCache();
}

// =================== ROUTE ===================
router.get("/", async (req, res) => {
  if (!IN_MEMORY.rows.length) {
    loadCache();
    if (!IN_MEMORY.rows.length) await buildAndCache();
  }
  res.json(IN_MEMORY.rows);
});

export default router;
