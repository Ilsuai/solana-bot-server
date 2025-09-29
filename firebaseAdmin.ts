// server/firebaseAdmin.ts
import admin from "firebase-admin";
import fs from "fs";
import path from "path";

/**
 * Structured logger for this module
 */
const L = {
  info: (msg: string, meta?: any) =>
    console.log(`🟦 [firebaseAdmin] ${msg}`, meta ?? ""),
  warn: (msg: string, meta?: any) =>
    console.warn(`🟨 [firebaseAdmin] ${msg}`, meta ?? ""),
  error: (msg: string, meta?: any) =>
    console.error(`🟥 [firebaseAdmin] ${msg}`, meta ?? ""),
};

let _initialized = false;

/**
 * Initialize Firebase Admin exactly once.
 * Priority:
 *  1) FIREBASE_SERVICE_ACCOUNT_JSON (full JSON string)
 *  2) GOOGLE_APPLICATION_CREDENTIALS (path; uses applicationDefault)
 *  3) ./service-account-key.json (local file next to compiled JS)
 */
function initAdmin(): void {
  if (_initialized || admin.apps.length) {
    _initialized = true;
    return;
  }

  try {
    // 1) Full JSON in env
    const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (jsonEnv) {
      const creds = JSON.parse(jsonEnv);
      admin.initializeApp({ credential: admin.credential.cert(creds) });
      _initialized = true;
      L.info("Initialized with FIREBASE_SERVICE_ACCOUNT_JSON");
      return;
    }

    // 2) GOOGLE_APPLICATION_CREDENTIALS (path) -> Application Default
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
      _initialized = true;
      L.info(
        "Initialized with GOOGLE_APPLICATION_CREDENTIALS (applicationDefault)"
      );
      return;
    }

    // 3) Local fallback file (works for dev)
    // Try __dirname first (compiled JS), then project root /server
    const candidates = [
      path.join(__dirname, "service-account-key.json"),
      path.join(process.cwd(), "server", "service-account-key.json"),
    ];
    const keyPath = candidates.find((p) => fs.existsSync(p));
    if (!keyPath) {
      throw new Error(
        "Missing service account credentials. Provide FIREBASE_SERVICE_ACCOUNT_JSON, set GOOGLE_APPLICATION_CREDENTIALS, or add server/service-account-key.json"
      );
    }
    const raw = fs.readFileSync(keyPath, "utf8");
    const creds = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(creds) });
    _initialized = true;
    L.info(`Initialized with local key: ${keyPath}`);
  } catch (err: any) {
    _initialized = false;
    L.error("Initialization failed", err?.stack || err);
    throw err;
  }
}

// Initialize on import so other files can use admin.firestore()
initAdmin();

/**
 * Convenience getter with clear error if not initialized
 */
function getDb(): admin.firestore.Firestore {
  if (!_initialized) {
    throw new Error(
      "Firebase Admin is not initialized. Check credentials and initAdmin()."
    );
  }
  return admin.firestore();
}

/* ===========================
   Helper functions you already had
   (now with structured, descriptive logging)
   =========================== */

export async function logTradeToFirestore(tradeData: any) {
  try {
    const ref = await getDb().collection("trades").add(tradeData);
    L.info("Trade logged", { id: ref.id, action: tradeData?.action, txid: tradeData?.txid });
  } catch (error) {
    L.error("Failed to log trade", error);
  }
}

export async function getBotSettings() {
  try {
    const snap = await getDb().collection("settings").doc("bot-settings").get();
    if (!snap.exists) {
      L.warn("No settings document found; defaulting to OFF");
      return null;
    }
    const data = snap.data()!;
    L.info("Fetched bot settings", { botStatus: data?.botStatus, sessionActive: data?.sessionActive });
    return data;
  } catch (error) {
    L.error("Failed to fetch bot settings", error);
    return null;
  }
}

export async function managePosition(positionData: any) {
  try {
    const id = positionData?.txid || positionData?.id || undefined;
    if (!id) throw new Error("Position requires txid or id");
    const ref = getDb().collection("positions").doc(String(id));
    await ref.set(positionData, { merge: true });
    L.info("Position upserted", { id, status: positionData?.status });
  } catch (error) {
    L.error("Failed to manage position", error);
  }
}

export async function getOpenPositionByToken(tokenAddress: string) {
  try {
    const q = getDb()
      .collection("positions")
      .where("tokenAddress", "==", tokenAddress)
      .where("status", "==", "open")
      .limit(1);

    const snap = await q.get();
    if (snap.empty) {
      L.info("No open position for token", { tokenAddress });
      return null;
    }
    const doc = snap.docs[0];
    const pos = { id: doc.id, ...doc.data() };
    L.info("Open position found", { tokenAddress, id: doc.id });
    return pos;
  } catch (error) {
    L.error(`Failed to fetch open position for ${tokenAddress}`, error);
    return null;
  }
}

export async function closePosition(
  docId: string,
  sellPrice: number,
  reason: string | null
) {
  try {
    await getDb().collection("positions").doc(docId).update({
      status: "closed",
      sellPrice,
      closedAt: admin.firestore.FieldValue.serverTimestamp(),
      deactivationReason: reason || "Unknown",
    });
    L.info("Position closed", { id: docId, sellPrice, reason });
  } catch (error) {
    L.error(`Failed to close position ${docId}`, error);
  }
}

/**
 * Used by the /bot/stop-and-archive route.
 * Closes all open positions and flips settings to OFF.
 */
export async function stopAndArchiveCurrentSession() {
  const db = getDb();
  const now = admin.firestore.FieldValue.serverTimestamp();

  try {
    const settingsRef = db.collection("settings").doc("bot-settings");
    const openSnap = await db.collection("positions").where("status", "==", "open").get();

    const batch = db.batch();

    openSnap.forEach((d) =>
      batch.update(d.ref, {
        status: "closed",
        closedAt: now,
        deactivationReason: "Stopped",
      })
    );

    batch.set(
      settingsRef,
      { botStatus: "OFF", sessionActive: false, currentSessionId: null },
      { merge: true }
    );

    await batch.commit();
    L.info("Stop & archive completed", { closedPositions: openSnap.size });
  } catch (error) {
    L.error("Stop & archive failed", error);
    throw error;
  }
}

// Export admin for advanced usages; index.ts only needs to import this file for side-effect init.
export default admin;
