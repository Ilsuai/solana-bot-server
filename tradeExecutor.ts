// server/tradeExecutor.ts
import {
  Connection,
  VersionedTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";

const JUP_BASE = process.env.JUPITER_BASE_URL || "https://quote-api.jup.ag";
const DEFAULT_SLIPPAGE_BPS = Number(process.env.DEFAULT_SLIPPAGE_BPS || 50);
const CUP_DEFAULT = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS || 0);
const CONFIRM_TIMEOUT_MS = Number(process.env.CONFIRM_TIMEOUT_MS || 45000);

export type ExecArgs = {
  connection: Connection;
  wallet: Keypair;
  fromMint: string;
  toMint: string;
  amountMinor: string;          // amount for the INPUT mint in smallest units
  slippageBps?: number;
  cuPriceMicroLamports?: number;
};

export type ExecResult = {
  signature: string;
  outAmount?: string;
  inAmount?: string;
  priceImpactPct?: string;
};

async function jupQuote(args: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}) {
  const url = new URL(`${JUP_BASE}/v6/quote`);
  url.searchParams.set("inputMint", args.inputMint);
  url.searchParams.set("outputMint", args.outputMint);
  url.searchParams.set("amount", args.amount);
  url.searchParams.set("slippageBps", String(args.slippageBps));
  // sane defaults
  url.searchParams.set("onlyDirectRoutes", "false");
  url.searchParams.set("maxAccounts", "64");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`quote failed ${res.status}`);
  const data = await res.json();
  if (!data || !data.outAmount) throw new Error("quote empty");
  return data;
}

async function jupSwap(args: {
  userPublicKey: string;
  quoteResponse: any;
  cuPriceMicroLamports?: number;
}) {
  const body = {
    userPublicKey: args.userPublicKey,
    wrapAndUnwrapSol: true,
    useSharedAccounts: true,
    dynamicComputeUnitLimit: true,
    asLegacyTransaction: false, // request a v0 tx
    computeUnitPriceMicroLamports: args.cuPriceMicroLamports,
    quoteResponse: args.quoteResponse,
  };

  const res = await fetch(`${JUP_BASE}/v6/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`swap build failed ${res.status} ${t}`);
  }
  const data = await res.json();
  if (!data.swapTransaction) throw new Error("swap build empty");
  return data as {
    swapTransaction: string; // base64
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForConfirmation(
  connection: Connection,
  signature: string,
  timeoutMs: number
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const st = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const s = st.value[0];

    if (s?.err) throw new Error(`on-chain error: ${JSON.stringify(s.err)}`);
    const conf = s?.confirmationStatus;
    if (conf === "confirmed" || conf === "finalized") return;

    await sleep(1000);
  }
  throw new Error("confirmation timeout");
}

async function buildSignSendConfirm(
  connection: Connection,
  wallet: Keypair,
  quote: any,
  cuPriceMicroLamports?: number
) {
  const swapResp = await jupSwap({
    userPublicKey: wallet.publicKey.toBase58(),
    quoteResponse: quote,
    cuPriceMicroLamports,
  });

  const raw = Buffer.from(swapResp.swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(raw);
  tx.sign([wallet]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
  });

  await waitForConfirmation(connection, signature, CONFIRM_TIMEOUT_MS);
  return signature;
}

async function executeOnce({
  connection,
  wallet,
  fromMint,
  toMint,
  amountMinor,
  slippageBps,
  cuPriceMicroLamports,
}: ExecArgs): Promise<ExecResult> {
  const quote = await jupQuote({
    inputMint: fromMint,
    outputMint: toMint,
    amount: amountMinor,
    slippageBps: slippageBps ?? DEFAULT_SLIPPAGE_BPS,
  });

  const signature = await buildSignSendConfirm(
    connection,
    wallet,
    quote,
    cuPriceMicroLamports ?? CUP_DEFAULT
  );

  return {
    signature,
    outAmount: quote.outAmount,
    inAmount: quote.inAmount,
    priceImpactPct: quote.priceImpactPct,
  };
}

function isStaleOrExpiredError(msg: string) {
  const m = msg.toLowerCase();
  return (
    m.includes("block height exceeded") ||
    m.includes("expired") ||
    m.includes("blockhash not found") ||
    m.includes("was not processed in the given time") ||
    m.includes("confirmation timeout")
  );
}

export async function executeSwap(args: ExecArgs): Promise<ExecResult> {
  try {
    return await executeOnce(args);
  } catch (e: any) {
    const msg = String(e?.message || e);
    const logs = e?.logs || e?.value?.logs;
    if (logs) console.error("[sendTx logs]\n" + logs.join("\n"));

    // stale route / sim fail → re-quote + bump
    const isSimFail =
      msg.includes("Simulation failed") ||
      msg.includes("custom program error: 0x1771") ||
      msg.includes("Custom:6001");

    // blockhash/expiry/timeouts → re-quote + bump
    const isExpiry = isStaleOrExpiredError(msg);

    if (isSimFail || isExpiry) {
      const bumpSlippage = (args.slippageBps ?? DEFAULT_SLIPPAGE_BPS) + 50;
      const bumpCup = Math.max(
        Math.round((args.cuPriceMicroLamports ?? CUP_DEFAULT) * 1.2),
        (args.cuPriceMicroLamports ?? CUP_DEFAULT) + 5_000 // add at least +5k microLamports
      );

      console.warn(
        `[executor] retry: reason="${msg}", slippageBps=${bumpSlippage}, cu=${bumpCup}`
      );

      // Re-quote fresh and resend
      return await executeOnce({
        ...args,
        slippageBps: bumpSlippage,
        cuPriceMicroLamports: bumpCup,
      });
    }

    throw e;
  }
}

// helpers
export const toLamports = (sol: number | string) =>
  BigInt(Math.round(Number(sol) * LAMPORTS_PER_SOL)).toString();

export function loadKeypairFromEnv(): Keypair {
  const b58 = process.env.WALLET_PRIVATE_KEY_B58;
  const arr = process.env.PRIVATE_KEY_ARRAY;
  if (b58) return Keypair.fromSecretKey(bs58.decode(b58));
  if (arr) return Keypair.fromSecretKey(new Uint8Array(JSON.parse(arr)));
  throw new Error("No wallet key found in WALLET_PRIVATE_KEY_B58 or PRIVATE_KEY_ARRAY");
}
