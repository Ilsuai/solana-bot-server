// tradeExecutor.ts
import 'dotenv/config';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createJupiterApiClient, QuoteGetRequest } from '@jup-ag/api';
import bs58 from 'bs58';

/**
 * =======================
 * ENV / CONFIG
 * =======================
 */
const {
  RPC_URL = '',
  HELIUS_RPC = '', // preferred: your Helius endpoint
  WALLET_SECRET = '',
  JITO_TIP_ACCOUNTS = 'GvHe7qZLkqQ1gCxy3xS6wqL9r8n9p7k8ZK7j1oTip111,5bNf1NhJitoTips11111111111111111111111111',
} = process.env;

if (!HELIUS_RPC && !RPC_URL) {
  throw new Error('Set HELIUS_RPC (preferred) or RPC_URL in your env');
}

if (!WALLET_SECRET) {
  throw new Error('Set WALLET_SECRET (base58) in your env');
}

const connection = new Connection(HELIUS_RPC || RPC_URL, {
  commitment: 'processed',
});
const walletKeypair = Keypair.fromSecretKey(bs58.decode(WALLET_SECRET));

// Jito tip accounts list
const JITO_TIP_LIST = JITO_TIP_ACCOUNTS.split(',').map((s) => s.trim()).filter(Boolean);

// Jupiter client
const jupiterApi = createJupiterApiClient();

/**
 * =======================
 * UTILS / STUBS
 * =======================
 */

// Basic Firestore logger stub to avoid build errors.
// Replace with your real Firestore call if you want.
async function logTradeToFirestore(entry: Record<string, any>) {
  try {
    // no-op in this stub
    console.log('[FirestoreLog]', JSON.stringify(entry));
  } catch {
    // swallow
  }
}

// Dynamic Jito tip selection; you can wire this to your latency/tip oracle later.
async function getDynamicTipAmount(): Promise<number> {
  // 0.001 SOL default tip; adjust as needed or query a live source
  return 0.001;
}

// Helius getPriorityFeeEstimate. Returns microLamports-per-CU (number).
async function getPriorityFeeEstimateMicroLamports(serializedTxBase64: string): Promise<number | null> {
  const endpoint = HELIUS_RPC || RPC_URL;
  if (!endpoint) return null;

  try {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getPriorityFeeEstimate',
      params: [
        {
          transaction: serializedTxBase64,
          options: {
            // Return recommended; you can also request includeAllPriorityFeeLevels/details
            recommended: true,
          },
        },
      ],
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.warn('[PriorityFee] HTTP', res.status, await res.text());
      return null;
    }
    const json = await res.json();
    // Helius returns something like { result: { priorityFeeEstimate: number, ... } }
    const microLamports: number | undefined =
      json?.result?.priorityFeeEstimate ?? json?.result?.recommended?.microLamports;
    if (typeof microLamports === 'number' && Number.isFinite(microLamports)) {
      return microLamports;
    }
    return null;
  } catch (e) {
    console.warn('[PriorityFee] Error', (e as Error).message);
    return null;
  }
}

// Rehydrate a Jupiter instruction (they return `accounts`, not `keys`)
const rehydrateInstruction = (instruction: any) => {
  if (!instruction) return null;
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: (instruction.accounts || []).map((acc: any) => ({
      pubkey: new PublicKey(acc.pubkey),
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    })),
    data: Buffer.from(instruction.data, 'base64'),
  });
};

// Fetch ALT accounts from chain
async function loadLookupTableAccounts(addresses: string[]): Promise<AddressLookupTableAccount[]> {
  if (!addresses?.length) return [];
  const pubkeys = addresses.map((a) => new PublicKey(a));
  const infos = await connection.getMultipleAccountsInfo(pubkeys);
  return infos
    .map((info, i) => {
      if (!info) return null;
      try {
        return new AddressLookupTableAccount({
          key: pubkeys[i],
          state: AddressLookupTableAccount.deserialize(info.data),
        });
      } catch {
        return null;
      }
    })
    .filter(Boolean) as AddressLookupTableAccount[];
}

/**
 * =======================
 * CORE: EXECUTE TRADE
 * =======================
 */

