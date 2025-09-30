import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import dotenv from 'dotenv';
import { logTradeToFirestore, managePosition } from './firebaseAdmin';
import bs58 from 'bs58';

dotenv.config();

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY is missing from the .env file.");
const walletKeypair = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));

const rpcUrl = process.env.SOLANA_RPC_ENDPOINT;
if (!rpcUrl) throw new Error("SOLANA_RPC_ENDPOINT is missing from the .env file.");
const connection = new Connection(rpcUrl, "confirmed");

// Helper function to get token decimals
async function getTokenDecimals(mint: string): Promise<number> {
  if (mint === SOL_MINT) return 9;
  const mintPublicKey = new PublicKey(mint);
  const mintInfo = await getMint(connection, mintPublicKey);
  return mintInfo.decimals;
}

// Main exported function
module.exports = {
  executeTrade: async function(tokenAddress: string, action: string, amountInput: number, signalData: any): Promise<void> {
    try {
      const isBuy = action.toUpperCase() === 'BUY';
      const inputMint = isBuy ? SOL_MINT : tokenAddress;
      const outputMint = isBuy ? tokenAddress : SOL_MINT;

      const inputDecimals = await getTokenDecimals(inputMint);
      const amountInSmallestUnits = Math.round(amountInput * (10 ** inputDecimals));
      
      console.log(`⚙️ [Executor] Starting ${action} trade for ${amountInput} of ${inputMint}`);

      // 1. Get Quote using direct fetch
      console.log('⚙️ [Executor] Fetching quote from Jupiter API...');
      const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountInSmallestUnits}&slippageBps=1500`; // 15% slippage
      const quoteResponse = await fetch(quoteUrl);
      if (!quoteResponse.ok) {
        throw new Error(`Failed to get quote: ${await quoteResponse.text()}`);
      }
      const quote = await quoteResponse.json();

      // 2. Get Serialized Transaction using direct fetch
      console.log('⚙️ [Executor] Fetching swap transaction...');
      const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: walletKeypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
        })
      });

      if (!swapResponse.ok) {
        throw new Error(`Failed to get swap transaction: ${await swapResponse.text()}`);
      }
      const { swapTransaction, lastValidBlockHeight } = await swapResponse.json();

      // 3. Sign and Send Transaction
      const txBuffer = Buffer.from(swapTransaction, 'base64');
      let tx = VersionedTransaction.deserialize(txBuffer);
      tx.sign([walletKeypair]);
      console.log('⚙️ [Executor] Transaction signed. Sending...');

      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 5,
      });

      // 4. Confirm Transaction
      await connection.confirmTransaction({
        blockhash: tx.message.recentBlockhash,
        lastValidBlockHeight: lastValidBlockHeight,
        signature: signature,
      }, 'confirmed');
      console.log(`✅ [Executor] Trade Confirmed! Signature: ${signature}`);

      // 5. Log to Firestore
      await logTradeToFirestore({
        txid: signature, tokenAddress, solAmount: isBuy ? amountInput : null,
        action: action.toUpperCase(), date: new Date(), status: 'Success',
      });
      if (isBuy) {
        const outDecimals = await getTokenDecimals(outputMint);
        const tokensReceived = parseInt(quote.outAmount) / (10 ** outDecimals);
        await managePosition({
          txid: signature, tokenAddress, tokenSymbol: signalData.token_symbol || 'Unknown',
          solAmount: amountInput, tokenAmount: tokensReceived, entryPrice: signalData.price_at_signal || 0,
          status: 'open', openedAt: new Date(),
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