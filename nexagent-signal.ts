import { Router, Request, Response } from "express";
import { PublicKey } from "@solana/web3.js";
import admin from "firebase-admin";
import { executeSwap, connection, walletPubkey } from "./tradeExecutor";
import {
  logTradeToFirestore,
  managePosition,
  closePosition,
  getOpenPositionByToken,
} from "./firebaseAdmin";

/** =========================
 *  Constants / Config
 *  ========================= */
const router = Router();
const db = () => admin.firestore();

const SOL_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_SLIPPAGE_BPS = Number(process.env.DEFAULT_SLIPPAGE_BPS ?? 50);
/**
 * SELL execution is guarded until your executor supports token-input swaps.
 * Set ENABLE_SELLS="true" on Render when you're ready to let SELLs execute.
 */
const ENABLE_SELLS = String(process.env.ENABLE_SELLS || "").toLowerCase() === "true";

/** =========================
 *  Types
 *  ========================= */
type Dir = "BUY" | "SELL";

interface NexgentBody {
  event?: string; // 'agentTransactions'
  timestamp?: string;
  agentId?: string;
  data?: {
    agent_id?: string;
    transaction_type?: string; // 'swap'
    transaction_amount?: number;
    input_mint?: string;
    input_symbol?: string;
    input_amount?: number; // for BUY: SOL in; for SELL: token in
    input_price?: number;
    output_mint?: string;
    output_symbol?: string;
    output_amount?: number; // for BUY: token out; for SELL: SOL out
    output_price?: number;
    fees?: number;
    routes?: { slippageBps?: number; [k: string]: any };
    slippage?: number | string;
    price_impact?: number | string;
    signal_id?: number;
  };
}

/** =========================
 *  Small helpers
 *  ========================= */
const seenInMemory = new Set<string>();
const dedupeKey = (signalId: number | string | undefined, dir: Dir) =>
  `${signalId ?? "na"}:${dir}`;

function asNum(n: any, fallback = 0): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/** =========================
 *  Normalization
 *  ========================= */
function normalize(body: NexgentBody) {
  const d = body?.data;

  if (!d?.input_mint || !d?.output_mint) {
    return { ok: false, reason: "Missing input_mint/output_mint" } as const;
  }

  const inputMint = new PublicKey(d.input_mint).toBase58();
  const outputMint = new PublicKey(d.output_mint).toBase58();

  // BUY if input is SOL; SELL if output is SOL
  let dir: Dir | null = null;
  if (inputMint === SOL_MINT) dir = "BUY";
  else if (outputMint === SOL_MINT) dir = "SELL";

  if (!dir) {
    return { ok: false, reason: "Neither leg is SOL (unsupported path)" } as const;
  }

  const tsISO = body.timestamp ?? new Date().toISOString();
  const signalId = d.signal_id ?? "na";

  const inputAmount = asNum(d.input_amount, 0);
  const outputAmount = asNum(d.output_amount, 0);

  // Amount we will feed into the executor (currently SOL-input only):
  const amountSOL = dir === "BUY" ? inputAmount : outputAmount;

  const slippageBps =
    asNum(d?.routes?.slippageBps, 0) > 0
      ? asNum(d?.routes?.slippageBps)
      : DEFAULT_SLIPPAGE_BPS;

  const tokenSymbol =
    (dir === "BUY" ? d.output_symbol : d.input_symbol)?.toString().trim() || undefined;

  return {
    ok: true as const,
    event: body.event,
    tsISO,
    agentId: body.agentId,
    signalId,
    dir,
    // For BUY: from=SOL to=token; SELL: from=token to=SOL
    fromMint: dir === "BUY" ? inputMint : inputMint,
    toMint: dir === "BUY" ? outputMint : outputMint,
    amountSOL, // BUY: SOL spent; SELL: SOL received (executor sells disabled unless ENABLE_SELLS=true)
    inputAmount,
    outputAmount,
    tokenSymbol,
    slippageBps,
  };
}

/** =========================
 *  Firestore de-dupe (persistent)
 *  ========================= */
async function isProcessed(signalId: number | string, dir: Dir): Promise<boolean> {
  const id = dedupeKey(signalId, dir);
  const snap = await db().collection("signal_events").doc(id).get();
  if (!snap.exists) return false;
  const s = snap.data() || {};
  return s.status === "executed" || s.status === "in_progress";
}

async function markInProgress(signalId: number | string, dir: Dir, payload: any) {
  const id = dedupeKey(signalId, dir);
  await db()
    .collection("signal_events")
    .doc(id)
    .set(
      {
        signalId: String(signalId),
        dir,
        status: "in_progress",
        firstSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        attempts: admin.firestore.FieldValue.increment(1),
        payload,
      },
      { merge: true }
    );
}

