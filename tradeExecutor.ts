// src/tradeExecutor.ts

import {
  AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL,
  PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, getMint, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { createJupiterApiClient, QuoteResponse } from '@jup-ag/api';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { logTradeToFirestore, getBotStatus } from './firebaseAdmin';

// --- CONFIG ---
if (!process.env.SOLANA_RPC_ENDPOINT || !process.env.PRIVATE_KEY) {
  throw new Error('Missing environment variables: SOLANA_RPC_ENDPOINT and PRIVATE_KEY must be set.');
}
const connection = new Connection(process.env.SOLANA_RPC_ENDPOINT, 'confirmed');
const walletKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const jupiterApi = createJupiterApiClient();

// Jito Tips
const JITO_TIP_ACCOUNTS = (process.env.JITO_TIP_ACCOUNTS || "96gYgAKpdZvy5M2sZpSoe6W6h4scqw4v9v7K6h4xW6h4,HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucL4bge9fgo,D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ").split(',').map(k => new PublicKey(k));
const JITO_TIP_SOL = parseFloat(process.env.JITO_TIP_SOL || '0.001');

// Trade Execution Config
const SOL_SAFETY_BUFFER = parseFloat(process.env.SOL_SAFETY_BUFFER || '0.015'); // Keep this much SOL in wallet at all times
const ATA_RENT_SOL = 0.00203928; // Rent for a new Associated Token Account
const MAX_SLIPPAGE_BPS = parseInt(process.env.MAX_SLIPPAGE_BPS || '300', 10); // 3% default max slippage for dynamic slippage
const QUOTE_STALENESS_THRESHOLD_MS = parseInt(process.env.QUOTE_STALENESS_THRESHOLD_MS || '2000', 10); // 2 seconds
const MAX_QUOTE_RETRIES = 3;

// --- TYPES ---
export type TradeSignal = {
  action: 'BUY' | 'SELL';
  signal_id: number | string;
  input_mint: string;
  output_mint: string;
  input_amount: number;
  symbol?: string;
};

// --- HELPER FUNCTIONS ---

async function getWalletTokenBalance(mintStr: string): Promise<bigint> {
  const mint = new PublicKey(mintStr);
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = await getAssociatedTokenAddress(mint, walletKeypair.publicKey, false, programId);
      const acc = await getAccount(connection, ata, 'confirmed', programId);
      console.log(`[Balance] Found token balance for ${mintStr.slice(0,4)}...: ${acc.amount}`);
      return acc.amount;
    } catch (_) { /* try next program id */ }
  }
  return 0n;
}

async function getTokenDecimals(mintAddress: string): Promise<number> {
  const pk = new PublicKey(mintAddress);
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const decimals = (await getMint(connection, pk, 'confirmed', programId)).decimals;
      console.log(`[Decimals] Found ${decimals} decimals for ${mintAddress.slice(0,4)}... using SPL Token program.`);
      return decimals;
    } catch (_) {}
  }
  try {
    const res = await fetch(`https://token.jup.ag/v2/mint?mints=${mintAddress}`);
    if(!res.ok) throw new Error(`Jupiter Token API failed with status ${res.status}`);
    const json = await res.json() as any;
    const d = json?.[0]?.decimals;
    if (typeof d === 'number') {
        console.log(`[Decimals] Found ${d} decimals for ${mintAddress.slice(0,4)}... using Jupiter API fallback.`);
        return d;
    }
  } catch (e) {
      console.warn(`[Decimals] Jupiter Token API fallback failed: ${(e as Error).message}`);
  }
  throw new Error(`Could not fetch decimals for token ${mintAddress} after all fallbacks.`);
}

async function getPriorityFeeEstimate(transaction: VersionedTransaction): Promise<number> {
    try {
        const response = await fetch(connection.rpcEndpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: '1', method: 'getPriorityFeeEstimate',
                params: [{ transaction: bs58.encode(transaction.serialize()), options: { includeAllFees: true } }],
            }),
        });
        const data = await response.json() as any;
        const fee = data.result?.priorityFeeEstimate || 500000;
        console.log(`[Priority Fee] Using dynamic fee: ${fee.toLocaleString()} microLamports`);
        return fee;
    } catch (error) {
        console.warn("[Priority Fee] Failed to get dynamic fee, using fallback.", error);
        return 500000;
    }
}

const rehydrateInstruction = (instruction: any): TransactionInstruction | null => {
    if (!instruction) return null;
    return new TransactionInstruction({
        programId: new PublicKey(instruction.programId),
        keys: (instruction.accounts || []).map((key: any) => ({
            pubkey: new PublicKey(key.pubkey), isSigner: key.isSigner, isWritable: key.isWritable,
        })),
        data: Buffer.from(instruction.data, 'base64'),
    });
};

