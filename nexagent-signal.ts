// server/nexagent-signal.ts
import express, { Router, Request, Response } from "express";
import { Connection, PublicKey, ParsedAccountData, TokenAmount } from "@solana/web3.js";
import { createHash } from "crypto";
import admin from "./firebaseAdmin";
import { executeSwap, toLamports, loadKeypairFromEnv } from "./tradeExecutor";

const router = Router();

router.use(express.json({ limit: "2mb" }));
router.use(express.text({ type: "*/*", limit: "2mb" }));

// ENV
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL!;
const ENABLE_SELLS = String(process.env.ENABLE_SELLS || "false") === "true";
const DEFAULT_SLIPPAGE_BPS = Number(process.env.DEFAULT_SLIPPAGE_BPS || 50);
const CUP = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS || 0);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// Strategy toggle (optional)
const MIRROR_ONLY = String(process.env.MIRROR_ONLY || "true") === "true";
const DEFAULT_BUY_SOL = Number(process.env.DEFAULT_BUY_SOL || 0.1);

// Optional per-trade caps (keep; useful safety)
const MAX_SOL_PER_TRADE = Number(process.env.MAX_SOL_PER_TRADE || Number.POSITIVE_INFINITY);
const MAX_TOKEN_UI_PER_TRADE = Number(process.env.MAX_TOKEN_UI_PER_TRADE || Number.POSITIVE_INFINITY);
const FEE_RESERVE_SOL = Number(process.env.FEE_RESERVE_SOL || 0.02);

const SOL_MINT = "So11111111111111111111111111111111111111112";

const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  [SOL_MINT]: { symbol: "SOL", decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: "USDC", decimals: 6 },
};

const toUi = (minor?: string, decimals?: number) =>
  !minor || decimals == null ? null : Number(minor) / 10 ** decimals;
const fmt = (n: number | null | undefined, dp = 6) =>
  n == null || Number.isNaN(n) ? "?" : Number(n).toFixed(dp).replace(/\.?0+$/, "");

const connection = new Connection(SOLANA_RPC_URL, {
  commitment: "confirmed",
  disableRetryOnRateLimit: false,
});
const wallet = loadKeypairFromEnv();
const db = admin.firestore();

// ---------- Idempotency ----------
function hashEventKey(parts: Record<string, any>) {
  const s = JSON.stringify(parts);
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}
async function reserveEvent(key: string) {
  const ref = db.collection("signal_events").doc(key);
  await ref.create({ status: "PROCESSING", ts: admin.firestore.FieldValue.serverTimestamp() });
}
async function completeEvent(
  key: string,
  status: "SUCCESS" | "SKIPPED" | "FAILED",
  data: any
) {
  const ref = db.collection("signal_events").doc(key);
  await ref.set({ status, data, doneAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
}
function logTrade(doc: Record<string, any>) {
  return db.collection("trades").add({ ...doc, ts: admin.firestore.FieldValue.serverTimestamp() });
}

// ---------- Decimals / balances ----------
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
async function getSolUiBalance(owner: PublicKey): Promise<number> {
  const lamports = await connection.getBalance(owner, "confirmed");
  return lamports / 1e9;
}
async function getTokenUiBalance(owner: PublicKey, mint: string): Promise<number> {
  const mintPk = new PublicKey(mint);
  const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint: mintPk }, "confirmed");
  let total = 0;
  for (const acc of resp.value) {
    const info = (acc.account.data as ParsedAccountData).parsed?.info;
    const amt: TokenAmount | undefined = info?.tokenAmount;
    if (amt?.uiAmount != null) total += Number(amt.uiAmount);
  }
  return total;
}

// ---------- Parsing / normalization ----------
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
  signalId?: string;
  slippageBps?: number;
  raw?: any;
};

function parseBody(req: Request): any {
  if (typeof req.body === "object" && req.body !== null) return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try { return JSON.parse(req.body); } catch { return { _raw: req.body }; }
  }
  return {};
}

const isMint = (v: any) => typeof v === "string" && v.length >= 32 && v.length <= 64;
const toSide = (v: any): "BUY" | "SELL" | undefined => {
  if (!v) return undefined;
  const s = String(v).toLowerCase();
  if (s === "buy" || s === "long") return "BUY";
  if (s === "sell" || s === "short") return "SELL";
  return undefined;
};

