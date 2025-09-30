// server/nexagent-signal.ts
import { Request, Response, Router } from "express";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import admin from "firebase-admin";
import { executeSwap, toLamports, loadKeypairFromEnv } from "./tradeExecutor";

const router = Router();

// Env
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL!;
const ENABLE_SELLS = String(process.env.ENABLE_SELLS || "false") === "true";
const DEFAULT_SLIPPAGE_BPS = Number(process.env.DEFAULT_SLIPPAGE_BPS || 50);
const CUP = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS || 0);

const SOL_MINT = "So11111111111111111111111111111111111111112";

const connection = new Connection(SOLANA_RPC_URL, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
});
const wallet = loadKeypairFromEnv();

const db = admin.firestore();

type AgentTx = {
  event: "agentTransactions";
  ts: string;
  agentWallet: string;
  dir: "BUY" | "SELL";
  inputMint: string;
  inputAmount: number; // expressed in UI units (e.g. SOL)
  outputMint: string;
  outputAmount: number;
  amountSOL: number;
  signalId: number;
  slippageBps: number;
};

// Durable idempotency: create a doc first. If it exists, skip.
async function reserveSignal(id: string) {
  const ref = db.collection("signal_events").doc(id);
  await ref.create({
    status: "PROCESSING",
    ts: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function completeSignal(id: string, status: "SUCCESS" | "SKIPPED" | "FAILED", data: any) {
  const ref = db.collection("signal_events").doc(id);
  await ref.set(
    {
      status,
      data,
      doneAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

function logTrade(doc: any) {
  return db.collection("trades").add({
    ...doc,
    ts: admin.firestore.FieldValue.serverTimestamp(),
  });
}

router.post("/nexagent-signal", async (req: Request, res: Response) => {
  const body = req.body as AgentTx;
  if (body?.event !== "agentTransactions") return res.status(400).send("bad event");

  const {
    dir,
    inputMint,
    outputMint,
    inputAmount,
    amountSOL,
    signalId,
  } = body;

  const signalKey = `${signalId}:${dir}`;

  console.log("[nexagent-signal] RX", {
    dir,
    inputMint,
    outputMint,
    inputAmount,
    amountSOL,
    signalId,
  });

  // Reserve (idempotency)
  try {
    await reserveSignal(signalKey);
  } catch (e: any) {
    if (String(e?.message || "").includes("ALREADY_EXISTS")) {
      console.warn("[nexagent-signal] Duplicate (DB) – skipping", { signalId, dir });
      return res.status(200).json({ ok: true, duplicate: true });
    }
    throw e;
  }

  // SELL global switch
  if (dir === "SELL" && !ENABLE_SELLS) {
    await logTrade({
      action: "SELL_SKIPPED",
      txid: "-",
      reason: "ENABLE_SELLS=false",
      signalId,
      mintIn: inputMint,
      mintOut: outputMint,
    });
    await completeSignal(signalKey, "SKIPPED", { reason: "SELL_DISABLED" });
    return res.json({ ok: true, skipped: true });
  }

  try {
    // Compute input amount in minor units for the input mint
    let amountMinor: string;
    if (inputMint === SOL_MINT) {
      amountMinor = toLamports(amountSOL || inputAmount || 0);
    } else {
      // For SELLs when enabled: look up token decimals and convert UI units -> minor units
      // Minimal approach: assume 6 if you prefer not to add @solana/spl-token right now.
      const assumedDecimals = 6;
      amountMinor = BigInt(Math.round(Number(inputAmount) * 10 ** assumedDecimals)).toString();
    }

    const exec = await executeSwap({
      connection,
      wallet,
      fromMint: inputMint,
      toMint: outputMint,
      amountMinor,
      slippageBps: body.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      cuPriceMicroLamports: CUP,
    });

    // Save trade (no getTransaction fetch needed)
    await logTrade({
      action: dir,
      txid: exec.signature,
      signalId,
      mintIn: inputMint,
      mintOut: outputMint,
      inAmountMinor: amountMinor,
      outAmount: exec.outAmount,
      priceImpactPct: exec.priceImpactPct,
    });

    await completeSignal(signalKey, "SUCCESS", { signature: exec.signature });

    return res.json({ ok: true, signature: exec.signature });
  } catch (e: any) {
    const msg = String(e?.message || e);
    const logs = e?.logs || e?.value?.logs;
    if (logs) console.error("[sendTx logs]\n" + logs.join("\n"));

    await completeSignal(signalKey, "FAILED", { error: msg });
    console.error("[nexagent-signal] Handler failed", msg);
    return res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