/**
 * Fetches a quote from Jupiter, ensuring it's not stale and respecting retry limits.
 */
async function getValidQuote(inputMint: string, outputMint: string, amount: number): Promise<QuoteResponse> {
  let retries = 0;
  while (retries < MAX_QUOTE_RETRIES) {
    try {
      const quote = await jupiterApi.quoteGet({
        inputMint,
        outputMint,
        amount,
        // CORRECTED SYNTAX FOR DYNAMIC SLIPPAGE
        dynamicSlippage: true,
        slippageBps: MAX_SLIPPAGE_BPS,
        asLegacyTransaction: false,
      });

      if (!quote) throw new Error("Jupiter returned a null quote.");

      // CORRECTED HANDLING OF OPTIONAL timeTaken
      const quoteAge = Date.now() - ((quote.timeTaken ?? 0) * 1000);
      const isStale = quoteAge > QUOTE_STALENESS_THRESHOLD_MS;
      const hasComplexRoute = (quote.routePlan?.length ?? 0) > 2;

      if (!isStale && !hasComplexRoute) {
        console.log(`[Jupiter] Quote received. Min out: ${Number(quote.outAmount) / (10 ** 9)}`);
        return quote;
      }

      console.warn(`[Jupiter] Refetching quote. Reason: ${isStale ? 'Stale' : ''} ${hasComplexRoute ? 'Complex Route' : ''}`);

    } catch (error) {
      console.error(`[Jupiter] Attempt ${retries + 1} failed to get quote:`, (error as Error).message);
    }
    retries++;
  }
  throw new Error(`Failed to get a valid quote from Jupiter after ${MAX_QUOTE_RETRIES} retries.`);
}


// --- CORE TRADE LOGIC ---