// IMPORTANT: no longer read `transaction_amount` — it’s not guaranteed to be SOL-in.
function normalize(raw: any): AgentTx {
  const b = raw || {};
  const d = b.data || b.payload || b.eventData || {};
  const s = d.swap || d.swap_data || d.transaction || d.txn || d.trade || d.details || {};

  const event = b.event || b.type || d.event || "agentTransactions";
  const ts = b.ts || b.timestamp || d.ts || d.timestamp || new Date().toISOString();
  const agentId = b.agentId ?? d.agentId ?? d.agent_id ?? null;
  const agentWallet = b.agentWallet ?? b.wallet ?? d.wallet ?? d.payer ?? d.owner ?? null;

  const dir =
    toSide(b.dir) ||
    toSide(b.direction) ||
    toSide(d.dir) ||
    toSide(d.direction) ||
    toSide(d.side) ||
    toSide(d.trade_side) ||
    toSide(d.trade_action) ||
    toSide(d.transaction_side) ||
    toSide(d.transaction_direction);

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

  // ONLY real execution amounts
  const inputAmount =
    b.inputAmount ??
    d.inputAmount ??
    d.amountIn ??
    d.amount_in ??
    s.amount_in ??
    s.input_amount ??
    s.ui_amount_in;

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

  const signalId =
    (b.signalId ??
      d.signalId ??
      b.id ??
      d.id ??
      b.signal_id ??
      d.signal_id ??
      b.tradeId ??
      d.tradeId) != null
      ? String(
          b.signalId ??
            d.signalId ??
            b.id ??
            d.id ??
            b.signal_id ??
            d.signal_id ??
            b.tradeId ??
            d.tradeId
        )
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
  // require real executable size
  if (!Number.isFinite(p.amountSOL ?? NaN) && !Number.isFinite(p.inputAmount ?? NaN)) {
    missing.push("inputAmount/amountSOL");
  }
  if (!p.signalId) missing.push("signalId");
  if (missing.length) {
    return {
      ok: false,
      error:
        "Missing required fields: " +
        missing.join(", ") +
        ". Need dir, mints, and a real amount (amountSOL or inputAmount).",
    };
  }
  return { ok: true };
}

