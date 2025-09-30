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
    blockhash?: string;
    lastValidBlockHeight?: number;
  };
}

async function sendAndConfirm(
  connection: Connection,
  tx: VersionedTransaction,
  blockhash?: string,
  lastValidBlockHeight?: number
) {
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 2,
  });

  let bh = blockhash;
  let lvbh = lastValidBlockHeight;
  if (!bh || !lvbh) {
    const info = await connection.getLatestBlockhash("finalized");
    bh = info.blockhash;
    lvbh = info.lastValidBlockHeight;
  }

  await connection.confirmTransaction(
    { signature: sig, blockhash: bh!, lastValidBlockHeight: lvbh! },
    "confirmed"
  );

  return sig;
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

  const swapResp = await jupSwap({
    userPublicKey: wallet.publicKey.toBase58(),
    quoteResponse: quote,
    cuPriceMicroLamports: cuPriceMicroLamports ?? CUP_DEFAULT,
  });

  const raw = Buffer.from(swapResp.swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(raw);
  tx.sign([wallet]);

  const signature = await sendAndConfirm(
    connection,
    tx,
    swapResp.blockhash,
    swapResp.lastValidBlockHeight
  );

  return {
    signature,
    outAmount: quote.outAmount,
    inAmount: quote.inAmount,
    priceImpactPct: quote.priceImpactPct,
  };
}

export async function executeSwap(args: ExecArgs): Promise<ExecResult> {
  try {
    return await executeOnce(args);
  } catch (e: any) {
    const msg = String(e?.message || "");
    const logs = e?.logs || e?.value?.logs;
    if (logs) console.error("[sendTx logs]\n" + logs.join("\n"));

    // stale route / price moved / Jupiter Custom:6001
    if (
      msg.includes("Simulation failed") ||
      msg.includes("custom program error: 0x1771") ||
      msg.includes("Custom:6001")
    ) {
      const bumpSlippage = (args.slippageBps ?? DEFAULT_SLIPPAGE_BPS) + 50;
      const bumpCup = Math.round(
        (args.cuPriceMicroLamports ?? CUP_DEFAULT) * 1.2
      );
      console.warn(
        `[executor] retrying with slippageBps=${bumpSlippage}, cu=${bumpCup}`
      );
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
