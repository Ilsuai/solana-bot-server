import {
  AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL,
  PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, getMint, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { createJupiterApiClient, QuoteGetRequest } from '@jup-ag/api';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { logTradeToFirestore } from './firebaseAdmin';

// --- CONFIG ---
if (!process.env.SOLANA_RPC_ENDPOINT || !process.env.PRIVATE_KEY) {
  throw new Error('Missing environment variables: SOLANA_RPC_ENDPOINT and PRIVATE_KEY must be set.');
}
const connection = new Connection(process.env.SOLANA_RPC_ENDPOINT, 'confirmed');
const walletKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const jupiterApi = createJupiterApiClient();
const JITO_TIP_ACCOUNTS = (process.env.JITO_TIP_ACCOUNTS || "96gYgAKpdZvy5M2sZpSoe6W6h4scqw4v9v7K6h4xW6h4,HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucL4bge9fgo").split(',').map(k => new PublicKey(k));

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

async function ensureSolBufferOrGetTip(minSol: number = 0.02): Promise<number> {
  const balLamports = await connection.getBalance(walletKeypair.publicKey, 'processed');
  const balSol = balLamports / LAMPORTS_PER_SOL;
  console.log(`[Check] Current SOL Balance: ${balSol.toFixed(4)}`);

  let tipSol = 0.001;
  const estFeeSol = 0.0006; 
  if (balSol < minSol + tipSol + estFeeSol) {
    tipSol = Math.max(0.0003, Math.max(0, balSol - (minSol + estFeeSol)));
    console.warn(`[SOL Buffer] Low SOL balance. Scaling tip down to ${tipSol} SOL.`);
  }
  if (tipSol <= 0) throw new Error(`Insufficient SOL for fees + tip. Balance: ${balSol.toFixed(4)}, Required minimum: ${minSol}`);
  return tipSol;
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

// --- CORE TRADE LOGIC ---

export async function executeTradeFromSignal(signal: TradeSignal) {
  const { action, signal_id, input_mint, output_mint, input_amount, symbol } = signal;

  try {
    const tokenAddress = action === 'BUY' ? output_mint : input_mint;
    console.log(`✅ Signal Validated: ${action} ${symbol || tokenAddress.slice(0,4)}`);

    const [tokenDecimals, tipAmountSOL] = await Promise.all([
      getTokenDecimals(tokenAddress),
      ensureSolBufferOrGetTip(),
    ]);

    let amountInSmallestUnit: bigint;
    if (action === 'BUY') {
      console.log(`🟢 Executing BUY for ${input_amount.toFixed(4)} SOL -> ${symbol || 'Token'}`);
      amountInSmallestUnit = BigInt(Math.round(input_amount * LAMPORTS_PER_SOL));
    } else { // SELL
      const balance = await getWalletTokenBalance(input_mint);
      if (balance === 0n) throw new Error(`No wallet balance for ${symbol} (${input_mint}). Skipping SELL.`);
      
      amountInSmallestUnit = (balance * 9999n) / 10000n; // Sell 99.99% to leave dust
      const amountToSellFloat = Number(amountInSmallestUnit) / (10 ** tokenDecimals);
      console.log(`🔴 Executing SELL of ~${amountToSellFloat.toFixed(4)} ${symbol || 'Token'} (raw: ${amountInSmallestUnit})`);
    }

    const quote = await jupiterApi.quoteGet({
      inputMint: input_mint, outputMint: output_mint, amount: Number(amountInSmallestUnit),
      slippageBps: 1500, asLegacyTransaction: false,
    });
    if (!quote) throw new Error("Failed to get quote from Jupiter.");
    console.log(`[Jupiter] Quote received. Min out: ${Number(quote.outAmount) / (10 ** (action === 'BUY' ? tokenDecimals : 9))}`);
    
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
        lamports: Math.round(tipAmountSOL * LAMPORTS_PER_SOL),
    });

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const lookupTableAccounts = await Promise.all((addressLookupTableAddresses || []).map(async (address) => {
        const accountInfo = await connection.getAccountInfo(new PublicKey(address));
        if (!accountInfo) throw new Error(`Could not fetch ALT account info for ${address}`);
        return new AddressLookupTableAccount({ key: new PublicKey(address), state: AddressLookupTableAccount.deserialize(accountInfo.data) });
    }));
    if (lookupTableAccounts.length > 0) {
        console.log(`[Build] Found and loaded ${lookupTableAccounts.length} Address Lookup Tables.`);
    }
    
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
    
    const apiKey = process.env.SOLANA_RPC_ENDPOINT!.split('api-key=')[1];
    const senderUrl = `http://ewr-sender.helius-rpc.com/fast?api-key=${apiKey}`;
    
    console.log(`[Helius] Sending transaction...`);
    const response = await fetch(senderUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: '1', method: 'sendTransaction',
            params: [ bs58.encode(finalTransaction.serialize()), { encoding: "base58", skipPreflight: true } ],
        }),
    });
    const json = await response.json() as any;
    if (json.error) throw new Error(`Helius Sender Error: ${json.error.message}`);
    const txid = json.result;
    if (!txid) throw new Error('Helius Sender did not return a transaction signature.');
    console.log(`[Helius] Transaction sent successfully. Signature: ${txid}`);
    
    console.log(`[Confirm] Waiting for transaction confirmation...`);
    const confResult = await connection.confirmTransaction({ signature: txid, blockhash, lastValidBlockHeight }, 'confirmed');
    if (confResult.value.err) throw new Error(`Confirmation failed: ${JSON.stringify(confResult.value.err)}`);

    console.log(`✅ Swap successful! Tx: https://solscan.io/tx/${txid}`);
    
    await logTradeToFirestore({ txid, signal_id, action, symbol });
    console.log(`================== [SIGNAL ${signal_id} END] ======================`);

  } catch (error: any) {
    console.error(`🛑 [FATAL] Trade for Signal ID ${signal_id} failed:`, error.message);
    await logTradeToFirestore({ txid: null, signal_id, action, symbol, error: error.message });
    console.log(`================== [SIGNAL ${signal_id} END] ======================`);
  }
}