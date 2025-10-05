// firebaseAdmin.ts — FULL FILE
import admin, { ServiceAccount } from 'firebase-admin';
import fs from 'fs';
import path from 'path';

// ---- Service account loader (env first, then file) ----
function loadServiceAccount(): ServiceAccount {
  const fromEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (fromEnv) {
    try {
      return JSON.parse(fromEnv) as ServiceAccount;
    } catch (e: any) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${e?.message || e}`);
    }
  }

  // fall back to a local file; try several reasonable locations
  const candidates = [
    path.resolve(process.cwd(), 'service-account-key.json'),
    path.resolve(__dirname, '../service-account-key.json'),
    path.resolve(__dirname, 'service-account-key.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      return JSON.parse(raw) as ServiceAccount;
    }
  }

  throw new Error(
    'Firebase service account not found. Set FIREBASE_SERVICE_ACCOUNT_JSON in .env OR add service-account-key.json to the project root.'
  );
}

// ---- Initialize Admin exactly once ----
function initFirebase() {
  if (admin.apps.length) return;
  const sa = loadServiceAccount();
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  console.log('✅ Firebase Admin SDK initialized.');
}
initFirebase();

// ---- Export Firestore db ----
export const db = admin.firestore();

// ------------- Helpers your app expects -------------
type TradeLog = {
  txid: string | null;
  signal_id: string;
  action: 'BUY' | 'SELL';
  symbol?: string;
  solAmount: number | null;
  error?: string;
  timestamp: Date;
  durationMs: number;
  status: 'Success' | 'Failed';
};

export async function logTradeToFirestore(log: TradeLog) {
  try {
    await db.collection('trades').add(log);
  } catch (e: any) {
    console.error('[Firestore] logTradeToFirestore error:', e?.message || e);
  }
}

// Return RUNNING (default) or PAUSED based on Firestore doc: config/bot {status:"RUNNING"|"PAUSED"}
export async function getBotStatus(): Promise<'RUNNING' | 'PAUSED'> {
  try {
    const snap = await db.collection('config').doc('bot').get();
    const status = String(snap.data()?.status ?? 'RUNNING').toUpperCase();
    return status === 'PAUSED' ? 'PAUSED' : 'RUNNING';
  } catch (e: any) {
    console.warn('[Firestore] getBotStatus failed, defaulting to RUNNING:', e?.message || e);
    return 'RUNNING';
  }
}

export type PositionOpenInput = {
  signal_id: string;
  status: 'open';
  openedAt: Date;
  tokenAddress: string;
  tokenSymbol?: string;
  solAmount: number;        // SOL spent
  tokenReceived: number;    // token qty received
  txid: string;             // entry tx
};

export type PositionCloseInput = {
  signal_id: string;
  status: 'closed';
  closedAt: Date;
  solReceived: number;      // SOL received
  exitTx: string;           // exit tx
};

// Store position by signal_id. If it exists, we merge updates.
export async function managePosition(input: PositionOpenInput | PositionCloseInput) {
  try {
    const ref = db.collection('positions').doc(input.signal_id);
    await ref.set(input as any, { merge: true });
  } catch (e: any) {
    console.error('[Firestore] managePosition error:', e?.message || e);
  }
}
