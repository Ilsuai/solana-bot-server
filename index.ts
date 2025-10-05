import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
// @ts-ignore - node-fetch types not required
import fetch from 'node-fetch';
import { Connection } from '@solana/web3.js';

// Init firebase on import (your file already logs ready/initialized)
import './firebaseAdmin';

import { executeTradeFromSignal } from './tradeExecutor';

// ------------------------------
// Config / constants
// ------------------------------
const PORT = Number(process.env.PORT || 3001);
const RPC_URL = process.env.SOLANA_RPC_ENDPOINT;
const SHARED_SECRET = process.env.NEXAGENT_SHARED_SECRET || '';

if (!RPC_URL) {
  // Keep this non-fatal so /healthz can still respond, but warn loudly.
  console.warn('⚠️  SOLANA_RPC_ENDPOINT is not set. /healthz and trading may not function.');
}

const HEARTBEAT_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS ?? 60_000); // 60s default
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Keep a connection around for health checks (trade logic uses its own)
const connection = RPC_URL ? new Connection(RPC_URL, 'confirmed') : undefined;

// ------------------------------
// Types
// ------------------------------
type TradeAction = 'BUY' | 'SELL';

export type TradeSignal = {
  action: TradeAction;
  signal_id: string;
  input_mint: string;
  output_mint: string;
  input_amount: number; // for BUY: SOL amount; for SELL: ignored if you auto-sell wallet balance
  symbol?: string;
};

// The incoming webhook payload shape you’re using
type NextgentPayload = {
  data: {
    signal_id: string;
    transaction_type: 'swap';
    input_mint: string;
    output_mint: string;
    input_amount: number;
    input_symbol?: string;
    output_symbol?: string;
  };
};

// ------------------------------
// Small helpers
// ------------------------------

// Strict secret check (optional: if env var empty, we allow all)
function requireSecret(req: Request, res: Response, next: NextFunction) {
  if (!SHARED_SECRET) return next(); // no secret required
  const header = req.header('x-nexagent-secret');
  if (header && header === SHARED_SECRET) return next();
  return res.status(401).json({ ok: false, error: 'Invalid shared secret' });
}

// Idempotency (ignore duplicate signal_id for a short window)
const IDEMP_TTL_MS = 10 * 60_000; // 10 minutes
const seenSignals = new Map<string, number>();

function isDuplicate(signalId: string) {
  const now = Date.now();
  const prev = seenSignals.get(signalId);
  if (prev && now - prev < IDEMP_TTL_MS) return true;
  seenSignals.set(signalId, now);
  // lazy purge
  for (const [k, t] of seenSignals) {
    if (now - t > IDEMP_TTL_MS) seenSignals.delete(k);
  }
  return false;
}

// Decide BUY vs SELL and fill signal object
function buildTradeSignal(p: NextgentPayload['data']): TradeSignal {
  // convention: if paying SOL (input_mint == SOL, input_amount > 0) => BUY
  const isBuy = p.input_mint === SOL_MINT && Number(p.input_amount) > 0;

  const action: TradeAction = isBuy ? 'BUY' : 'SELL';
  const symbol = isBuy ? p.output_symbol : p.input_symbol;

  return {
    action,
    signal_id: p.signal_id,
    input_mint: p.input_mint,
    output_mint: p.output_mint,
    input_amount: Number(p.input_amount) || 0,
    symbol,
  };
}

// Heartbeat (periodic) — prints logs to Render so you can see steady activity
async function rpcHeartbeat(rpcUrl: string) {
  try {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' });
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok && json?.result === 'ok') {
      console.log(`[Heartbeat] RPC health ok @ ${new Date().toISOString()}`);
    } else {
      console.warn(
        `[Heartbeat] RPC health not-ok (${res.status}) @ ${new Date().toISOString()}:`,
        json?.error || json
      );
    }
  } catch (e: any) {
    console.warn(
      `[Heartbeat] RPC health failed @ ${new Date().toISOString()}: ${e?.message || e}`
    );
  }
}

function startHeartbeat(rpcUrl?: string) {
  if (!rpcUrl) return;
  // fire immediately on boot
  rpcHeartbeat(rpcUrl);
  // and repeat
  setInterval(() => rpcHeartbeat(rpcUrl), HEARTBEAT_INTERVAL_MS);
}

// ------------------------------
// App setup
// ------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Health — used by your Render health checks and for manual curl
app.get('/healthz', async (_req: Request, res: Response) => {
  if (!connection || !RPC_URL) {
    return res.status(500).json({ ok: false, rpc: 'missing' });
  }
  try {
    // Quick RPC ping via getHealth
    const r: any = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
    }).then((r: any) => r.json());
    const ok = r?.result === 'ok';
    return res.status(ok ? 200 : 500).json({ ok, rpc: ok ? 'ok' : 'degraded' });
  } catch {
    return res.status(500).json({ ok: false, rpc: 'error' });
  }
});

// Main webhook — Nextgent.ai -> your bot
app.post('/nexagent-signal', requireSecret, async (req: Request, res: Response) => {
  const payload = req.body as NextgentPayload;

  if (!payload?.data) {
    return res.status(400).json({ ok: false, error: 'Missing data payload' });
  }

  const data = payload.data;

  console.log(`\n================== [SIGNAL ${data.signal_id} RECEIVED] ==================`);
  console.log('Full Payload:', JSON.stringify(payload, null, 2));

  if (isDuplicate(data.signal_id)) {
    console.log(`[Idempotency] Duplicate signal_id "${data.signal_id}" ignored.`);
    return res.json({ ok: true, deduped: true, signal_id: data.signal_id });
  }

  // Build normalized signal and kick off trade
  const signal = buildTradeSignal(data);

  // Respond immediately; the trading pipeline logs details & writes to Firestore
  res.json({ ok: true, accepted: true, signal_id: data.signal_id });

  // Fire-and-forget
  try {
    await executeTradeFromSignal(signal);
  } catch (e: any) {
    // tradeExecutor handles its own logging; this is just a guard
    console.error(`[Signal Error] ${data.signal_id}:`, e?.message || e);
  }
});

// ------------------------------
// Start server
// ------------------------------
app.listen(PORT, async () => {
  console.log('==================================================');
  console.log('  Solana Trading Bot - Starting Up');
  console.log('==================================================');

  if (RPC_URL) {
    try {
      // quick version: just print host
      const host = new URL(RPC_URL).host;
      console.log(`✅ CONNECTED TO RPC ENDPOINT: ${host}`);
    } catch {
      console.log('✅ CONNECTED TO RPC ENDPOINT: <configured>');
    }
  } else {
    console.log('⚠️  RPC not configured.');
  }

  if (SHARED_SECRET) {
    console.log('✅ Webhook shared secret configured.');
  } else {
    console.log('⚠️  Webhook shared secret is NOT set; endpoint is open.');
  }

  console.log('--------------------------------------------------');
  console.log(`✅ Server is running and listening on port ${PORT}`);

  // start periodic heartbeat so you see logs in Render regularly
  startHeartbeat(RPC_URL);
});
