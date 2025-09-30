// server/nexagent-signal.ts
import express, { Router, Request, Response } from "express";
import { Connection, PublicKey, ParsedAccountData } from "@solana/web3.js";
import { createHash } from "crypto";
import admin from "./firebaseAdmin";
import { executeSwap, toLamports, loadKeypairFromEnv } from "./tradeExecutor";

const router = Router();

// Accept JSON and raw text (some webhooks send wrong content-type)
router.use(express.json({ limit: "2mb" }));
router.use(express.text({ type: "*/*", limit: "2mb" }));

// ENV
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL!;
const ENABLE_SELLS = String(process.env.ENABLE_SELLS || "false") === "true";
const DEFAULT_SLIPPAGE_BPS = Number(process.env.DEFAULT_SLIPPAGE_BPS || 50);
const CUP = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS || 0);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// Mints
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Token registry (extend as needed)
const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [SOL_MINT]: { symbol: "SOL", decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 },
};

// Pretty helpers
const toUi = (minor?: string, decimals?: number) =>
  !minor || decimals == null ? null : Number(minor) / 10 ** decimals;
const fmt = (n: number | null | undefined, dp = 6) =>
  n == null || Number.isNaN(n) ? "?" : Number(n).toFixed(dp).replace(/\.?0+$/, "");

// Shared
const connection = new Connection(SOLANA_RPC_URL, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
});
const wallet = loadKeypairFromEnv();
const db = admin.firestore();

// ---------- Durable idempotency (supports reused signalId) ----------
function hashEventKey(parts: Record<string, any>) {
  const s = JSON.stringify(parts);
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}
async function reserveEvent(key: string) {
  const ref = db.collection("signal_events").doc(key);
  await ref.create({
    status: "PROCESSING",
    ts: admin.firestore.FieldValue.serverTimestamp(),
  });
}
async function completeEvent(key: string, status: "SUCCESS" | "SKIPPED" | "FAILED", data: any) {
  const ref = db.collection("signal_events").doc(key);
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

// Decimals lookup (Token / Token-2022)
async function getMintDecimals(mint: string): Promise<number> {
  const pk = new PublicKey(mint);
  const parsed = await connection.getParsedAccountInfo(pk);
  const decParsed =
    (parsed.value?.data as ParsedAccountData | undefined)?.parsed?.info?.decimals;
  if (typeof decParsed === "number") return decParsed;

  const acc = await connection.getAccountInfo(pk);
  if (!acc || acc.data.length < 45) throw new Error("mint account not found");
  return acc.data[44];
}

// ---------- Parsing / normalization / validation ----------
type AgentTx = {
  event?: string;
  ts?: string;
  agentId?: string | null;
  agentWallet?: string | null;
  dir?: "BUY" | "SELL";
  inputMint?: string;
  inputAmount?: number; // UI units
  outputMint?: string;
  outputAmount?: number;
  amountSOL?: number;
  signalId?: string;     // allow string to match Nexgent ids
  slippageBps?: number;
  raw?: any;             // keep for debugging
};

function parseBody(req: Request): any {
  if (typeof req.body === "object" && req.body !== null) return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return { _raw: req.body };
    }
  }
  return {};
}

const isMint = (v: any) => typeof v === "string" && v.length >= 32 && v.length <= 64; // loose
const toSide = (v: any): "BUY" | "SELL" | undefined => {
  if (!v) return undefined;
  const s = String(v).toLowerCase();
  if (s === "buy" || s === "long") return "BUY";
  if (s === "sell" || s === "short") return "SELL";
  return undefined;
};

