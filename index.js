import express from "express";
import cors from "cors";
import compression from "compression";

import leadsRoutes from "./routes/leads.js";
import fechadosRoutes from "./routes/fechados.js";

const app = express();

app.use(cors());
app.use(compression());
app.use(express.json());

// rotas
app.use("/leads", leadsRoutes);
app.use("/fechados", fechadosRoutes);

// health check (importante pro Render)
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ API rodando na porta ${PORT}`);
});
