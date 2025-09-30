// server/nexagent-signal.ts
import { Router, Request, Response } from "express";
import {
  Connection,
  PublicKey,
  ParsedAccountData,
} from "@solana/web3.js";
import admin from "./firebaseAdmin"; // env-driven initializer
import { executeSwap, toLamports, loadKeypairFromEnv } from "./tradeExecutor";

const router = Router();

// ENV
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL!;
const ENABLE_SELLS = String(process.env.ENABLE_SELLS || "false") === "true";
const DEFAULT_SLIPPAGE_BPS = Number(process.env.DEFAULT_SLIPPAGE_BPS || 50);
const CUP = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS || 0);

// Mints
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Simple token registry for clean logs (extend as needed)
const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [SOL_MINT]: { symbol: "SOL", decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 },
};

// Utils for pretty logs
const toUi = (minor?: string, decimals?: number) => {
  if (!minor || decimals === undefined) return null;
  try {
    return Number(minor) / 10 ** decimals;
  } catch {
    return null;
  }
};
const fmt = (n: number | null | undefined, dp = 6) =>
  n == null || Number.isNaN(n) ? "?" : Number(n).toFixed(dp).replace(/\.?0+$/, "");

// Shared
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
  inputAmount: number; // UI units (e.g., SOL or token UI)
  outputMint: string;
  outputAmount: number;
  amountSOL: number; // duplicate SOL amount for BUYs
  signalId: number;
  slippageBps: number;
};

// ---- Helpers ----

// Durable idempotency
async function reserveSignal(id: string) {
  const ref = db.collection("signal_events").doc(id);
  await ref.create({
    status: "PROCESSING",
    ts: admin.firestore.FieldValue.serverTimestamp(),
  });
}
async function completeSignal(
  id: string,
  status: "SUCCESS" | "SKIPPED" | "FAILED",
  data: any
) {
  const ref = db.collection("signal_events").doc(id);
  await ref.set(
    { status, data, doneAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}
function logTrade(doc: Record<string, any>) {
  return db.collection("trades").add({
    ...doc,
    ts: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// On-chain decimals lookup (works for SPL Token & Token-2022)
async function getMintDecimals(mint: string): Promise<number> {
  const pk = new PublicKey(mint);

  // Try parsed first (fast & robust)
  const parsed = await connection.getParsedAccountInfo(pk);
  const decParsed =
    (parsed.value?.data as ParsedAccountData | undefined)?.parsed?.info?.decimals;
  if (typeof decParsed === "number") return decParsed;

  // Fallback: raw layout; decimals is a single byte at offset 44
  const acc = await connection.getAccountInfo(pk);
  if (!acc || acc.data.length < 45) {
    throw new Error("mint account not found or too small");
  }
  return acc.data[44];
}

// ---- Route ----
router.post("/nexagent-signal", async (req: Request, res: Response) => {
  const body = req.body as AgentTx;

  if (body?.event !== "agentTransactions") {
    return res.status(400).json({ ok: false, error: "bad event" });
  }

  const {
    dir,
    inputMint,
    inputAmount,
    outputMint,
    amountSOL,
    signalId,
    slippageBps,
  } = body;

  const signalKey = `${signalId}:${dir}`;

  console.log("➡️  POST /nexagent-signal");
  console.log("[nexagent-signal] RX", {
    dir,
    inputMint,
    outputMint,
    inputAmount,
    amountSOL,
    signalId,
  });

  // Durable idempotency
  try {
    await reserveSignal(signalKey);
  } catch (e: any) {
    const code = e?.code || e?.status || e?.errorInfo?.code;
    const msg = String(e?.message || "");
    if (
      code === 6 ||
      code === "already-exists" ||
      msg.toUpperCase().includes("ALREADY_EXISTS")
    ) {
      console.warn("[nexagent-signal] Duplicate (DB) – skipping", {
        signalId,
        dir,
      });
      return res.status(200).json({ ok: true, duplicate: true });
    }
    console.error("[nexagent-signal] reserveSignal failed", msg);
    return res.status(500).json({ ok: false, error: msg });
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
    // Compute input amount in *minor units* for the input mint
    let amountMinor: string;

    if (inputMint === SOL_MINT) {
      // BUY path (SOL is input)
      amountMinor = toLamports(amountSOL || inputAmount || 0);
    } else {
      // SELL path (token is input) – use on-chain decimals
      const decimals = TOKENS[inputMint]?.decimals ?? (await getMintDecimals(inputMint));
      const ui = Number(inputAmount || 0);
      if (!Number.isFinite(ui) || ui <= 0) throw new Error("invalid inputAmount");
      amountMinor = BigInt(Math.round(ui * 10 ** decimals)).toString();
    }

    const exec = await executeSwap({
      connection,
      wallet,
      fromMint: inputMint,
      toMint: outputMint,
      amountMinor,
      slippageBps: Number.isFinite(slippageBps)
        ? slippageBps
        : DEFAULT_SLIPPAGE_BPS,
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

    // Pretty success log
    const inSym = TOKENS[inputMint]?.symbol ?? `${inputMint.slice(0, 4)}…`;
    const outSym = TOKENS[outputMint]?.symbol ?? `${outputMint.slice(0, 4)}…`;
    const outUi = toUi(exec.outAmount, TOKENS[outputMint]?.decimals);
    const inUi =
      inputMint === SOL_MINT
        ? Number(amountSOL || inputAmount || 0)
        : Number(inputAmount || 0);
    const impactPct = exec.priceImpactPct
      ? (Number(exec.priceImpactPct) * 100).toFixed(2) + "%"
      : "n/a";

    console.log(
      `🟩 [trade] ${dir} ${fmt(inUi)} ${inSym} → ~${fmt(outUi)} ${outSym} | slip=${slippageBps ?? DEFAULT_SLIPPAGE_BPS}bps cu=${CUP}µ | impact=${impactPct} | sig=${exec.signature}`
    );

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
