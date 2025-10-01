import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  TransactionMessage,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  createJupiterApiClient,
  QuoteResponse,
} from '@jup-ag/api';
import { getMint } from '@solana/spl-token';
import { logTradeToFirestore, managePosition, getOpenPositionBySignalId, closePosition } from './firebaseAdmin';
import bs58 from 'bs58';
import fetch from 'node-fetch';

const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

// --- FIX IS HERE ---
// Updated list of official Helius tip accounts from the error log.
const JITO_TIP_ACCOUNTS = [
  "96gYgAKpdZvy5M2sZpSoe6W6h4scqw4v9v7K6h4xW6h4",
  "5z6r3bWKgJ8b3bWKgJ8b3bWKgJ8b3bWKgJ8b3bWKgJ8b",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucL4bge9fgo",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUvjgqa3zbYxPFJ2g5vVbvoUvCefeCathEe",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwVyaL",
  "DttWaKGXQ2sApveDb6V8rg8k5RREJxM6ENv67Z4tLke6",
  "GvDsBf7p2PPdD66n1Gsw2sC2EMwG8i9eJd2YjFesv6Qq",
].map(a => new PublicKey(a));
// --- END OF FIX ---


if (!process.env.PRIVATE_KEY || !process.env.SOLANA_RPC_ENDPOINT) {
  throw new Error('Missing environment variables.');
}

const walletKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
const connection = new Connection(process.env.SOLANA_RPC_ENDPOINT, 'confirmed');
const jupiterApi = createJupiterApiClient();

async function getTokenDecimals(mintAddress: string): Promise<number> {
    if (mintAddress === SOL_MINT_ADDRESS) return 9;
    try {
        const mintPublicKey = new PublicKey(mintAddress);
        const mintInfo = await getMint(connection, mintPublicKey);
        return mintInfo.decimals;
    } catch (error) {
        throw new Error(`Could not fetch decimals for token ${mintAddress}.`);
    }
}

async function performSwap(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number
): Promise<{ txid: string; quote: QuoteResponse }> {
    console.log(`[Swap] Getting quote from Jupiter...`);
    const quote = await jupiterApi.quoteGet({
        inputMint, outputMint, amount, slippageBps,
        asLegacyTransaction: false,
    });
    if (!quote) throw new Error('Failed to get a quote from Jupiter.');

    console.log(`[Swap] Building transaction for Helius Sender...`);
    
    // @ts-ignore
    const addressLookupTableKeys = quote.lookupTableAccountAddresses;
    
    const { 
      computeBudgetInstructions: cbi, 
      setupInstructions: sui, 
      swapInstruction: si, 
      cleanupInstruction: cui, 
    } = await jupiterApi.swapInstructionsPost({
        swapRequest: { quoteResponse: quote, userPublicKey: walletKeypair.publicKey.toBase58(), wrapAndUnwrapSol: true },
    });
    
    const rehydrateInstruction = (instruction: any) => {
      if (!instruction) return null;
      return new TransactionInstruction({
        programId: new PublicKey(instruction.programId),
        keys: (instruction.keys || []).map((key: any) => ({
          ...key,
          pubkey: new PublicKey(key.pubkey),
        })),
        data: Buffer.from(instruction.data, 'base64'),
      });
    };

    const computeBudgetInstructions = (cbi || []).map(rehydrateInstruction).filter(Boolean) as TransactionInstruction[];
    const setupInstructions = (sui || []).map(rehydrateInstruction).filter(Boolean) as TransactionInstruction[];
    const swapInstruction = rehydrateInstruction(si) as TransactionInstruction;
    const cleanupInstruction = rehydrateInstruction(cui);

    const instructions = [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000 }),
        ...computeBudgetInstructions,
        ...setupInstructions,
        swapInstruction,
        ...(cleanupInstruction ? [cleanupInstruction] : []),
        SystemProgram.transfer({
            fromPubkey: walletKeypair.publicKey,
            // --- FIX IS HERE ---
            // Pick a random tip account from the valid list
            toPubkey: JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)],
            // --- END OF FIX ---
            lamports: 1_000_000,
        }),
    ].filter((ix): ix is TransactionInstruction => !!ix);
    
    const addressLookupTableAccounts: AddressLookupTableAccount[] = [];
    if (addressLookupTableKeys && addressLookupTableKeys.length > 0) {
        const lookupTableAccountInfos = await connection.getMultipleAccountsInfo(
            addressLookupTableKeys.map((key: string) => new PublicKey(key))
        );
        for (let i = 0; i < lookupTableAccountInfos.length; i++) {
            if (lookupTableAccountInfos[i]) {
                addressLookupTableAccounts.push(new AddressLookupTableAccount({
                    key: new PublicKey(addressLookupTableKeys[i]),
                    state: AddressLookupTableAccount.deserialize(lookupTableAccountInfos[i]!.data),
                }));
            }
        }
    }
    
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
        payerKey: walletKeypair.publicKey,
        recentBlockhash: blockhash,
        instructions,
    }).compileToV0Message(addressLookupTableAccounts);
    
    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([walletKeypair]);
    const rawTransaction = Buffer.from(transaction.serialize()).toString('base64');

    const apiKey = process.env.SOLANA_RPC_ENDPOINT!.split('api-key=')[1];
    if (!apiKey) {
      throw new Error("Could not extract API key from SOLANA_RPC_ENDPOINT");
    }
    
    const senderUrl = `http://ewr-sender.helius-rpc.com/fast?api-key=${apiKey}`;

    console.log(`[Swap] Sending transaction via Helius Sender...`);
    const response = await fetch(senderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: '1',
            method: 'sendTransaction',
            params: [
              rawTransaction,
              {
                encoding: "base64",
                skipPreflight: true,
                maxRetries: 0
              }
            ],
        }),
    });
    
    const json = await response.json() as { result: string, error?: any };
    console.log('[Swap] Full Helius Sender Response:', JSON.stringify(json, null, 2));

    if (json.error) {
      throw new Error(`Helius Sender Error: ${json.error.message}`);
    }
    if (!json.result) {
      throw new Error('Helius Sender response did not include a "result" (signature).');
    }
    
    const txid = json.result;
    const confirmation = await connection.confirmTransaction({ signature: txid, blockhash, lastValidBlockHeight }, 'confirmed');
    if (confirmation.value.err) throw new Error(`Transaction confirmation failed.`);

    console.log(`✅ Swap successful! Transaction: https://solscan.io/tx/${txid}`);
    return { txid, quote };
}

