import { Router } from "express";
import axios from "axios";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import https from "https";
import axiosRetry from "axios-retry";
import fs from "fs";

dayjs.extend(utc);

const router = Router();

// =================== CONFIG ===================
const DOMAIN = "https://suporteexodosaudecom.kommo.com";
const TOKEN = "Bearer SEU_TOKEN_AQUI";

const START_DATE_DEFAULT = "2025-11-01";
const LIMIT_PER_PAGE = 250;
const THROTTLE_MS = 300;
const UPDATE_INTERVAL_MINUTES = 30;
const CACHE_FILE = "./cache_leads.json";

// =================== HTTP ===================
axiosRetry(axios, { retries: 5, retryDelay: axiosRetry.exponentialDelay });
const httpAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeGet(url, params = {}) {
  for (let attempt = 1; attempt <= 8; attempt++) {
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
      await wait(1500);
    }
  }
  return {};
}

// =================== USERS ===================
async function fetchUsersMap() {
  const data = await safeGet(`${DOMAIN}/api/v4/users`, { limit: 500 });
  return new Map(
    (data?._embedded?.users ?? []).map((u) => [Number(u.id), u.name])
  );
}

// =================== STATUS ===================
async function fetchStatusMap() {
  const data = await safeGet(`${DOMAIN}/api/v4/leads/pipelines`);
  const map = new Map();

  for (const pipeline of data?._embedded?.pipelines ?? []) {
    for (const status of pipeline.statuses ?? []) {
      map.set(Number(status.id), status.name);
    }
  }

  return map;
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
      filter: {
        created_at: {
          from: startUnix,
          to: endUnix,
        },
      },
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
function flattenLead(lead, usersMap, statusMap) {
  const responsibleId = Number(
    lead.responsible_user_id ?? lead.created_by ?? null
  );

  return {
    id: lead.id,
    name: lead.name,
    price: lead.price || 0,

    pipeline_id: lead.pipeline_id,
    status_id: lead.status_id,
    status_name: statusMap.get(Number(lead.status_id)) || null,

    responsible_user_id: responsibleId,
    responsible_user_name: responsibleId
      ? usersMap.get(responsibleId) || null
      : null,

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
let CACHE = { rows: [] };

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(CACHE.rows, null, 2));
}

function loadCache() {
  try {
    CACHE.rows = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    CACHE.rows = [];
  }
}

// =================== BUILD ===================
async function buildAndCache() {
  const [leads, usersMap, statusMap] = await Promise.all([
    fetchLeadsSince(),
    fetchUsersMap(),
    fetchStatusMap(),
  ]);

  CACHE.rows = leads.map((l) =>
    flattenLead(l, usersMap, statusMap)
  );

  saveCache();
}

// =================== ROUTE ===================
router.get("/", async (req, res) => {
  if (!CACHE.rows.length) {
    loadCache();
    if (!CACHE.rows.length) await buildAndCache();
  }
  res.json(CACHE.rows);
});

// =================== AUTO UPDATE ===================
loadCache();
if (!CACHE.rows.length) {
  buildAndCache();
}
setInterval(buildAndCache, UPDATE_INTERVAL_MINUTES * 60000);

export default router;
