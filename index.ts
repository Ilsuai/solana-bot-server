// index.ts — FULL FILE
import express from 'express';
import cors from 'cors';
import { Connection } from '@solana/web3.js';
import { executeTradeFromSignal, TradeSignal } from './tradeExecutor';
import './firebaseAdmin'; // ensure Firebase Admin initializes & logs

const app = express();

// CORS + JSON
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Config
const PORT = Number(process.env.PORT || 3001);
const RPC = process.env.SOLANA_RPC_ENDPOINT || '';
const SHARED = process.env.NEXAGENT_SHARED_SECRET || '';

console.log('==================================================');
console.log('  Solana Trading Bot - Starting Up');
console.log('==================================================');
console.log('✅ Server is running and listening on port', PORT);

// Warmup ping to Helius sender (optional) is inside tradeExecutor logs.
// Quick RPC connectivity check:
(async () => {
  try {
    const conn = new Connection(RPC, 'processed');
    await conn.getLatestBlockhash('processed');
    const host = new URL(RPC).host;
    console.log('✅ CONNECTED TO RPC ENDPOINT:', host);
  } catch (e: any) {
    console.warn('⚠️  RPC connectivity check failed:', e?.message || e);
  }
})();

if (SHARED) {
  console.log('✅ Webhook shared secret configured.');
} else {
  console.warn('⚠️ NEXAGENT_SHARED_SECRET is empty — webhook auth is effectively disabled.');
}
console.log('--------------------------------------------------');
console.log('✅ Firebase Admin SDK ready via firebaseAdmin.ts');

// Simple idempotency guard (in-memory)
const seenIds = new Map<string, number>();
const MAX_IDS = 2000;

function remember(id: string): boolean {
  if (seenIds.has(id)) return false;
  seenIds.set(id, Date.now());
  if (seenIds.size > MAX_IDS) {
    // drop oldest ~25%
    const entries = Array.from(seenIds.entries()).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < Math.floor(MAX_IDS * 0.25); i++) {
      seenIds.delete(entries[i][0]);
    }
  }
  return true;
}

// Health endpoint
app.get('/healthz', async (_req, res) => {
  try {
    const conn = new Connection(RPC, 'processed');
    await conn.getLatestBlockhash('processed');
    res.json({ ok: true, rpc: 'ok' });
  } catch {
    res.status(500).json({ ok: false, rpc: 'fail' });
  }
});

// Root
app.get('/', (_req, res) => {
  res.send('Solana bot server is up. Use /nexagent-signal to send signals.');
});

// Webhook receiver
app.post('/nexagent-signal', async (req, res) => {
  const auth = req.header('x-nexagent-secret') || '';
  if (SHARED && auth !== SHARED) {
    return res.status(401).json({ ok: false, error: 'Invalid shared secret' });
  }

  const payload = req.body || {};
  const payloadData = payload.data || {};

  console.log(`\n================== [SIGNAL ${payloadData.signal_id} RECEIVED] ==================`);
  console.log('Full Payload:', JSON.stringify(payload, null, 2));

  const signal_id = String(payloadData.signal_id || `sig-${Date.now()}`);

  if (!remember(signal_id)) {
    console.log(`[Idempotency] Duplicate signal_id "${signal_id}" ignored.`);
    return res.json({ ok: true, dup: true });
  }

  // Derive action: if input mint is WSOL, treat as BUY; otherwise SELL
  const WSOL = 'So11111111111111111111111111111111111111112';
  const action = payloadData.input_mint === WSOL ? 'BUY' : 'SELL';

  const signal: TradeSignal = {
    action,
    signal_id,
    input_mint: String(payloadData.input_mint),
    output_mint: String(payloadData.output_mint),
    input_amount: Number(payloadData.input_amount || 0),

    // include all symbol fields to help executor pick the best
    symbol: payloadData.symbol,
    input_symbol: payloadData.input_symbol,
    output_symbol: payloadData.output_symbol,
  };

  // Fire and forget (the executor logs to Firestore)
  executeTradeFromSignal(signal).catch((e) =>
    console.error('[Executor] Uncaught error:', e?.message || e)
  );

  res.json({ ok: true, accepted: true });
});

// Start server
app.listen(PORT, () => {
  // No-op: logs already printed above
});