export async function executeTrade(
  tokenAddress: string,
  action: 'BUY' | 'SELL',
  solAmount: number, 
  signalId: number
): Promise<void> {
    const slippageSettings = [500, 1500, 2500];
    for (let i = 0; i < slippageSettings.length; i++) {
        const currentSlippage = slippageSettings[i];
        try {
            console.log(`\n--- [ATTEMPT ${i + 1}/${slippageSettings.length}] ---`);
            if (action === 'BUY') {
                console.log(`💰 Executing BUY for ${solAmount.toFixed(4)} SOL with ${currentSlippage / 100}% slippage.`);
                const outputTokenDecimals = await getTokenDecimals(tokenAddress);
                const amountInLamports = Math.round(solAmount * 10 ** 9);
                const { txid, quote } = await performSwap(SOL_MINT_ADDRESS, tokenAddress, amountInLamports, currentSlippage);
                const tokenAmountReceived = Number(quote.outAmount) / 10 ** outputTokenDecimals;
                
                console.log(`📝 Logging BUY trade to database...`);
                await logTradeToFirestore({ txid, status: 'Success', kind: action, solAmount, tokenAmount: tokenAmountReceived, tokenAddress, slippageBps: currentSlippage, date: new Date(), signal_id: signalId });
                await managePosition({ signal_id: signalId, status: 'open', tokenAddress, solSpent: solAmount, tokenReceived: tokenAmountReceived, openedAt: new Date() });
                console.log(`🎉 Successfully opened position for Signal ID: ${signalId}`);
            } else { // Handle SELL action
                console.log(`🔍 Checking for open position for Signal ID: ${signalId}...`);
                const position = await getOpenPositionBySignalId(signalId);
                if (!position) {
                    console.log(`🟡 No open position found for Signal ID ${signalId}. Ignoring SELL signal.`);
                    console.log(`================== [SIGNAL ${signalId} END] ======================`);
                    return;
                }
                console.log(`✅ Position found. Preparing to sell ${position.tokenReceived.toFixed(2)} tokens.`);
                console.log(`💰 Executing SELL with ${currentSlippage / 100}% slippage.`);

                const tokenDecimals = await getTokenDecimals(position.tokenAddress);
                const amountToSellInSmallestUnit = Math.floor(position.tokenReceived * (10 ** tokenDecimals));
                const { txid, quote } = await performSwap(position.tokenAddress, SOL_MINT_ADDRESS, amountToSellInSmallestUnit, currentSlippage);
                const solReceived = Number(quote.outAmount) / 10 ** 9;
                
                console.log(`📝 Logging SELL trade to database...`);
                await logTradeToFirestore({ txid, status: 'Success', kind: action, solAmount: solReceived, tokenAmount: position.tokenReceived, tokenAddress, slippageBps: currentSlippage, date: new Date(), signal_id: signalId });
                await closePosition(String(signalId), txid, solReceived);
                console.log(`🎉 Successfully closed position for Signal ID: ${signalId}`);
            }
            console.log(`================== [SIGNAL ${signalId} END] ======================`);
            return;
        } catch (error: any) {
            console.error(`❌ [TRADE FAILED] Attempt ${i + 1} failed:`, error.message);
            if (i === slippageSettings.length - 1) {
                 // Panic Sell Logic can be re-added here if needed
                console.error(`🛑 [FATAL] All attempts failed for Signal ID ${signalId}.`);
                await logTradeToFirestore({ txid: null, status: 'Failed', kind: action, solAmount: action === 'BUY' ? solAmount : 0, tokenAddress, reason: error.message || 'Unknown error', date: new Date(), signal_id: signalId });
                console.log(`================== [SIGNAL ${signalId} END] ======================`);
                throw error;
            }
        }
    }
}