// ---------- Route ----------
router.post("/nexagent-signal", async (req: Request, res: Response) => {
  console.log("➡️  POST /nexagent-signal");

  if (WEBHOOK_SECRET) {
    const hdr = req.get("x-webhook-secret");
    if (hdr !== WEBHOOK_SECRET) return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const raw = parseBody(req);
  let body = normalize(raw);

  // Fill from mints if direction missing
  let finalBody: AgentTx = { ...body };
  if (!finalBody.dir && finalBody.inputMint && finalBody.outputMint) {
    if (finalBody.inputMint === SOL_MINT && finalBody.outputMint !== SOL_MINT) finalBody.dir = "BUY";
    else if (finalBody.outputMint === SOL_MINT && finalBody.inputMint !== SOL_MINT) finalBody.dir = "SELL";
  }
  // BUY from SOL: mirror amountSOL from inputAmount if present
  if (
    finalBody.dir === "BUY" &&
    finalBody.inputMint === SOL_MINT &&
    !Number.isFinite(finalBody.amountSOL as any) &&
    Number.isFinite(finalBody.inputAmount as any)
  ) {
    finalBody.amountSOL = Number(finalBody.inputAmount);
  }

  // Optional tradeSignals => synthetic BUY of DEFAULT_BUY_SOL (disabled when MIRROR_ONLY=true)
  if (!MIRROR_ONLY && (finalBody.event === "tradeSignals" || raw?.event === "tradeSignals")) {
    const tokenAddr =
      raw?.data?.token_address || raw?.data?.tokenAddress || body?.raw?.data?.token_address || body?.raw?.data?.tokenAddress;
    if (typeof tokenAddr === "string" && tokenAddr.length >= 32) {
      finalBody.dir = "BUY";
      finalBody.inputMint = SOL_MINT;
      finalBody.outputMint = tokenAddr;
      finalBody.amountSOL = DEFAULT_BUY_SOL;
      finalBody.inputAmount = DEFAULT_BUY_SOL;
      finalBody.signalId = String(
        finalBody.signalId ?? raw?.data?.id ?? raw?.data?.signal_id ?? raw?.data?.tradeId ?? raw?.data?.created_at ?? Date.now()
      );
      console.warn("[nexagent-signal] tradeSignals -> SYNTH BUY", { token: tokenAddr, amountSOL: DEFAULT_BUY_SOL, signalId: finalBody.signalId });
    } else {
      console.warn("[nexagent-signal] tradeSignals ignored (no token_address)");
      return res.status(200).json({ ok: true, ignored: true, reason: "tradeSignals without token_address" });
    }
  }

  console.log("[nexagent-signal] RX", {
    dir: finalBody.dir,
    inputMint: finalBody.inputMint,
    outputMint: finalBody.outputMint,
    inputAmount: finalBody.inputAmount,
    amountSOL: finalBody.amountSOL,
    signalId: finalBody.signalId,
  });

  // If we still don't have an executable amount, ignore politely
  const hasExecutableAmount =
    Number.isFinite(finalBody.amountSOL as any) ||
    Number.isFinite(finalBody.inputAmount as any);
  if (!hasExecutableAmount) {
    const preview = typeof raw === "string" ? raw.slice(0, 240) : JSON.stringify(raw).slice(0, 240);
    console.warn("[nexagent-signal] Ignored (no executable amount)", { preview });
    return res.status(200).json({ ok: true, ignored: true, reason: "no executable amount" });
  }

  const valid = validateRequired(finalBody);
  if (!valid.ok) {
    const preview = typeof raw === "string" ? raw.slice(0, 240) : JSON.stringify(raw).slice(0, 240);
    console.warn("[nexagent-signal] Bad payload", { error: valid.error, preview });
    return res.status(200).json({ ok: true, ignored: true, reason: valid.error });
  }

  const dir = finalBody.dir as "BUY" | "SELL";
  const inputMint = finalBody.inputMint!;
  const outputMint = finalBody.outputMint!;
  const signalId = String(finalBody.signalId);
  const slippageBps = finalBody.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  // ---- Balance-aware sizing (same as before) ----
  let desiredUi = 0;

  if (dir === "BUY" && inputMint === SOL_MINT) {
    desiredUi = Number(finalBody.amountSOL ?? finalBody.inputAmount ?? 0);
    if (Number.isFinite(MAX_SOL_PER_TRADE)) desiredUi = Math.min(desiredUi, MAX_SOL_PER_TRADE);

    const solBal = await getSolUiBalance(wallet.publicKey);
    const maxSpendable = Math.max(0, solBal - FEE_RESERVE_SOL);
    if (desiredUi > maxSpendable) {
      console.warn("[nexagent-signal] BUY clipped by SOL balance", { requested: desiredUi, balance: solBal, reserve: FEE_RESERVE_SOL, maxSpendable });
      desiredUi = maxSpendable;
    }
    if (desiredUi < 0.01) {
      await completeEvent(hashEventKey({ signalId, dir, inputMint, outputMint }), "SKIPPED", { reason: "BUY too small after balance/cap" });
      return res.status(200).json({ ok: true, ignored: true, reason: "BUY too small after balance/cap" });
    }
    finalBody.amountSOL = desiredUi;
    finalBody.inputAmount = desiredUi;
  }

  if (dir === "SELL") {
    desiredUi = Number(finalBody.inputAmount ?? 0);
    if (Number.isFinite(MAX_TOKEN_UI_PER_TRADE)) desiredUi = Math.min(desiredUi, MAX_TOKEN_UI_PER_TRADE);

    const bal = await getTokenUiBalance(wallet.publicKey, inputMint);
    if (desiredUi > bal) {
      console.warn("[nexagent-signal] SELL clipped by token balance", { requested: desiredUi, balance: bal });
      desiredUi = bal;
    }
    if (desiredUi < 0.1) {
      await completeEvent(hashEventKey({ signalId, dir, inputMint, outputMint }), "SKIPPED", { reason: "SELL too small after balance/cap" });
      return res.status(200).json({ ok: true, ignored: true, reason: "SELL too small after balance/cap" });
    }
    finalBody.inputAmount = desiredUi;
  }

  // Idempotency key uses the (possibly clipped) amount
  const roundedUiAmount =
    inputMint === SOL_MINT
      ? Number((Number(finalBody.amountSOL ?? finalBody.inputAmount) || 0).toFixed(9))
      : Number((Number(finalBody.inputAmount) || 0).toFixed(9));

  const eventKey = hashEventKey({ signalId, dir, inputMint, outputMint, amountUi: roundedUiAmount });

  try {
    await reserveEvent(eventKey);
  } catch (e: any) {
    const code = e?.code || e?.status || e?.errorInfo?.code;
    const msg = String(e?.message || "");
    if (code === 6 || code === "already-exists" || msg.toUpperCase().includes("ALREADY_EXISTS")) {
      console.warn("[nexagent-signal] Duplicate (DB) – skipping", { signalId, dir, key: eventKey });
      return res.status(200).json({ ok: true, duplicate: true });
    }
    console.error("[nexagent-signal] reserveEvent failed", msg);
    return res.status(500).json({ ok: false, error: msg });
  }

  if (dir === "SELL" && !ENABLE_SELLS) {
    await logTrade({ action: "SELL_SKIPPED", txid: "-", reason: "ENABLE_SELLS=false", signalId, mintIn: inputMint, mintOut: outputMint });
    await completeEvent(eventKey, "SKIPPED", { reason: "SELL_DISABLED" });
    return res.json({ ok: true, skipped: true });
  }

  try {
    let amountMinor: string;
    let inUiAmount = 0;

    if (inputMint === SOL_MINT) {
      inUiAmount = Number(finalBody.amountSOL ?? finalBody.inputAmount ?? 0);
      amountMinor = toLamports(inUiAmount);
    } else {
      const decimals = TOKENS[inputMint]?.decimals ?? (await getMintDecimals(inputMint));
      inUiAmount = Number(finalBody.inputAmount ?? 0);
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
    const impactPct = exec.priceImpactPct ? (Number(exec.priceImpactPct) * 100).toFixed(2) + "%" : "n/a";

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
      rawSnippet: JSON.stringify(finalBody.raw).slice(0, 240),
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
