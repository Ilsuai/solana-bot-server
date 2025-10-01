import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
} from '@solana/web3.js';
import {
  createJupiterApiClient,
  QuoteResponse,
} from '@jup-ag/api';
import { getMint } from '@solana/spl-token';
import { logTradeToFirestore, managePosition, getOpenPositionBySignalId, closePosition } from './firebaseAdmin';
import bs58 from 'bs58';

const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

if (!process.env.PRIVATE_KEY || !process.env.SOLANA_RPC_ENDPOINT) {
  throw new Error('Missing environment variables: PRIVATE_KEY and SOLANA_RPC_ENDPOINT are required.');
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
  slippageBps: number,
  isPanicSell: boolean = false
): Promise<{ txid: string; quote: QuoteResponse }> {
  console.log(`[Swap] Getting quote from Jupiter for Fastlane...`);

  const quote = await jupiterApi.quoteGet({
    inputMint,
    outputMint,
    amount,
    slippageBps,
    // @ts-ignore
    // This high priority fee is the trigger for the QuickNode Fastlane
    computeUnitPriceMicroLamports: 5_000_000, 
    asLegacyTransaction: false,
  });

  if (!quote) {
    throw new Error('Failed to get a quote from Jupiter.');
  }

  // ** REMOVED MANUAL JITO TIP **
  // The Fastlane add-on handles Jito routing automatically.
  const swapResult = await jupiterApi.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: walletKeypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    },
  });

  const swapTransactionBuf = Buffer.from(swapResult.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([walletKeypair]);

  const rawTransaction = transaction.serialize();
  
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  
  const txid = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: true,
    maxRetries: 5,
  });

  const confirmation = await connection.confirmTransaction(
    { 
      signature: txid, 
      blockhash: blockhash,
      lastValidBlockHeight: lastValidBlockHeight
    },
    'confirmed'
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  
  console.log(`✅ Swap successful! Transaction: https://solscan.io/tx/${txid}`);
  return { txid, quote };
}

// The 'executeTrade' function remains unchanged from the previous version.
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
            } else {
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
                 if (action === 'SELL') {
                    console.log(`\n--- [FINAL ATTEMPT - PANIC SELL] ---`);
                    try {
                        const position = await getOpenPositionBySignalId(signalId);
                        if (!position) throw new Error("Position not found for panic sell.");
                        const tokenDecimals = await getTokenDecimals(position.tokenAddress);
                        const amountToSellInSmallestUnit = Math.floor(position.tokenReceived * (10 ** tokenDecimals));
                        const { txid, quote } = await performSwap(position.tokenAddress, SOL_MINT_ADDRESS, amountToSellInSmallestUnit, 9000, true);
                        const solReceived = Number(quote.outAmount) / 10 ** 9;
                        await logTradeToFirestore({ txid, status: 'Success (Panic)', kind: action, solAmount: solReceived, tokenAmount: position.tokenReceived, tokenAddress, slippageBps: 9000, date: new Date(), signal_id: signalId });
                        await closePosition(String(signalId), txid, solReceived);
                        console.log(`🎉 Successfully PANIC SOLD and closed position for Signal ID: ${signalId}`);
                        console.log(`================== [SIGNAL ${signalId} END] ======================`);
                        return;
                    } catch (panicError: any) {
                        console.error(`🛑 [FATAL] PANIC SELL FAILED for Signal ID ${signalId}:`, panicError.message);
                    }
                }
                console.error(`🛑 [FATAL] All attempts failed for Signal ID ${signalId}.`);
                await logTradeToFirestore({ txid: null, status: 'Failed', kind: action, solAmount: action === 'BUY' ? solAmount : 0, tokenAddress, reason: error.message || 'Unknown error', date: new Date(), signal_id: signalId });
                console.log(`================== [SIGNAL ${signalId} END] ======================`);
                throw error;
            }
        }
    }
}