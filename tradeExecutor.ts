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
const CONFIRM_TIMEOUT_MS = Number(process.env.CONFIRM_TIMEOUT_MS || 45_000);

export type ExecArgs = {
  connection: Connection;
  wallet: Keypair;
  fromMint: string;
  toMint: string;
  amountMinor: string;          // amount for the INPUT mint in smallest units
  slippageBps?: number;
  cuPriceMicroLamports?: number;
  useSharedAccounts?: boolean;  // default true
};

export type ExecResult = {
  signature: string;
  outAmount?: string;
  inAmount?: string;
  priceImpactPct?: string;
};

// ---------------- Jupiter helpers ----------------

type QuoteOpts = {
  onlyDirectRoutes?: boolean;
  restrictIntermediateTokens?: boolean;
  maxAccounts?: number;
};

async function jupQuote(args: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  opts?: QuoteOpts;
}) {
  const url = new URL(`${JUP_BASE}/v6/quote`);
  url.searchParams.set("inputMint", args.inputMint);
  url.searchParams.set("outputMint", args.outputMint);
  url.searchParams.set("amount", args.amount);
  url.searchParams.set("slippageBps", String(args.slippageBps));

  // Defaults that generally land well
  url.searchParams.set("maxAccounts", String(args.opts?.maxAccounts ?? 64));
  url.searchParams.set(
    "onlyDirectRoutes",
    (args.opts?.onlyDirectRoutes ?? false) ? "true" : "false"
  );
  // Reduces risky hops that often fail (Jupiter tip)
  if (args.opts?.restrictIntermediateTokens != null) {
    url.searchParams.set(
      "restrictIntermediateTokens",
      args.opts.restrictIntermediateTokens ? "true" : "false"
    );
  }

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
  useSharedAccounts?: boolean;
}) {
  const body = {
    userPublicKey: args.userPublicKey,
    wrapAndUnwrapSol: true,
    useSharedAccounts: args.useSharedAccounts ?? true, // we may turn this off on fallback
    dynamicComputeUnitLimit: true,
    asLegacyTransaction: false, // v0
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
  return data as { swapTransaction: string };
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
    await sleep(1_000);
  }
  throw new Error("confirmation timeout");
}

async function buildSignSendConfirm(
  connection: Connection,
  wallet: Keypair,
  quote: any,
  cuPriceMicroLamports?: number,
  useSharedAccounts?: boolean
) {
  const swapResp = await jupSwap({
    userPublicKey: wallet.publicKey.toBase58(),
    quoteResponse: quote,
    cuPriceMicroLamports,
    useSharedAccounts,
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
  useSharedAccounts,
}: ExecArgs & { quoteOpts?: QuoteOpts }): Promise<ExecResult> {
  const quote = await jupQuote({
    inputMint: fromMint,
    outputMint: toMint,
    amount: amountMinor,
    slippageBps: slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    opts: {
      // first attempt: allow aggregator freedom (not too restrictive)
      onlyDirectRoutes: false,
      restrictIntermediateTokens: false,
      maxAccounts: 64,
    },
  });

  const signature = await buildSignSendConfirm(
    connection,
    wallet,
    quote,
    cuPriceMicroLamports ?? CUP_DEFAULT,
    useSharedAccounts
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

function isJup1788(msg: string) {
  return msg.includes("custom program error: 0x1788") || msg.includes("SharedAccountsRoute");
}

export async function executeSwap(args: ExecArgs): Promise<ExecResult> {
  try {
    // First attempt: shared accounts ON (fast), normal route freedom
    return await executeOnce({ ...args, useSharedAccounts: args.useSharedAccounts ?? true });
  } catch (e: any) {
    const msg = String(e?.message || e);
    const logs = e?.logs || e?.value?.logs;
    if (logs) console.error("[sendTx logs]\n" + logs.join("\n"));

    const isSimFail =
      msg.includes("Simulation failed") ||
      msg.includes("custom program error: 0x1771") || // slippage exceeded
      msg.includes("Custom:6001");

    const isExpiry = isStaleOrExpiredError(msg);
    const is1788 = isJup1788(msg);

    // -------- Fallback #1 (we already had): no shared accounts + bump fees/slippage
    if (isSimFail || isExpiry || is1788) {
      const bumpSlippage = (args.slippageBps ?? DEFAULT_SLIPPAGE_BPS) + 50;
      const bumpCup = Math.max(
        Math.round((args.cuPriceMicroLamports ?? CUP_DEFAULT) * 1.2),
        (args.cuPriceMicroLamports ?? CUP_DEFAULT) + 5_000
      );

      // Try again with useSharedAccounts = false (different program path)
      try {
        console.warn(
          `[executor] retry#1: reason="${msg}", slippageBps=${bumpSlippage}, cu=${bumpCup}, useShared=false`
        );
        return await (async () => {
          const quote = await jupQuote({
            inputMint: args.fromMint,
            outputMint: args.toMint,
            amount: args.amountMinor,
            slippageBps: bumpSlippage,
            opts: {
              onlyDirectRoutes: false,
              restrictIntermediateTokens: false,
              maxAccounts: 64,
            },
          });
          const sig = await buildSignSendConfirm(
            args.connection,
            args.wallet,
            quote,
            bumpCup,
            false
          );
          return {
            signature: sig,
            outAmount: quote.outAmount,
            inAmount: quote.inAmount,
            priceImpactPct: quote.priceImpactPct,
          };
        })();
      } catch (e2: any) {
        const msg2 = String(e2?.message || e2);
        const logs2 = e2?.logs || e2?.value?.logs;
        if (logs2) console.error("[sendTx logs]\n" + logs2.join("\n"));

        // -------- Fallback #2: force **simplest route** (direct only + restrict intermediates)
        if (isJup1788(msg2) || isSimFail) {
          const bumpAgain = bumpSlippage + 25;
          const cupAgain = bumpCup + 5_000;
          console.warn(
            `[executor] retry#2 (direct+restricted): reason="${msg2}", slippageBps=${bumpAgain}, cu=${cupAgain}, direct=true, restrict=true`
          );
          const quote2 = await jupQuote({
            inputMint: args.fromMint,
            outputMint: args.toMint,
            amount: args.amountMinor,
            slippageBps: bumpAgain,
            opts: {
              onlyDirectRoutes: true,
              restrictIntermediateTokens: true,
              maxAccounts: 64,
            },
          });
          const sig2 = await buildSignSendConfirm(
            args.connection,
            args.wallet,
            quote2,
            cupAgain,
            false
          );
          return {
            signature: sig2,
            outAmount: quote2.outAmount,
            inAmount: quote2.inAmount,
            priceImpactPct: quote2.priceImpactPct,
          };
        }
        throw e2;
      }
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
