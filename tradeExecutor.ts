// server/tradeExecutor.ts
import {
  Connection,
  VersionedTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
  SignatureStatus,
} from "@solana/web3.js";
import bs58 from "bs58";

const JUP_BASE = process.env.JUPITER_BASE_URL || "https://quote-api.jup.ag";
const DEFAULT_SLIPPAGE_BPS = Number(process.env.DEFAULT_SLIPPAGE_BPS || 50);

// ↑ Raise default CUP + timeout to reduce timeouts under load.
// (You can override with env on Render.)
const CUP_DEFAULT = Number(process.env.PRIORITY_FEE_MICRO_LAMPORTS || 50_000);
const CONFIRM_TIMEOUT_MS = Number(process.env.CONFIRM_TIMEOUT_MS || 90_000);

export type ExecArgs = {
  connection: Connection;
  wallet: Keypair;
  fromMint: string;
  toMint: string;
  amountMinor: string;          // amount for INPUT mint in smallest units
  slippageBps?: number;
  cuPriceMicroLamports?: number;
  useSharedAccounts?: boolean;  // default true
};

export type ExecResult = {
  signature: string;
  outAmount?: string;
  inAmount?: string;
  priceImpactPct?: string;
  usedSlippageBps: number;
  usedSharedAccounts: boolean;
  routeDirectOnly: boolean;
  restrictIntermediates: boolean;
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

  url.searchParams.set("maxAccounts", String(args.opts?.maxAccounts ?? 64));
  url.searchParams.set(
    "onlyDirectRoutes",
    (args.opts?.onlyDirectRoutes ?? false) ? "true" : "false"
  );
  if (args.opts?.restrictIntermediateTokens != null) {
    url.searchParams.set(
      "restrictIntermediateTokens",
      args.opts.restrictIntermediateTokens ? "true" : "false"
    );
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`quote failed ${res.status}: ${text}`);
  }
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
    useSharedAccounts: args.useSharedAccounts ?? true,
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

// --- Smarter confirmation: poll; if timeout, do final late-landing checks ---
async function waitForConfirmation(
  connection: Connection,
  signature: string,
  timeoutMs: number
) {
  const started = Date.now();

  async function statusOk(): Promise<boolean> {
    const st = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const s: SignatureStatus | null | undefined = st.value[0];
    if (s?.err) throw new Error(`on-chain error: ${JSON.stringify(s.err)}`);
    const conf = s?.confirmationStatus;
    return conf === "confirmed" || conf === "finalized";
  }

  while (Date.now() - started < timeoutMs) {
    if (await statusOk()) return;
    await sleep(1000);
  }

  // Final double-checks before giving up:
  // 1) One more status read (sometimes lands just after our loop)
  if (await statusOk()) return;

  // 2) Try fetching the actual tx; handle v0 with maxSupportedTransactionVersion
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    } as any);
    if (tx) return; // landed
  } catch {
    // ignore; we'll throw below
  }

  throw new Error("confirmation timeout");
}

