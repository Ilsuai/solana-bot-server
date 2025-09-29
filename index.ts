// server/index.ts
import "dotenv/config";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import "./firebaseAdmin";
import nexagentRouter from "./nexagent-signal";
import { randomUUID } from "crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// tiny request log
app.use((req, _res, next) => {
  console.log(`➡️  ${req.method} ${req.path}`);
  next();
});

const L = {
  info: (scope: string, msg: string, meta?: any) =>
    console.log(`🟦 [${scope}] ${msg}`, meta ?? ""),
  warn: (scope: string, msg: string, meta?: any) =>
    console.warn(`🟨 [${scope}] ${msg}`, meta ?? ""),
  error: (scope: string, msg: string, meta?: any) =>
    console.error(`🟥 [${scope}] ${msg}`, meta ?? ""),
};

const db = () => admin.firestore();

// Health
app.get("/healthz", async (_req, res) => {
  try {
    await db().collection("settings").doc("bot-settings").get();
    L.info("healthz", "OK");
    res.status(200).json({ ok: true });
  } catch (e: any) {
    L.error("healthz", "ERROR", e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ START BOT (server authoritative; creates session + logs)
app.post("/bot/start", async (req, res) => {
  const scope = "bot-start";
  try {
    // accept either "startingBalance" or "sessionStartingBalance" from client
    const raw =
      req.body?.startingBalance ?? req.body?.sessionStartingBalance ?? 0;
    const starting = Number(raw);
    if (!Number.isFinite(starting) || starting <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: "startingBalance must be > 0" });
    }

    const sessionId = randomUUID();
    const now = admin.firestore.FieldValue.serverTimestamp();

    // Match the exact field names your dashboard expects
    await db().collection("settings").doc("bot-settings").set(
      {
        botStatus: "RUNNING",
        sessionActive: true,
        currentSessionId: sessionId,
        sessionStartingBalance: starting,
        sessionStartTime: now,
      },
      { merge: true }
    );

    L.info(scope, "Bot started", { sessionId, startingBalance: starting });
    res.status(200).json({ ok: true, sessionId, startingBalance: starting });
  } catch (e: any) {
    L.error("bot-start", "Failed", e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// 🛑 STOP & ARCHIVE (closes opens and turns bot OFF)
app.post("/bot/stop-and-archive", async (_req, res) => {
  const scope = "stop-and-archive";
  try {
    const now = admin.firestore.FieldValue.serverTimestamp();

    const openSnap = await db()
      .collection("positions")
      .where("status", "==", "open")
      .get();

    const batch = db().batch();
    openSnap.forEach((d) =>
      batch.update(d.ref, {
        status: "closed",
        closedAt: now,
        deactivationReason: "Stopped",
      })
    );

    batch.set(
      db().collection("settings").doc("bot-settings"),
      { botStatus: "OFF", sessionActive: false, currentSessionId: null },
      { merge: true }
    );

    await batch.commit();
    L.info(scope, "Bot stopped; positions closed", { closed: openSnap.size });
    res.status(200).json({ ok: true, closed: openSnap.size });
  } catch (e: any) {
    L.error(scope, "Failed", e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Nexgent webhook (POST /nexagent-signal)
app.use("/", nexagentRouter);

app.listen(PORT, () => {
  console.log(`🚀 server listening on port ${PORT}`);
});