async function markExecuted(signalId: number | string, dir: Dir, signature: string) {
  const id = dedupeKey(signalId, dir);
  await db()
    .collection("signal_events")
    .doc(id)
    .set(
      {
        status: "executed",
        signature,
        executedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

async function markFailed(signalId: number | string, dir: Dir, error: string) {
  const id = dedupeKey(signalId, dir);
  await db()
    .collection("signal_events")
    .doc(id)
    .set(
      {
        status: "failed",
        error,
        lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

/** =========================
 *  Route
 *  ========================= */
router.post("/nexagent-signal", async (req: Request, res: Response) => {
  const n = normalize(req.body as NexgentBody);

  if (!n.ok) {
    console.log("🟥 [nexagent-signal] Invalid payload:", n.reason, req.body);
    return res.status(400).json({ ok: false, error: n.reason });
  }

  const {
    dir,
    tsISO,
    signalId,
    fromMint,
    toMint,
    amountSOL,
    inputAmount,
    outputAmount,
    tokenSymbol,
    slippageBps,
  } = n;

  // Structured RX log
  console.log("🟦 [nexagent-signal] RX", {
    event: "agentTransactions",
    ts: tsISO,
    agentWallet: walletPubkey.toBase58(),
    dir,
    inputMint: fromMint,
    inputAmount,
    outputMint: toMint,
    outputAmount,
    amountSOL,
    signalId,
    slippageBps,
  });

  // In-memory guard
  const memKey = dedupeKey(signalId, dir);
  if (seenInMemory.has(memKey)) {
    console.log("🟨 [nexagent-signal] Duplicate (RAM) – skipping", { signalId, dir });
    return res.json({ ok: true, duplicate: true, guard: "memory" });
  }

  try {
    // DB guard
    if (await isProcessed(signalId, dir)) {
      console.log("🟨 [nexagent-signal] Duplicate (DB) – skipping", { signalId, dir });
      seenInMemory.add(memKey);
      return res.json({ ok: true, duplicate: true, guard: "db" });
    }

    seenInMemory.add(memKey);
    await markInProgress(signalId, dir, req.body);

    /** =========================
     *  EXECUTE
     *  ========================= */
    if (dir === "SELL" && !ENABLE_SELLS) {
      // Mirror as "skipped" so your dashboard still shows intent,
      // and positions can be reviewed manually if needed.
      await logTradeToFirestore({
        kind: "SELL",
        status: "Skipped",
        txid: "-",
        tokenAddress: fromMint,
        tokenSymbol,
        solAmount: outputAmount || undefined, // SOL expected
        tokenAmount: inputAmount || undefined, // tokens sold
        date: new Date(tsISO),
        note: "Sells disabled (ENABLE_SELLS != true)",
      });
      // Do NOT mark as executed; keep the event as "failed" so it could be retried later.
      await markFailed(signalId, dir, "SELL disabled by config");
      console.log("🟨 [nexagent-signal] SELL skipped (ENABLE_SELLS not true)", {
        signalId,
      });
      return res.json({ ok: true, executed: false, skipped: "sells_disabled" });
    }

    console.log("🟦 [nexagent-signal] EXECUTE", {
      dir,
      fromMint,
      toMint,
      amountSOL,
      slippageBps,
      signalId: String(signalId),
    });

    // For now, executeSwap expects SOL input; BUYs are SOL→token, which is supported.
    // When you enable SELLs, ensure tradeExecutor supports token→SOL swaps before flipping ENABLE_SELLS=true.
    const signature = await executeSwap({
      fromMint,
      toMint,
      amountSOL,
      slippageBps,
    });

    console.log("🟦 [executor:send] Submitted", { sig: signature });

    // One more confirmation probe for sanity
    const tx = await connection.getTransaction(signature, { commitment: "confirmed" });
    const executed = !!tx && !tx.meta?.err;

    console.log(`🟦 [executor:confirm] ${executed ? "Confirmed" : "Unknown"}`, {
      sig: signature,
    });

    /** =========================
     *  MIRROR → Firestore
     *  ========================= */
    if (dir === "BUY") {
      await logTradeToFirestore({
        kind: "BUY",
        status: executed ? "Success" : "Unknown",
        txid: signature,
        tokenAddress: toMint,
        tokenSymbol,
        solAmount: amountSOL,
        tokenAmount: outputAmount || undefined,
        date: new Date(tsISO),
      });

      await managePosition({
        txid: signature,
        status: "open",
        tokenAddress: toMint,
        tokenSymbol,
        solSpent: amountSOL,
        tokenReceived: outputAmount || undefined,
        openedAt: new Date(tsISO),
      });
    } else {
      // SELL
      await logTradeToFirestore({
        kind: "SELL",
        status: executed ? "Success" : "Unknown",
        txid: signature,
        tokenAddress: fromMint,
        tokenSymbol,
        solAmount: amountSOL, // SOL received
        tokenAmount: inputAmount || undefined, // tokens sold
        date: new Date(tsISO),
      });

      // Try to close an open position for this token
      try {
        const open = await getOpenPositionByToken(fromMint);
        if (open?.id) {
          await closePosition(open.id, amountSOL, "sell_signal");
        }
      } catch (e) {
        console.warn("⚠️ closePosition warning:", (e as any)?.message || e);
      }
    }

    await markExecuted(signalId, dir, signature);
    console.log(`🟦 [nexagent-signal] ${dir} executed`, { txSignature: signature });
    return res.json({ ok: true, executed, signature });
  } catch (err: any) {
    const msg = String(err?.message || err);
    await markFailed(signalId, dir, msg).catch(() => {});
    console.error("🟥 [nexagent-signal] Handler failed", msg);
    return res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
