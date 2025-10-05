// ✅ Load .env first
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
// @ts-ignore
import fetch from 'node-fetch';
import { executeTradeFromSignal, TradeSignal } from './tradeExecutor';

// ✅ Use our pre-initialized Firebase exports
import { db } from './firebaseAdmin';

const PORT = Number(process.env.PORT || 3001);
const RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT || '';
const SHARED_SECRET = process.env.NEXAGENT_SHARED_SECRET || '';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ---------- Small helpers ----------
async function rpcHealth(endpoint: string): Promise<'ok' | 'unhealthy'> {
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
    });
    const j = await r.json();
    return j?.result === 'ok' ? 'ok' : 'unhealthy';
  } catch {
    return 'unhealthy';
  }
}

// Create a Firestore doc ONLY if it does not exist yet (idempotency)
async function tryClaimSignal(signalId: string): Promise<boolean> {
  const ref = db.collection('signals').doc(signalId);
  try {
    await ref.create({
      status: 'received',
      createdAt: new Date(),
    });
    return true; // we are the first
  } catch (e: any) {
    if (String(e?.code) === '6' || /already exists/i.test(String(e?.message))) {
      return false; // someone already created it
    }
    throw e; // unexpected Firestore error
  }
}

async function markSignalStatus(signalId: string, data: Record<string, any>) {
  const ref = db.collection('signals').doc(signalId);
  await ref.set({ ...data, updatedAt: new Date() }, { merge: true });
}

// Normalize Nextgent payload
function extractPayload(body: any): any {
  return body?.data ?? body;
}

// Heuristic to determine action if not provided
function inferAction(p: any): 'BUY' | 'SELL' {
  if (typeof p.action === 'string') {
    const a = p.action.toUpperCase();
    if (a === 'BUY' || a === 'SELL') return a as 'BUY' | 'SELL';
  }
  if (p.input_mint === SOL_MINT) return 'BUY';
  if (p.output_mint === SOL_MINT) return 'SELL';
  return 'BUY';
}

// ---------- Server ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', async (_req, res) => {
  const health = RPC_ENDPOINT ? await rpcHealth(RPC_ENDPOINT) : 'unhealthy';
  res.json({ ok: true, rpc: health });
});

(async () => {
  console.log('==================================================');
  console.log('  Solana Trading Bot - Starting Up');
  console.log('==================================================');

  if (!RPC_ENDPOINT) {
    console.warn('⚠️  SOLANA_RPC_ENDPOINT not set.');
  } else {
    const h = await rpcHealth(RPC_ENDPOINT);
    if (h === 'ok') {
      try {
        const host = new URL(RPC_ENDPOINT).host;
        console.log(`✅ CONNECTED TO RPC ENDPOINT: ${host}`);
      } catch {
        console.log(`✅ RPC health OK`);
      }
    } else {
      console.warn('⚠️  RPC health check failed');
    }
  }

  if (!SHARED_SECRET) {
    console.warn('⚠️  NEXAGENT_SHARED_SECRET not set. Webhook auth is DISABLED!');
  } else {
    console.log('✅ Webhook shared secret configured.');
  }

  console.log('--------------------------------------------------');
  console.log('✅ Firebase Admin SDK ready via firebaseAdmin.ts');
})().catch((e) => console.error('Boot error:', e));

app.post('/nexagent-signal', async (req, res) => {
  const payload = extractPayload(req.body);
  const signal_id = String(payload.signal_id || '').trim();

  console.log(`\n================== [SIGNAL ${signal_id || 'UNKNOWN'} RECEIVED] ==================`);
  console.log('Full Payload:', JSON.stringify({ data: payload }, null, 2));

  // 1) Shared-secret auth
  if (SHARED_SECRET) {
    const headerSecret = String(req.header('x-nexagent-secret') || '');
    if (!headerSecret || headerSecret !== SHARED_SECRET) {
      console.warn('[Auth] Missing or invalid x-nexagent-secret.');
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  // 2) Basic validation
  if (!signal_id) return res.status(400).json({ ok: false, error: 'Missing signal_id' });
  if (!payload.input_mint || !payload.output_mint) {
    return res.status(400).json({ ok: false, error: 'Missing input_mint/output_mint' });
  }
  const input_amount = Number(payload.input_amount ?? 0);
  if (Number.isNaN(input_amount) || input_amount < 0) {
    return res.status(400).json({ ok: false, error: 'Invalid input_amount' });
  }

  // 3) Idempotency
  let claimed = false;
  try {
    claimed = await tryClaimSignal(signal_id);
  } catch (e: any) {
    console.error('[Idempotency] Firestore error:', e?.message || e);
    return res.status(500).json({ ok: false, error: 'Idempotency store error' });
  }
  if (!claimed) {
    console.log(`[Idempotency] Duplicate signal_id "${signal_id}" ignored.`);
    return res.status(200).json({ ok: true, status: 'ignored_duplicate' });
  }

  // 4) Build TradeSignal
  const action = inferAction(payload);
  const tradeSignal: TradeSignal = {
    action,
    signal_id,
    input_mint: String(payload.input_mint),
    output_mint: String(payload.output_mint),
    input_amount: input_amount,
    symbol: payload.symbol,
    input_symbol: payload.input_symbol,
    output_symbol: payload.output_symbol,
  };

  // 5) Execute
  try {
    await markSignalStatus(signal_id, { status: 'processing', action });
    await executeTradeFromSignal(tradeSignal);
    await markSignalStatus(signal_id, { status: 'done', action });
    return res.status(200).json({ ok: true, status: 'executed' });
  } catch (e: any) {
    console.error('[Execute] Error:', e?.message || e);
    await markSignalStatus(signal_id, { status: 'failed', action, error: e?.message || String(e) });
    return res.status(500).json({ ok: false, error: e?.message || 'Execution failed' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running and listening on port ${PORT}`);
  console.log('[Warmup] Ping successful to global sender. Connection is warm.');
});
