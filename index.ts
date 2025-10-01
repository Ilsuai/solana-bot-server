import express, { Request, Response } from 'express';
import { executeTrade } from './tradeExecutor';
import { initializeFirebase } from './firebaseAdmin';

// --- Bot Startup Log ---
console.log("==================================================");
console.log("  Solana Trading Bot - Starting Up");
console.log("==================================================");

const rpcUrl = process.env.SOLANA_RPC_ENDPOINT;
if (rpcUrl) {
    try {
        const url = new URL(rpcUrl);
        console.log(`✅ CONNECTED TO RPC ENDPOINT: ${url.hostname}`);
    } catch (error) {
        console.error("❌ Invalid SOLANA_RPC_ENDPOINT URL format.");
    }
} else {
    console.log("❌ SOLANA_RPC_ENDPOINT environment variable not set!");
}
console.log("--------------------------------------------------");
// --- End of Startup Log ---

// Initialize Firebase Admin SDK
initializeFirebase();

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());

app.post('/nexagent-signal', async (req: Request, res: Response) => {
    const signalId = req.body.data?.signal_id;
    console.log(`\n================== [SIGNAL ${signalId || 'Unknown'} RECEIVED] ==================`);
    console.log(`Full Payload:`, JSON.stringify(req.body, null, 2));

    try {
        const payloadData = req.body.data;
        const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

        if (!payloadData || payloadData.transaction_type !== 'swap') {
            console.log(`❌ Validation Failed: Signal is not a valid swap transaction.`);
            return res.status(400).send('Invalid or unrecognized signal payload.');
        }

        let action: 'BUY' | 'SELL' | null = null;
        if (payloadData.input_mint === SOL_MINT_ADDRESS) {
            action = 'BUY';
        } else if (payloadData.output_mint === SOL_MINT_ADDRESS) {
            action = 'SELL';
        }

        const tokenAddress = action === 'BUY' ? payloadData.output_mint : payloadData.input_mint;
        
        // --- FIX IS HERE ---
        let solAmountForBuy: number | undefined;
        if (action === 'BUY') {
            solAmountForBuy = payloadData.input_amount;
        }

        // Updated validation logic
        if (!action || !tokenAddress || !signalId) {
             console.log(`❌ Validation Failed: Missing action, tokenAddress, or signalId.`);
             return res.status(400).send('Failed to extract necessary trade parameters from signal.');
        }
        if (action === 'BUY' && (!solAmountForBuy || solAmountForBuy <= 0)) {
            console.log(`❌ Validation Failed: Invalid input_amount for BUY signal.`);
            return res.status(400).send('Invalid input_amount for BUY signal.');
        }
        // --- END OF FIX ---

        const tokenSymbol = action === 'BUY' ? payloadData.output_symbol : payloadData.input_symbol;
        // For a BUY, use the real amount. For a SELL, the amount is not used by the executor, so we pass 0.
        const amountForExecutor = solAmountForBuy || 0; 
        console.log(`✅ Signal Validated: ${action} ${tokenSymbol || 'token'} (${tokenAddress.slice(0, 4)}...${tokenAddress.slice(-4)})`);

        executeTrade(tokenAddress, action, amountForExecutor, signalId).catch(error => {
            console.error(`CRITICAL ASYNC ERROR for Signal ${signalId}:`, error.message);
        });

        res.status(200).send('Webhook received and trade initiated.');

    } catch (error) {
        console.error(`A critical error occurred in the webhook handler for Signal ${signalId || 'Unknown'}:`, error);
        res.status(500).send('Internal server error.');
    }
});

app.get('/', (req, res) => {
  res.send('Solana Trading Bot Server is running!');
});

app.listen(port, () => {
    console.log(`✅ Server is running and listening on port ${port}`);
});