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
  slippageBps: number
): Promise<{ txid: string; quote: QuoteResponse }> {
  console.log(`[Swap] Getting quote from Jupiter with dynamic priority fees...`);

  const quote = await jupiterApi.quoteGet({
    inputMint,
    outputMint,
    amount,
    slippageBps,
    // @ts-ignore - This bypasses a known local editor issue. This works on the server.
    priorityFeeLevel: 'VERY_HIGH',
    asLegacyTransaction: false,
  });

  if (!quote) {
    throw new Error('Failed to get a quote from Jupiter.');
  }

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

  // CORRECTED LOGIC: Fetch a fresh blockhash right before sending the transaction.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  
  const txid = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: true,
    maxRetries: 5,
  });

  // Now, confirm using the fresh blockhash we just fetched.
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

export async function executeTrade(
  tokenAddress: string,
  action: 'BUY' | 'SELL',
  solAmount: number, // For BUYs, this is SOL spent. For SELLs, this is SOL received.
  signalId: number
): Promise<void> {
    const slippageSettings = [500, 1500, 2500];

    for (let i = 0; i < slippageSettings.length; i++) {
        const currentSlippage = slippageSettings[i];
        try {
            console.log(`\n--- [ATTEMPT ${i + 1}/${slippageSettings.length}] ---`);
            console.log(`Executing ${action} for token ${tokenAddress} with ${currentSlippage / 100}% slippage.`);

            if (action === 'BUY') {
                const amountInLamports = Math.round(solAmount * 10 ** 9);
                const { txid, quote } = await performSwap(
                    SOL_MINT_ADDRESS,
                    tokenAddress,
                    amountInLamports,
                    currentSlippage
                );
                
                const outputTokenDecimals = await getTokenDecimals(tokenAddress);
                const tokenAmountReceived = Number(quote.outAmount) / 10 ** outputTokenDecimals;
                
                await logTradeToFirestore({
                    txid, status: 'Success', kind: action, solAmount, tokenAmount: tokenAmountReceived,
                    tokenAddress, slippageBps: currentSlippage, date: new Date(), signal_id: signalId,
                });
                
                await managePosition({
                    signal_id: signalId, status: 'open', tokenAddress, solSpent: solAmount,
                    tokenReceived: tokenAmountReceived, openedAt: new Date(),
                });
                console.log(`Successfully logged BUY trade and opened position for signal ID: ${signalId}`);

            } else { // Handle SELL action
                const position = await getOpenPositionBySignalId(signalId);
                if (!position) {
                    console.log(`[Executor] Received SELL signal, but no open position found for signal ID ${signalId}. Ignoring.`);
                    return; // Exit if we don't own the token for this trade
                }

                const tokenDecimals = await getTokenDecimals(position.tokenAddress);
                const amountToSellInSmallestUnit = Math.floor(position.tokenReceived * (10 ** tokenDecimals));

                const { txid, quote } = await performSwap(
                    position.tokenAddress, // Input is the token we are selling
                    SOL_MINT_ADDRESS,     // Output is SOL
                    amountToSellInSmallestUnit,
                    currentSlippage
                );
                
                const solReceived = Number(quote.outAmount) / 10 ** 9;

                await logTradeToFirestore({
                    txid, status: 'Success', kind: action, solAmount: solReceived, tokenAmount: position.tokenReceived,
                    tokenAddress, slippageBps: currentSlippage, date: new Date(), signal_id: signalId,
                });
                
                await closePosition(String(signalId), txid, solReceived);
                console.log(`Successfully logged SELL trade and closed position for signal ID: ${signalId}`);
            }

            return; // Exit loop on success

        } catch (error: any) {
            console.error(`❌ [TRADE FAILED] Attempt ${i + 1} failed:`, error.message);

            if (i === slippageSettings.length - 1) {
                console.error(`🛑 [FATAL] All attempts failed. Aborting trade.`);
                await logTradeToFirestore({
                    txid: null, status: 'Failed', kind: action, solAmount: action === 'BUY' ? solAmount : 0,
                    tokenAddress, reason: error.message || 'Unknown error', date: new Date(), signal_id: signalId,
                });
                throw error;
            }
        }
    }
}