type TradeSignal = {
  signal_id: number | string;
  transaction_type: 'swap';
  input_mint: string; // e.g., So111... for SOL
  output_mint: string; // e.g., EPjF... for USDC
  input_amount: number; // in SOL if input_mint is wrapped SOL
  output_symbol?: string;
};

export async function executeTradeFromSignal(data: TradeSignal) {
  const signalId = data.signal_id;
  console.log(`================== [SIGNAL ${signalId} RECEIVED] ==================`);
  console.log('Full Payload:', JSON.stringify({ data }, null, 2));

  const slippageBpsAttempts = [500, 1500, 2500]; // 5%, 15%, 25%
  const inMint = data.input_mint;
  const outMint = data.output_mint;
  const inputSol = data.input_amount;

  console.log(
    `✅ Signal Validated: BUY ${inputSol.toFixed(4)} SOL for ${data.output_symbol || outMint.slice(0, 4)}...`
  );

  for (let attempt = 0; attempt < slippageBpsAttempts.length; attempt++) {
    const slippageBps = slippageBpsAttempts[attempt];
    try {
      console.log('--- [ATTEMPT ' + (attempt + 1) + '/' + slippageBpsAttempts.length + '] ---');
      console.log(`💰 Executing BUY for ${inputSol.toFixed(4)} SOL with ${(slippageBps / 100).toFixed(0)}% slippage.`);

      // 1) Get a quote
      console.log('[Swap] Getting quote from Jupiter...');
      const quoteReq: QuoteGetRequest = {
        inputMint: inMint,
        outputMint: outMint,
        amount: Math.round(inputSol * LAMPORTS_PER_SOL), // amount in lamports when input is SOL
        slippageBps,
        platformFeeBps: 0,
        onlyDirectRoutes: false,
        asLegacyTransaction: false, // we are using v0
        maxAccounts: 58, // leave headroom for tip + budget ixs
      };

      const quote = await jupiterApi.quoteGet(quoteReq);

      // 2) Build swap instructions (we will append CU + tip around them)
      console.log('[Swap] Building transaction for Helius Sender...');
      const {
        setupInstructions: sui,
        swapInstruction: si,
        cleanupInstruction: cui,
        addressLookupTableAddresses, // prefer these over quote.lookupTableAccountAddresses
      } = await jupiterApi.swapInstructionsPost({
        swapRequest: {
          quoteResponse: quote,
          userPublicKey: walletKeypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
        },
      });

      const setupIxs = (sui || []).map(rehydrateInstruction).filter(Boolean) as TransactionInstruction[];
      const swapIx = rehydrateInstruction(si) as TransactionInstruction;
      const cleanupIx = cui ? (rehydrateInstruction(cui) as TransactionInstruction) : null;

      // 3) Jito tip
      const tipAmountSOL = await getDynamicTipAmount();
      console.log(`[Tip] Using dynamic Jito tip: ${tipAmountSOL} SOL`);
      const tipIx = SystemProgram.transfer({
        fromPubkey: walletKeypair.publicKey,
        toPubkey: new PublicKey(
          JITO_TIP_LIST[Math.floor(Math.random() * Math.max(1, JITO_TIP_LIST.length))]
        ),
        lamports: Math.round(tipAmountSOL * LAMPORTS_PER_SOL),
      });

      // 4) Compile a provisional v0 message to simulate and estimate compute usage/priority fee
      const altAddresses =
        (addressLookupTableAddresses?.length
          ? addressLookupTableAddresses
          : (quote as any)?.lookupTableAccountAddresses) ?? [];

      const altAccounts = await loadLookupTableAccounts(altAddresses);

      // Provisional CU limit (will recompile after sim if needed)
      const provisionalIxs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
        // price placeholder, replaced after estimate
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        ...setupIxs,
        swapIx,
        ...(cleanupIx ? [cleanupIx] : []),
        tipIx,
      ];

      const { blockhash } = await connection.getLatestBlockhash();
      const provisionalMsg = new TransactionMessage({
        payerKey: walletKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions: provisionalIxs,
      }).compileToV0Message(altAccounts);

      const provisionalTx = new VersionedTransaction(provisionalMsg);

      // Serialize for Helius priority fee estimation
      const provisionalSerialized = Buffer.from(provisionalTx.serialize()).toString('base64');

      // 5) Ask Helius for priority fee estimate (microLamports-per-CU)
      let microLamports = await getPriorityFeeEstimateMicroLamports(provisionalSerialized);
      if (!microLamports || microLamports <= 0) {
        // fallback if estimation fails
        microLamports = 500_000; // 0.5 lamports per CU; tune for your strategy
      }
      console.log(`[Priority Fee] Using dynamic fee: ${microLamports} microLamports`);

      // 6) Simulate to get compute units used and adjust CU limit
      const simResult = await connection.simulateTransaction(provisionalTx, {
        commitment: 'processed',
        replaceRecentBlockhash: true,
        sigVerify: false,
      });

      if (simResult.value.err) {
        console.error('Sim logs:\n' + (simResult.value.logs ?? []).join('\n'));
        throw new Error(`Transaction simulation failed: ${JSON.stringify(simResult.value.err)}`);
      }

      const unitsConsumed = simResult.value.unitsConsumed ?? 350_000;
      const cuLimit = Math.ceil(unitsConsumed * 1.2); // +20% headroom

      // 7) Rebuild final instructions with accurate CU price and limit
      const finalIxs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
        ...setupIxs,
        swapIx,
        ...(cleanupIx ? [cleanupIx] : []),
        tipIx,
      ];

      const { blockhash: finalBlockhash } = await connection.getLatestBlockhash();
      const finalMsg = new TransactionMessage({
        payerKey: walletKeypair.publicKey,
        recentBlockhash: finalBlockhash,
        instructions: finalIxs,
      }).compileToV0Message(altAccounts);

      const finalTx = new VersionedTransaction(finalMsg);
      finalTx.sign([walletKeypair]);

      // Optionally, simulate again to be extra safe
      const finalSim = await connection.simulateTransaction(finalTx, {
        commitment: 'processed',
        replaceRecentBlockhash: true,
        sigVerify: true,
      });

      if (finalSim.value.err) {
        console.error('Final sim logs:\n' + (finalSim.value.logs ?? []).join('\n'));
        throw new Error(`Transaction simulation failed: ${JSON.stringify(finalSim.value.err)}`);
      }

      // 8) Send the tx
      const raw = finalTx.serialize();
      const sig = await connection.sendRawTransaction(raw, {
        skipPreflight: true, // we already simulated
        maxRetries: 3,
      });

      console.log('✅ Sent tx:', sig);

      // 9) Confirm
      const conf = await connection.confirmTransaction(
        { signature: sig, blockhash: finalBlockhash, lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight },
        'confirmed'
      );

      if (conf.value.err) {
        throw new Error(`Confirmation error: ${JSON.stringify(conf.value.err)}`);
      }

      console.log(`🎉 Trade executed successfully for Signal ID: ${signalId}`);
      await logTradeToFirestore({
        txid: sig,
        status: 'success',
        date: new Date(),
        signal_id: signalId,
        in_mint: inMint,
        out_mint: outMint,
        amount_sol: inputSol,
        slippage_bps: slippageBps,
        priority_fee_micro_lamports: microLamports,
        cu_limit: cuLimit,
      });
      console.log(`================== [SIGNAL ${signalId} END] ======================`);
      return;
    } catch (err: any) {
      console.error(`❌ [TRADE FAILED] Attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === slippageBpsAttempts.length - 1) {
        console.error(`🛑 [FATAL] All attempts failed for Signal ID ${signalId}.`);
        await logTradeToFirestore({
          txid: null,
          status: 'failed',
          date: new Date(),
          signal_id: signalId,
          error: err?.message || 'Unknown error',
        });
        console.log(`================== [SIGNAL ${signalId} END] ======================`);
        throw err;
      }
    }
  }
}

/**
 * =======================
 * Example runner (optional)
 * =======================
 * Uncomment to quick-test locally:
 *
 * executeTradeFromSignal({
 *   signal_id: 98769,
 *   transaction_type: 'swap',
 *   input_mint: 'So11111111111111111111111111111111111111112',
 *   output_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
 *   input_amount: 0.01,
 *   output_symbol: 'USDC',
 * }).catch(() => process.exit(1));
 */