// Try to map many possible field names; supports nested `data.*`
function normalize(raw: any): AgentTx {
  const b = raw || {};
  const d = b.data || b.payload || b.eventData || {};

  // 1) basic identity/time
  const event = b.event || b.type || d.event || "agentTransactions";
  const ts = b.ts || b.timestamp || d.ts || d.timestamp || new Date().toISOString();
  const agentId = b.agentId ?? d.agentId ?? d.agent_id ?? null;
  const agentWallet = b.agentWallet ?? b.wallet ?? d.wallet ?? d.payer ?? d.owner ?? null;

  // 2) direction
  const dir =
    toSide(b.dir) ||
    toSide(b.direction) ||
    toSide(d.dir) ||
    toSide(d.direction) ||
    toSide(d.side) ||
    toSide(d.trade_side) ||
    toSide(d.trade_action);

  // 3) mints (look in several shapes; Nexgent often nests under swap/swap_data/transaction)
  const s = d.swap || d.swap_data || d.transaction || d.txn || d.trade || d.details || {};

  const inputMint =
    b.inputMint ||
    b.fromMint ||
    d.inputMint ||
    d.fromMint ||
    d.input_mint ||
    d.from_token_mint ||
    s.input_mint ||
    s.from_mint ||
    s.from_token_mint ||
    s.base_mint;

  const outputMint =
    b.outputMint ||
    b.toMint ||
    d.outputMint ||
    d.toMint ||
    d.output_mint ||
    d.to_token_mint ||
    s.output_mint ||
    s.to_mint ||
    s.to_token_mint ||
    s.quote_mint;

  // 4) amounts (UI units)
  const inputAmount =
    b.inputAmount ??
    d.inputAmount ??
    d.amountIn ??
    d.amount_in ??
    s.amount_in ??
    s.input_amount ??
    s.ui_amount_in ??
    d.uiAmount ??
    d.amount ??
    (d.sol_amount ?? s.sol_amount); // sometimes present for SOL buys

  const outputAmount =
    b.outputAmount ??
    d.outputAmount ??
    d.amountOut ??
    d.amount_out ??
    s.amount_out ??
    s.output_amount ??
    s.ui_amount_out;

  const amountSOL =
    b.amountSOL ?? d.amountSOL ?? d.sol_in ?? d.solAmount ?? s.sol_in ?? s.sol_amount;

  // 5) id / slippage
  const signalId =
    (b.signalId ?? d.signalId ?? b.id ?? d.id ?? b.signal_id ?? d.signal_id ?? b.tradeId ?? d.tradeId) != null
      ? String(b.signalId ?? d.signalId ?? b.id ?? d.id ?? b.signal_id ?? d.signal_id ?? b.tradeId ?? d.tradeId)
      : undefined;

  const slippageBps =
    Number.isFinite(b.slippageBps) ? b.slippageBps :
    Number.isFinite(d.slippageBps) ? d.slippageBps :
    Number.isFinite(d.slippage) ? d.slippage :
    Number.isFinite(s.slippage_bps) ? s.slippage_bps :
    undefined;

  return {
    event,
    ts,
    agentId,
    agentWallet,
    dir: dir as any,
    inputMint,
    outputMint,
    inputAmount: inputAmount != null ? Number(inputAmount) : undefined,
    outputAmount: outputAmount != null ? Number(outputAmount) : undefined,
    amountSOL: amountSOL != null ? Number(amountSOL) : undefined,
    signalId,
    slippageBps: slippageBps != null ? Number(slippageBps) : undefined,
    raw: raw,
  };
}

function validateRequired(p: AgentTx): { ok: true } | { ok: false; error: string } {
  const missing: string[] = [];
  if (!p.dir) missing.push("dir");
  if (!isMint(p.inputMint)) missing.push("inputMint");
  if (!isMint(p.outputMint)) missing.push("outputMint");
  if (!Number.isFinite(p.inputAmount ?? NaN) && !Number.isFinite(p.amountSOL ?? NaN)) {
    missing.push("inputAmount/amountSOL");
  }
  if (!p.signalId) missing.push("signalId");

  if (missing.length) {
    return {
      ok: false,
      error:
        "Missing required fields: " +
        missing.join(", ") +
        ". Ensure JSON includes dir, inputMint, outputMint, inputAmount (or amountSOL), and signalId.",
    };
  }
  return { ok: true };
}

