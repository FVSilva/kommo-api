import express from "express";
import axios from "axios";
import dayjs from "dayjs";

const app = express();

// ================= CONFIG =================
const DOMAIN = "https://suporteexodosaudecom.kommo.com";
const TOKEN = "Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6IjI1YmM5ODE5MWUwYWZjN2UzMmUzOGFmMjkxM2NhMWU2ZGVjYWQ4Y2Q4YjJjNTY1ZWVlNzkyMDFlZDMyNjJhMGE5YzMxMTY1OTc4MjllNzAxIn0.eyJhdWQiOiIyYjE3NzQ0MS1iNTNkLTQ0OWYtYWU3MS1iMWY5NTE3YjMzMWIiLCJqdGkiOiIyNWJjOTgxOTFlMGFmYzdlMzJlMzhhZjI5MTNjYTFlNmRlY2FkOGNkOGIyYzU2NWVlZTc5MjAxZWQzMjYyYTBhOWMzMTE2NTk3ODI5ZTcwMSIsImlhdCI6MTc3NTU5MjYzMCwibmJmIjoxNzc1NTkyNjMwLCJleHAiOjE4OTM0NTYwMDAsInN1YiI6IjEwNTY1Mzk1IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjMyMTU1NDM1LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJwdXNoX25vdGlmaWNhdGlvbnMiLCJmaWxlcyIsImNybSIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiZjJlNjI5ZWYtMDViNS00YjJiLWI1MzItYjhiMjQyZTdmY2Y5IiwiYXBpX2RvbWFpbiI6ImFwaS1nLmtvbW1vLmNvbSJ9.m3XOIBgmnd4zdefRNgC5l_kFbSjOZku5w8c63PJtxlbG6KLAHQvapW3OMmGY55T0G74ykLs_jzd-X2XN1z8X_m48n48fPMRWTKUGKr6L-cAxt2e0qGci38q3oYx67Q0aRlwWjv60-Prz3qrX7ahQJsqBRHaZ1dPqVB3UbB7eSkfvsB52epTqIDTT6Ju2rniI9vbHBSdMv-VciqmEKVRJN3fmsjb0wAcfuAB2YpvBNar9PPxR37B9zZgheuzaqUDwzXE6kG_EVratexy-1f3fGj2SvJOkAncZonDNgTrRj3Nb_gbS4YqXvn3cAHs4SxF7aPu80H_FWzgTg7x7-iqklw"; // 🔥 usa o que funcionava

const PORT = process.env.PORT || 3000;

// ================= REQUEST =================
async function getLeads() {
  const startUnix = dayjs().subtract(12, "month").unix();
  const endUnix = dayjs().unix();

  let page = 1;
  let all = [];

  while (true) {
    const res = await axios.get(`${DOMAIN}/api/v4/leads`, {
      headers: {
        Authorization: TOKEN,
      },
      params: {
        limit: 250,
        page,
        with: "contacts",

        // 👇 formato que FUNCIONA no Kommo
        "filter[created_at][from]": startUnix,
        "filter[created_at][to]": endUnix,
      },
    });

    const leads = res.data?._embedded?.leads || [];

    console.log(`Página ${page}: ${leads.length}`);

    if (!leads.length) break;

    all.push(...leads);

    if (leads.length < 250) break;
    page++;
  }

  console.log("TOTAL:", all.length);

  return all;
}

// ================= ROUTE =================
app.get("/leads", async (req, res) => {
  try {
    const leads = await getLeads();

    res.json({
      total: leads.length,
      leads,
    });
  } catch (err) {
    console.log("ERRO:", err.response?.status, err.response?.data);

    res.status(500).json({
      error: "Erro ao buscar leads",
      detalhe: err.response?.data || err.message,
    });
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log(`🚀 Rodando na porta ${PORT}`);
});