async function buildSignSendConfirm(
  connection: Connection,
  wallet: Keypair,
  quote: any,
  cuPriceMicroLamports: number,
  useSharedAccounts: boolean
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
function isJup1771or6001(msg: string) {
  return msg.includes("custom program error: 0x1771") || msg.includes("Custom:6001");
}
function isJup1788(msg: string) {
  return (
    msg.includes("custom program error: 0x1788") ||
    msg.includes("SharedAccountsRoute") ||
    msg.includes("Instruction: Route")
  );
}
function isQuote400(msg: string) {
  return msg.includes("quote failed 400");
}

type TryOnceArgs = {
  connection: Connection;
  wallet: Keypair;
  fromMint: string;
  toMint: string;
  amountMinor: string;
  slippageBps: number;
  cuPriceMicroLamports: number;
  useSharedAccounts: boolean;
  directOnly: boolean;
  restrictIntermediates: boolean;
};

async function tryOnce(a: TryOnceArgs): Promise<ExecResult> {
  const quote = await jupQuote({
    inputMint: a.fromMint,
    outputMint: a.toMint,
    amount: a.amountMinor,
    slippageBps: a.slippageBps,
    opts: {
      onlyDirectRoutes: a.directOnly,
      restrictIntermediateTokens: a.restrictIntermediates,
      maxAccounts: 64,
    },
  });

  const signature = await buildSignSendConfirm(
    a.connection,
    a.wallet,
    quote,
    a.cuPriceMicroLamports,
    a.useSharedAccounts
  );

  return {
    signature,
    outAmount: quote.outAmount,
    inAmount: quote.inAmount,
    priceImpactPct: quote.priceImpactPct,
    usedSlippageBps: a.slippageBps,
    usedSharedAccounts: a.useSharedAccounts,
    routeDirectOnly: a.directOnly,
    restrictIntermediates: a.restrictIntermediates,
  };
}

export async function executeSwap(args: ExecArgs): Promise<ExecResult> {
  const baseSlip = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const baseCup = args.cuPriceMicroLamports ?? CUP_DEFAULT;

  try {
    // Attempt #1 — shared accounts ON, route freedom
    return await tryOnce({
      connection: args.connection,
      wallet: args.wallet,
      fromMint: args.fromMint,
      toMint: args.toMint,
      amountMinor: args.amountMinor,
      slippageBps: baseSlip,
      cuPriceMicroLamports: baseCup,
      useSharedAccounts: args.useSharedAccounts ?? true,
      directOnly: false,
      restrictIntermediates: false,
    });
  } catch (e: any) {
    const msg = String(e?.message || e);
    const logs = e?.logs || e?.value?.logs;
    if (logs) console.error("[sendTx logs]\n" + logs.join("\n"));

    const isSimFail = msg.includes("Simulation failed") || isJup1771or6001(msg);
    const isExpiry = isStaleOrExpiredError(msg);
    const is1788 = isJup1788(msg);
    const isQ400 = isQuote400(msg);

    // Attempt #2 — quote 400 → direct-only quote
    if (isQ400) {
      const slip = baseSlip + 25;
      console.warn(`[executor] retry#Q400: direct-only quote, slippageBps=${slip}`);
      return await tryOnce({
        connection: args.connection,
        wallet: args.wallet,
        fromMint: args.fromMint,
        toMint: args.toMint,
        amountMinor: args.amountMinor,
        slippageBps: slip,
        cuPriceMicroLamports: baseCup,
        useSharedAccounts: args.useSharedAccounts ?? true,
        directOnly: true,
        restrictIntermediates: true,
      });
    }

    // Attempt #2 — 1771/1788/expiry → no shared + bumps
    if (isSimFail || isExpiry || is1788) {
      const slip = baseSlip + 50;
      const cup = Math.max(Math.round(baseCup * 1.2), baseCup + 5_000);
      console.warn(
        `[executor] retry#1: reason="${msg}", slippageBps=${slip}, cu=${cup}, useShared=false`
      );
      try {
        return await tryOnce({
          connection: args.connection,
          wallet: args.wallet,
          fromMint: args.fromMint,
          toMint: args.toMint,
          amountMinor: args.amountMinor,
          slippageBps: slip,
          cuPriceMicroLamports: cup,
          useSharedAccounts: false,
          directOnly: false,
          restrictIntermediates: false,
        });
      } catch (e2: any) {
        const msg2 = String(e2?.message || e2);
        const logs2 = e2?.logs || e2?.value?.logs;
        if (logs2) console.error("[sendTx logs]\n" + logs2.join("\n"));

        // Attempt #3 — direct-only + restricted + more bumps
        if (isJup1788(msg2) || isSimFail) {
          const slip2 = slip + 25;
          const cup2 = cup + 5_000;
          console.warn(
            `[executor] retry#2 (direct+restricted): reason="${msg2}", slippageBps=${slip2}, cu=${cup2}`
          );
          return await tryOnce({
            connection: args.connection,
            wallet: args.wallet,
            fromMint: args.fromMint,
            toMint: args.toMint,
            amountMinor: args.amountMinor,
            slippageBps: slip2,
            cuPriceMicroLamports: cup2,
            useSharedAccounts: false,
            directOnly: true,
            restrictIntermediates: true,
          });
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