// ---------- Route ----------
router.post("/nexagent-signal", async (req: Request, res: Response) => {
  console.log("➡️  POST /nexagent-signal");

  // Optional shared-secret auth
  if (WEBHOOK_SECRET) {
    const hdr = req.get("x-webhook-secret");
    if (hdr !== WEBHOOK_SECRET) return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const raw = parseBody(req);
  const body = normalize(raw);

  console.log("[nexagent-signal] RX", {
    dir: body.dir,
    inputMint: body.inputMint,
    outputMint: body.outputMint,
    inputAmount: body.inputAmount,
    amountSOL: body.amountSOL,
    signalId: body.signalId,
  });

  // If this is obviously a "signal" (analytics) without swap details, just ignore politely.
  const txnType =
    raw?.transaction_type || raw?.data?.transaction_type || raw?.data?.type || body.event;
  if (
    (!body.dir || !body.inputMint || !body.outputMint) &&
    (txnType === "swap" || body.event === "tradeSignals" || body.event === "agentTransactions")
  ) {
    const preview =
      typeof raw === "string" ? raw.slice(0, 240) : JSON.stringify(raw).slice(0, 240);
    console.warn("[nexagent-signal] Ignored (no actionable swap fields)", { preview });
    // Return 200 so we don't keep erroring for non-executable signals
    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "no actionable swap fields (waiting for detailed payload)",
    });
  }

  // Validate BEFORE idempotency/DB
  const valid = validateRequired(body);
  if (!valid.ok) {
    const preview =
      typeof raw === "string" ? raw.slice(0, 240) : JSON.stringify(raw).slice(0, 240);
    console.warn("[nexagent-signal] Bad payload", { error: valid.error, preview });
    return res.status(200).json({ ok: true, ignored: true, reason: valid.error });
  }

  const dir = body.dir as "BUY" | "SELL";
  const inputMint = body.inputMint!;
  const outputMint = body.outputMint!;
  const signalId = String(body.signalId);
  const slippageBps = body.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  // Min amount guards (avoid Jupiter 400s)
  if (dir === "BUY" && inputMint === SOL_MINT) {
    const ui = Number(body.amountSOL ?? body.inputAmount ?? 0);
    if (!Number.isFinite(ui) || ui < 0.01)
      return res.status(200).json({ ok: true, ignored: true, reason: "BUY too small (<0.01 SOL)" });
  }
  if (dir === "SELL") {
    const ui = Number(body.inputAmount ?? 0);
    if (!Number.isFinite(ui) || ui < 0.1)
      return res.status(200).json({ ok: true, ignored: true, reason: "SELL too small (<0.10)" });
  }

  // ---- Idempotency key (allows same signalId multiple times) ----
  const roundedUiAmount =
    inputMint === SOL_MINT
      ? Number((Number(body.amountSOL ?? body.inputAmount) || 0).toFixed(9))
      : Number((Number(body.inputAmount) || 0).toFixed(9));

  const eventKey = hashEventKey({
    signalId,
    dir,
    inputMint,
    outputMint,
    amountUi: roundedUiAmount,
  });

  try {
    await reserveEvent(eventKey);
  } catch (e: any) {
    const code = e?.code || e?.status || e?.errorInfo?.code;
    const msg = String(e?.message || "");
    if (code === 6 || code === "already-exists" || msg.toUpperCase().includes("ALREADY_EXISTS")) {
      console.warn("[nexagent-signal] Duplicate (DB) – skipping", {
        signalId,
        dir,
        key: eventKey,
      });
      return res.status(200).json({ ok: true, duplicate: true });
    }
    console.error("[nexagent-signal] reserveEvent failed", msg);
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
    await completeEvent(eventKey, "SKIPPED", { reason: "SELL_DISABLED" });
    return res.json({ ok: true, skipped: true });
  }

  try {
    // compute input amount in minor units
    let amountMinor: string;
    let inUiAmount = 0;

    if (inputMint === SOL_MINT) {
      inUiAmount = Number(body.amountSOL ?? body.inputAmount ?? 0);
      amountMinor = toLamports(inUiAmount);
    } else {
      const decimals =
        TOKENS[inputMint]?.decimals ?? (await getMintDecimals(inputMint));
      inUiAmount = Number(body.inputAmount ?? 0);
      amountMinor = BigInt(Math.round(inUiAmount * 10 ** decimals)).toString();
    }

    const exec = await executeSwap({
      connection,
      wallet,
      fromMint: inputMint,
      toMint: outputMint,
      amountMinor,
      slippageBps,
      cuPriceMicroLamports: CUP,
    });

    const inSym = TOKENS[inputMint]?.symbol ?? `${inputMint.slice(0, 4)}…`;
    const outSym = TOKENS[outputMint]?.symbol ?? `${outputMint.slice(0, 4)}…`;
    const outUi = toUi(exec.outAmount, TOKENS[outputMint]?.decimals);
    const impactPct = exec.priceImpactPct
      ? (Number(exec.priceImpactPct) * 100).toFixed(2) + "%"
      : "n/a";

    await logTrade({
      action: dir,
      txid: exec.signature,
      signalId,
      mintIn: inputMint,
      mintOut: outputMint,
      inSymbol: inSym,
      outSymbol: outSym,
      inAmountUi: inUiAmount,
      outAmountUi: outUi,
      inAmountMinor: amountMinor,
      outAmountMinor: exec.outAmount,
      priceImpactPct: exec.priceImpactPct,
      usedSlippageBps: exec.usedSlippageBps,
      usedSharedAccounts: exec.usedSharedAccounts,
      routeDirectOnly: exec.routeDirectOnly,
      restrictIntermediates: exec.restrictIntermediates,
      cuPriceMicroLamports: CUP,
      idempotencyKey: eventKey,
      rawSnippet: JSON.stringify(body.raw).slice(0, 240),
    });

    await completeEvent(eventKey, "SUCCESS", { signature: exec.signature });

    const routeHint = exec.routeDirectOnly ? "route=direct" : "route=aggregated";
    console.log(
      `🟩 [trade] ${dir} ${fmt(inUiAmount)} ${inSym} → ~${fmt(outUi)} ${outSym} | slipUsed=${exec.usedSlippageBps}bps cu=${CUP}µ ${routeHint} | impact=${impactPct} | sig=${exec.signature}`
    );

    return res.json({ ok: true, signature: exec.signature });
  } catch (e: any) {
    const msg = String(e?.message || e);
    const logs = e?.logs || e?.value?.logs;
    if (logs) console.error("[sendTx logs]\n" + logs.join("\n"));

    await completeEvent(eventKey, "FAILED", { error: msg });
    console.error("[nexagent-signal] Handler failed", msg);
    return res.status(500).json({ ok: false, error: msg });
  }
});

export default router;
