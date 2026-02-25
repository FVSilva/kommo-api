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
const TOKEN = "Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6IjE0NGQ3YjY3Nzg0ODVjZmIwMmMxMDRmNzkwOTg4YmIxYmVlMDNmNjkzNzIyNGJlMGFiZTI3NGVjMzZiNDhlYjIwODVkYjY3ODA3NWM1MTg5In0.eyJhdWQiOiJlMDhkMWRkNy04MTE0LTQ1MGUtYmRlNS01NTRmNGEzZjU3N2EiLCJqdGkiOiIxNDRkN2I2Nzc4NDg1Y2ZiMDJjMTA0Zjc5MDk4OGJiMWJlZTAzZjY5MzcyMjRiZTBhYmUyNzRlYzM2YjQ4ZWIyMDg1ZGI2NzgwNzVjNTE4OSIsImlhdCI6MTc2MzA3Nzc0NiwibmJmIjoxNzYzMDc3NzQ2LCJleHAiOjE4NTkxNTUyMDAsInN1YiI6IjEwNTY1Mzk1IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjMyMTU1NDM1LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJjcm0iLCJmaWxlcyIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiLCJwdXNoX25vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiODIzYzVkZTQtMjdiMS00MjAzLTk4M2YtNjAyN2Q4OGU0NmRhIiwidXNlcl9mbGFncyI6MCwiYXBpX2RvbWFpbiI6ImFwaS1nLmtvbW1vLmNvbSJ9.mVylUY-n2xSzn5vt8ldTMPY03K0IQBvRUsmgvXdSZasLJFZo8lbkaKbEzpKUSrYoDztZ8tzTD4vxILOUzb05S0teG0RYnOIzwb7Y_kpVzn_oV8-BeGpRDWPnHzBkY0MLTKGZMD-ll5PnhtLrj3TF-6umDGkzq_uJvPUauEIOu3rET-AGrWVz0UsURvlvaQ5h53v0Hc2-Daoya4iz6_JXNnNQyMEHA0sz3wJLg9v1ofF--IRNyo5WeY2R41ppQ1AfniRlvq5Iwkj1W10LJZOUJpHsU8B16PpU1VQJV1gI7WwPIaqOZaqpny8xnL6OVRbF0aGfJS0gOnflR6eCRLR25w";

const START_DATE_DEFAULT = "2025-11-01";
const LIMIT_PER_PAGE = 250;
const CONTACTS_CHUNK = 40;
const THROTTLE_MS = 200;
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

let IN_MEMORY = { rows: [], last_update: null };
let BUILDING = false;

// =================== SAFE GET ===================
async function safeGet(url, params = {}) {
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
    console.error("❌ HTTP:", err.response?.status, err.message);
    return {};
  }
}

// =================== USERS ===================
async function fetchUsersMap() {
  const data = await safeGet(`${DOMAIN}/api/v4/users`, { limit: 500 });
  const users = data?._embedded?.users ?? [];
  return new Map(users.map((u) => [u.id, u.name]));
}

// =================== LEADS ===================
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

// =================== CACHE ===================
function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(IN_MEMORY.rows));
  fs.writeFileSync(META_FILE, JSON.stringify({ last_update: IN_MEMORY.last_update }));
}

function loadCache() {
  try {
    IN_MEMORY.rows = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    const meta = JSON.parse(fs.readFileSync(META_FILE, "utf8"));
    IN_MEMORY.last_update = meta.last_update;
  } catch {
    IN_MEMORY.rows = [];
  }
}

// =================== BUILD ===================
async function buildAndCache() {
  if (BUILDING) return;
  BUILDING = true;

  try {
    const leads = await fetchLeadsFechados();
    const usersMap = await fetchUsersMap();

    IN_MEMORY.rows = leads.map((l) => ({
      id: l.id,
      name: l.name,
      price: l.price || 0,
      status_id: l.status_id,
      responsible_user_name:
        usersMap.get(l.responsible_user_id) || "Sem responsável",
      created_at: l.created_at
        ? dayjs.unix(l.created_at).format("YYYY-MM-DD HH:mm:ss")
        : null,
      closed_at: l.closed_at
        ? dayjs.unix(l.closed_at).format("YYYY-MM-DD HH:mm:ss")
        : null,
    }));

    IN_MEMORY.last_update = dayjs().format("YYYY-MM-DD HH:mm:ss");
    saveCache();
    console.log("✅ Cache atualizado");
  } catch (err) {
    console.error("❌ Erro build:", err.message);
  }

  BUILDING = false;
}

// =================== INIT ===================
loadCache();
if (!IN_MEMORY.rows.length) {
  buildAndCache();
}

// =================== ROUTE ===================
router.get("/", async (req, res) => {
  if (IN_MEMORY.rows.length) {
    return res.json({
      last_update: IN_MEMORY.last_update,
      total: IN_MEMORY.rows.length,
      data: IN_MEMORY.rows,
    });
  }

  return res.status(202).json({
    message: "Cache ainda sendo gerado...",
  });
});

export default router;
