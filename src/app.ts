import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "ecotask-backend" });
});

app.listen(PORT, () => {
  console.log(`EcoTask backend running on http://localhost:${PORT}`);
});

export default app;