export async function executeTradeFromSignal(signal: TradeSignal) {
  const { action, signal_id, input_mint, output_mint, input_amount, symbol } = signal;

  try {
    // 1. CHECK BOT STATUS FROM FIRESTORE
    const botStatus = await getBotStatus();
    if (botStatus !== 'RUNNING') {
      throw new Error(`Bot status is '${botStatus}'. Skipping signal.`);
    }
    console.log(`✅ Bot is RUNNING. Proceeding with Signal ID: ${signal_id}`);

    const tokenAddress = action === 'BUY' ? output_mint : input_mint;
    const tokenDecimals = await getTokenDecimals(tokenAddress);
    
    let amountInSmallestUnit: bigint;

    if (action === 'BUY') {
      // 2. PRE-TRADE SOLVENCY CHECK
      const currentSolBalance = await connection.getBalance(walletKeypair.publicKey, 'confirmed');
      const priorityFeeEstimateLamports = 500000; // conservative estimate for pre-check
      const tipLamports = JITO_TIP_SOL * LAMPORTS_PER_SOL;
      
      const overheadLamports = BigInt(priorityFeeEstimateLamports + tipLamports) + BigInt(Math.ceil((SOL_SAFETY_BUFFER + ATA_RENT_SOL) * LAMPORTS_PER_SOL));
      const spendableLamports = currentSolBalance - Number(overheadLamports);
      
      let lamportsToSpend = BigInt(Math.round(input_amount * LAMPORTS_PER_SOL));
      
      if (lamportsToSpend > spendableLamports) {
        console.warn(`[Solvency] Insufficient balance for full buy. Requested: ${input_amount} SOL, Spendable: ${(spendableLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL. Downsizing trade.`);
        lamportsToSpend = BigInt(spendableLamports);
      }

      if (lamportsToSpend <= 0) {
        throw new Error(`Insufficient SOL for trade and fees. Balance: ${(currentSolBalance / LAMPORTS_PER_SOL).toFixed(4)}`);
      }
      
      amountInSmallestUnit = lamportsToSpend;
      const effectiveSolAmount = Number(amountInSmallestUnit) / LAMPORTS_PER_SOL;
      console.log(`🟢 Executing BUY 🟢 for ${effectiveSolAmount.toFixed(4)} SOL -> ${symbol || 'Token'}`);

    } else { // SELL
      const balance = await getWalletTokenBalance(input_mint);
      if (balance === 0n) throw new Error(`No wallet balance for ${symbol} (${input_mint}). Skipping SELL.`);
      
      amountInSmallestUnit = (balance * 9999n) / 10000n; // Sell 99.99%
      const amountToSellFloat = Number(amountInSmallestUnit) / (10 ** tokenDecimals);
      console.log(`🔴 Executing SELL 🔴 of ~${amountToSellFloat.toFixed(4)} ${symbol || 'Token'}`);
    }

    // 3. GET A VALID, NON-STALE QUOTE
    const quote = await getValidQuote(input_mint, output_mint, Number(amountInSmallestUnit));
    
    const { 
      swapInstruction: si, setupInstructions: sui, cleanupInstruction: cui, addressLookupTableAddresses,
    } = await jupiterApi.swapInstructionsPost({
        swapRequest: { quoteResponse: quote, userPublicKey: walletKeypair.publicKey.toBase58(), wrapAndUnwrapSol: true },
    });
    
    const instructions = [
      ...(sui || []).map(rehydrateInstruction),
      rehydrateInstruction(si),
      ...(cui ? [rehydrateInstruction(cui)] : []),
    ].filter((ix): ix is TransactionInstruction => ix !== null);

    const tipInstruction = SystemProgram.transfer({
        fromPubkey: walletKeypair.publicKey,
        toPubkey: JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)],
        lamports: Math.round(JITO_TIP_SOL * LAMPORTS_PER_SOL),
    });

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const lookupTableAccounts = await Promise.all((addressLookupTableAddresses || []).map(async (address) => {
        const accountInfo = await connection.getAccountInfo(new PublicKey(address));
        if (!accountInfo) throw new Error(`Could not fetch ALT account info for ${address}`);
        return new AddressLookupTableAccount({ key: new PublicKey(address), state: AddressLookupTableAccount.deserialize(accountInfo.data) });
    }));
    
    let tempMessage = new TransactionMessage({
        payerKey: walletKeypair.publicKey, recentBlockhash: blockhash, instructions: [...instructions, tipInstruction],
    }).compileToV0Message(lookupTableAccounts);
    let tempTransaction = new VersionedTransaction(tempMessage);
    const priorityFee = await getPriorityFeeEstimate(tempTransaction);

    const simInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      ...instructions, tipInstruction
    ];
    tempMessage = new TransactionMessage({
        payerKey: walletKeypair.publicKey, recentBlockhash: blockhash, instructions: simInstructions,
    }).compileToV0Message(lookupTableAccounts);
    tempTransaction = new VersionedTransaction(tempMessage);
    
    const simResult = await connection.simulateTransaction(tempTransaction, { sigVerify: false, replaceRecentBlockhash: true });
    if (simResult.value.err) throw new Error(`Simulation failed: ${JSON.stringify(simResult.value.err)}`);
    const unitsConsumed = simResult.value.unitsConsumed!;
    const computeUnits = Math.ceil(unitsConsumed * 1.2);
    console.log(`[Simulate] Units consumed: ${unitsConsumed}. Setting limit with 20% margin: ${computeUnits}`);

    const finalInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      ...instructions, tipInstruction
    ];
    let finalMessage = new TransactionMessage({
        payerKey: walletKeypair.publicKey, recentBlockhash: blockhash, instructions: finalInstructions,
    }).compileToV0Message(lookupTableAccounts);
    let finalTransaction = new VersionedTransaction(finalMessage);
    finalTransaction.sign([walletKeypair]);
    
    let txid: string;
    try {
      console.log('[Send] Attempting with Helius Sender...');
      const apiKey = process.env.SOLANA_RPC_ENDPOINT!.split('api-key=')[1];
      const senderUrl = `https://sender.helius-rpc.com/fast?api-key=${apiKey}`;
      
      const response = await fetch(senderUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
              jsonrpc: '2.0', id: '1', method: 'sendTransaction',
              params: [ bs58.encode(finalTransaction.serialize()), { encoding: "base58", skipPreflight: true, maxRetries: 0 } ],
          }),
      });
      const json = await response.json() as any;
      if (json.error) throw new Error(`Helius Sender Error: ${json.error.message}`);
      if (!json.result) throw new Error('Helius Sender did not return a signature.');
      txid = json.result;
      console.log(`[Helius] Transaction sent successfully. Signature: ${txid}`);
    } catch (e) {
      console.warn('[Send] Helius Sender failed, falling back to standard RPC:', (e as Error).message);
      txid = await connection.sendRawTransaction(finalTransaction.serialize(), { skipPreflight: true, maxRetries: 2 });
    }
    
    console.log(`[Confirm] Waiting for transaction confirmation...`);
    const confResult = await connection.confirmTransaction({ signature: txid, blockhash, lastValidBlockHeight }, 'confirmed');
    if (confResult.value.err) throw new Error(`Confirmation failed: ${JSON.stringify(confResult.value.err)}`);

    console.log(`✅ Swap successful! ✅ Tx: https://solscan.io/tx/${txid}`);
    
    await logTradeToFirestore({ txid, signal_id, action, symbol, status: 'Success' });
    console.log(`================== [SIGNAL ${signal_id} END] ======================`);

  } catch (error: any) {
    console.error(`🛑 [FATAL] Trade for Signal ID ${signal_id} failed:`, error.message);
    await logTradeToFirestore({ txid: null, signal_id, action, symbol, error: error.message, status: 'Failed' });
    console.log(`================== [SIGNAL ${signal_id} END] ======================`);
  }
}