import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  SendOptions,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

/* ---------- ENV ---------- */
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const JUP_BASE = process.env.JUPITER_BASE_URL || "https://quote-api.jup.ag";
const DEFAULT_SLIPPAGE_BPS = Number(process.env.DEFAULT_SLIPPAGE_BPS ?? 50);
const PRIORITY_FEE_MICRO_LAMPORTS = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS ?? 30000);
const CONFIRM_TIMEOUT_MS = Number(process.env.CONFIRM_TIMEOUT_MS ?? 60000);

/* ---------- CONNECTION & WALLET (EXPORTED) ---------- */
export const connection = new Connection(RPC_URL, {
  commitment: "confirmed" as Commitment,
});

const secret58 = process.env.WALLET_PRIVATE_KEY_B58;
if (!secret58) throw new Error("WALLET_PRIVATE_KEY_B58 is not set");
const secret = bs58.decode(secret58);
const signer = Keypair.fromSecretKey(secret);
export const walletPubkey = signer.publicKey;

/* ---------- UTILS ---------- */
function toMinor(amountSOL: number): string {
  const lamports = Math.round(Number(amountSOL) * 1_000_000_000);
  return String(lamports);
}
async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForConfirmation(sig: string, timeoutMs = CONFIRM_TIMEOUT_MS) {
  const start = Date.now();
  const pollEvery = 1500;

  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([sig], {
      searchTransactionHistory: true,
    });
    const st = value[0];

    if (st?.err) throw new Error(`Transaction failed: ${JSON.stringify(st.err)}`);
    if (!st) {
      await sleep(pollEvery);
      continue;
    }
    if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
      return st;
    }
    await sleep(pollEvery);
  }

  const tx = await connection.getTransaction(sig, { commitment: "confirmed" });
  if (tx && !tx.meta?.err) return tx;

  throw new Error(
    `Transaction was not confirmed in ${(timeoutMs / 1000).toFixed(
      2
    )} seconds. It is unknown if it succeeded or failed. Check signature ${sig} on Solscan.`
  );
}

/* ---------- JUPITER HELPERS ---------- */
async function jupQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: string; // lamports
  slippageBps: number;
}) {
  const url =
    `${JUP_BASE}/v6/quote` +
    `?inputMint=${params.inputMint}` +
    `&outputMint=${params.outputMint}` +
    `&amount=${params.amount}` +
    `&slippageBps=${params.slippageBps}`;

  console.log("🟦 [executor:quote] Requesting quote", {
    fromMint: params.inputMint,
    toMint: params.outputMint,
    amountMinor: params.amount,
    slippageBps: params.slippageBps,
  });

  const r = await fetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`Quote HTTP ${r.status}: ${await r.text()}`);

  const quote = await r.json();

  console.log("🟦 [executor:quote] Got quote", {
    outAmount: quote?.outAmount ?? quote?.bestRoute?.outAmount,
    inAmount: quote?.inAmount ?? quote?.bestRoute?.inAmount,
    priceImpactPct: quote?.priceImpactPct ?? quote?.bestRoute?.priceImpactPct,
  });

  return quote;
}

async function jupSwapTx(params: {
  quote: any;
  userPubkey: PublicKey;
  slippageBps: number;
  prioritizationFeeLamports: number;
}) {
  const body = {
    quoteResponse: params.quote,
    userPublicKey: params.userPubkey.toBase58(),
    slippageBps: params.slippageBps,
    prioritizationFeeLamports: params.prioritizationFeeLamports,
    computeUnitPriceMicroLamports: params.prioritizationFeeLamports,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  };

  const r = await fetch(`${JUP_BASE}/v6/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Swap build HTTP ${r.status}: ${await r.text()}`);

  const json = await r.json();
  const swapB64 = json?.swapTransaction || json?.tx || json?.swap?.swapTransaction;
  if (!swapB64) throw new Error("No swapTransaction returned by Jupiter");
  return swapB64 as string;
}

async function sendAndConfirm(swapTxB64: string) {
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTxB64, "base64"));
  tx.sign([signer]);

  const opts: SendOptions = {
    skipPreflight: false,
    maxRetries: 8,
    preflightCommitment: "processed",
  };

  const sig = await connection.sendRawTransaction(tx.serialize(), opts);
  console.log("🟦 [executor:send] Submitted transaction", { sig });

  await waitForConfirmation(sig, CONFIRM_TIMEOUT_MS);
  console.log("🟦 [executor:confirm] Transaction confirmed", { sig });

  return sig;
}

/* ---------- PUBLIC (EXPORTED) ---------- */
export async function executeSwap(args: {
  fromMint: string;
  toMint: string;
  amountSOL: number;
  slippageBps?: number;
}) {
  const slippageBps = Number(args.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  const amountMinor = toMinor(args.amountSOL);

  const quote = await jupQuote({
    inputMint: args.fromMint,
    outputMint: args.toMint,
    amount: amountMinor,
    slippageBps,
  });

  const swapTx = await jupSwapTx({
    quote,
    userPubkey: walletPubkey,
    slippageBps,
    prioritizationFeeLamports: PRIORITY_FEE_MICRO_LAMPORTS,
  });

  const sig = await sendAndConfirm(swapTx);
  return sig;
}
