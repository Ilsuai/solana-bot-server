const { Connection, Keypair, VersionedTransaction, PublicKey } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const { getMint } = require('@solana/spl-token');
const dotenv = require('dotenv');
const { logTradeToFirestore, managePosition } = require('./firebaseAdmin');
const bs58 = require('bs58');

dotenv.config();
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY is missing from the .env file.");
const walletKeypair = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
const rpcUrl = process.env.SOLANA_RPC_ENDPOINT;
if (!rpcUrl) throw new Error("SOLANA_RPC_ENDPOINT is missing from the .env file.");
const connection = new Connection(rpcUrl, 'confirmed');
const jupiterApi = createJupiterApiClient({ basePath: "https://quote-api.jup.ag/v6" });

async function getPriorityFee(): Promise<number> {
  const minFee = 25000; const maxFee = 1000000;
  try {
    const fees = await connection.getRecentPrioritizationFees();
    if (fees.length === 0) return minFee;
    const recentFees = fees.map((f: any) => f.prioritizationFee).filter((f: number) => f <= maxFee);
    if (recentFees.length === 0) return minFee;
    recentFees.sort((a: number, b: number) => a - b);
    const p95 = recentFees[Math.floor(recentFees.length * 0.95)];
    const finalFee = Math.max(p95 + 1, minFee);
    console.log(`💸 [Fee] Aggressive fee: ${finalFee} microLamports`);
    return finalFee;
  } catch (error) { console.error("🛑 [Fee] Failed to get dynamic fee", error); return minFee; }
}

async function getTokenDecimals(mint: string): Promise<number> {
  if (mint === SOL_MINT) return 9;
  const mintPublicKey = new PublicKey(mint);
  const mintInfo = await getMint(connection, mintPublicKey);
  return mintInfo.decimals;
}

// --- THIS IS THE FIX ---
// Added the explicit "Promise<...>" return type to the function definition.
async function handleTradeSignal(signal: { token_address: string; action: string; amount_input: number; }): Promise<{ signature: string; quote: any; }> {
  const { token_address, action, amount_input } = signal;
  const slippageBps = 350; // 3.5%
  const isBuy = action.toUpperCase() === 'BUY';
  const inputMint = isBuy ? SOL_MINT : token_address;
  const outputMint = isBuy ? token_address : SOL_MINT;
  const inputDecimals = await getTokenDecimals(inputMint);
  const amountInSmallestUnits = Math.round(amount_input * (10 ** inputDecimals));
  if (amountInSmallestUnits <= 0) throw new Error(`Invalid amount: ${amount_input}`);
  console.log(`⚙️ [Executor] Starting ${action} trade for ${amount_input} of ${inputMint}`);
  
  const quote = await jupiterApi.quoteGet({
    inputMint, outputMint, amount: amountInSmallestUnits, slippageBps, onlyDirectRoutes: false,
  });
  if (!quote) throw new Error('Failed to get quote.');
  console.log('⚙️ [Executor] Got quote from Jupiter.');

  const { swapTransaction, lastValidBlockHeight } = await jupiterApi.swapPost({
    swapRequest: {
      quoteResponse: quote, userPublicKey: walletKeypair.publicKey.toBase58(),
      wrapUnwrapSol: true, computeUnitPriceMicroLamports: await getPriorityFee(),
    },
  });
  console.log('⚙️ [Executor] Received transaction from Jupiter.');
  
  const txBuffer = Buffer.from(swapTransaction, 'base64');
  let tx = VersionedTransaction.deserialize(txBuffer);
  tx.sign([walletKeypair]);
  console.log('⚙️ [Executor] Transaction signed. Sending...');
  
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
  await connection.confirmTransaction({
    blockhash: tx.message.recentBlockhash, lastValidBlockHeight, signature: sig,
  }, 'confirmed');
  console.log(`✅ [Executor] Trade Confirmed! Signature: ${sig}`);
  return { signature: sig, quote };
}

module.exports = {
  executeTrade: async function(tokenAddress: string, action: string, amountInput: number, signalData: any) {
    try {
      const { signature, quote } = await handleTradeSignal({
        token_address: tokenAddress, action, amount_input: amountInput,
      });
      await logTradeToFirestore({
        txid: signature, tokenAddress, solAmount: action === 'BUY' ? amountInput : null,
        action: action.toUpperCase(), date: new Date(), status: 'Success',
      });
      if (action.toUpperCase() === 'BUY') {
        const outDecimals = await getTokenDecimals(tokenAddress);
        const tokensReceived = parseInt(quote.outAmount) / (10 ** outDecimals);
        await managePosition({
          txid: signature, tokenAddress, tokenSymbol: signalData.token_symbol || 'Unknown',
          solAmount: amountInput, tokenAmount: tokensReceived, entryPrice: signalData.price_at_signal || 0,
          status: 'open', openedAt: new Date(), stopLossPrice: signalData.stop_loss_limit || 0,
        });
      }
    } catch (error: unknown) {
      let msg = "An unknown error occurred";
      if (error instanceof Error) msg = error.message;
      console.error(`\n❌ [TRADE FAILED]`, { message: msg, rawError: error });
      await logTradeToFirestore({
        tokenAddress, solAmount: action.toUpperCase() === 'BUY' ? amountInput : null,
        action: action.toUpperCase(), date: new Date(), status: 'Failed', error: msg,
      });
      throw error;
    }
  }
};