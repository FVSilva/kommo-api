import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = express.Router();

// =================== CONFIG ===================
const TOKEN = `Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6IjE0NGQ3YjY3Nzg0ODVjZmIwMmMxMDRmNzkwOTg4YmIxYmVlMDNmNjkzNzIyNGJlMGFiZTI3NGVjMzZiNDhlYjIwODVkYjY3ODA3NWM1MTg5In0.eyJhdWQiOiJlMDhkMWRkNy04MTE0LTQ1MGUtYmRlNS01NTRmNGEzZjU3N2EiLCJqdGkiOiIxNDRkN2I2Nzc4NDg1Y2ZiMDJjMTA0Zjc5MDk4OGJiMWJlZTAzZjY5MzcyMjRiZTBhYmUyNzRlYzM2YjQ4ZWIyMDg1ZGI2NzgwNzVjNTE4OSIsImlhdCI6MTc2MzA3Nzc0NiwibmJmIjoxNzYzMDc3NzQ2LCJleHAiOjE4NTkxNTUyMDAsInN1YiI6IjEwNTY1Mzk1IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjMyMTU1NDM1LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJjcm0iLCJmaWxlcyIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiLCJwdXNoX25vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiODIzYzVkZTQtMjdiMS00MjAzLTk4M2YtNjAyN2Q4OGU0NmRhIiwidXNlcl9mbGFncyI6MCwiYXBpX2RvbWFpbiI6ImFwaS1nLmtvbW1vLmNvbSJ9.mVylUY-n2xSzn5vt8ldTMPY03K0IQBvRUsmgvXdSZasLJFZo8lbkaKbEzpKUSrYoDztZ8tzTD4vxILOUzb05S0teG0RYnOIzwb7Y_kpVzn_oV8-BeGpRDWPnHzBkY0MLTKGZMD-ll5PnhtLrj3TF-6umDGkzq_uJvPUauEIOu3rET-AGrWVz0UsURvlvaQ5h53v0Hc2-Daoya4iz6_JXNnNQyMEHA0sz3wJLg9v1ofF--IRNyo5WeY2R41ppQ1AfniRlvq5Iwkj1W10LJZOUJpHsU8B16PpU1VQJV1gI7WwPIaqOZaqpny8xnL6OVRbF0aGfJS0gOnflR6eCRLR25w`;
const SUBDOMAIN = "https://suporteexodosaudecom.kommo.com"; // ex: v4company
const BASE_URL = `https://${SUBDOMAIN}.kommo.com/api/v4/leads`;

const PAGE_LIMIT = 250;
const MAX_PAGES = 30; // 🔥 PROTEÇÃO (30 x 250 = 7500 registros máx)
const CACHE_FILE = "fechados-cache.json";

// =================== PATH ===================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cachePath = path.join(__dirname, CACHE_FILE);

// =================== MEMÓRIA ===================
let IN_MEMORY = {
  rows: [],
  lastBuild: null
};

let isBuilding = false;

// =================== LOAD CACHE ===================
function loadCache() {
  try {
    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath, "utf8");
      IN_MEMORY = JSON.parse(data);
      console.log("✅ Cache carregado do disco");
    }
  } catch (err) {
    console.log("Erro ao carregar cache:", err.message);
  }
}

// =================== SAVE CACHE ===================
function saveCache() {
  try {
    fs.writeFileSync(cachePath, JSON.stringify(IN_MEMORY));
  } catch (err) {
    console.log("Erro ao salvar cache:", err.message);
  }
}

// =================== FETCH KOMMO ===================
async function fetchPage(page) {
  const response = await axios.get(BASE_URL, {
    headers: {
      Authorization: `Bearer ${TOKEN}`
    },
    params: {
      limit: PAGE_LIMIT,
      page,
      filter: {
        statuses: [142] // ID DO STATUS FECHADO
      }
    },
    timeout: 60000
  });

  return response.data._embedded?.leads || [];
}

// =================== BUILD ===================
async function buildAndCache() {
  console.log("🚀 Iniciando build...");

  let page = 1;
  let total = 0;
  let allRows = [];

  while (page <= MAX_PAGES) {
    const leads = await fetchPage(page);

    if (!leads.length) break;

    allRows.push(...leads);
    total += leads.length;

    console.log(`Página ${page} processada. Total acumulado: ${total}`);

    if (leads.length < PAGE_LIMIT) break;

    page++;
  }

  IN_MEMORY = {
    rows: allRows,
    lastBuild: new Date().toISOString()
  };

  saveCache();

  console.log(`✅ Build finalizado com ${total} registros`);
}

// =================== SAFE BUILD ===================
async function buildAndCacheSafe() {
  if (isBuilding) {
    console.log("⚠️ Build já em execução, ignorando...");
    return;
  }

  try {
    isBuilding = true;
    await buildAndCache();
  } catch (err) {
    console.log("Erro no build:", err.message);
  } finally {
    isBuilding = false;
  }
}

// =================== ROUTE ===================
router.get("/", async (req, res) => {
  loadCache();

  // Se já existe cache, responde rápido
  if (IN_MEMORY.rows.length) {
    res.json(IN_MEMORY.rows);

    // Atualiza em background
    buildAndCacheSafe();
    return;
  }

  // Primeira execução
  await buildAndCacheSafe();

  res.json(IN_MEMORY.rows);
});

export default router;
