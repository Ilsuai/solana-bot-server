import express, { Request, Response } from 'express';
import { executeTrade } from './tradeExecutor';
import { initializeFirebase } from './firebaseAdmin';

// Initialize Firebase Admin SDK at the start
initializeFirebase();

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());

// The Webhook handler for NextGen AI signals
app.post('/nexagent-signal', async (req: Request, res: Response) => {
    const signalId = req.body.data?.signal_id || 'Unknown';
    console.log(`\n================== [SIGNAL ${signalId} RECEIVED] ==================`);
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
        const solAmount = action === 'BUY' ? payloadData.input_amount : payloadData.output_amount;
        
        if (!action || !tokenAddress || !solAmount || solAmount <= 0 || !signalId) {
            console.log(`❌ Validation Failed: Incomplete parameters.`);
            return res.status(400).send('Failed to extract necessary trade parameters from signal.');
        }

        const tokenSymbol = action === 'BUY' ? payloadData.output_symbol : payloadData.input_symbol;
        console.log(`✅ Signal Validated: ${action} ${solAmount.toFixed(4)} SOL for ${tokenSymbol} (${tokenAddress.slice(0, 4)}...${tokenAddress.slice(-4)})`);

        executeTrade(tokenAddress, action, solAmount, signalId).catch(error => {
            console.error(`CRITICAL ASYNC ERROR for Signal ${signalId}:`, error.message);
        });

        res.status(200).send('Webhook received and trade initiated.');

    } catch (error) {
        console.error(`A critical error occurred in the webhook handler for Signal ${signalId}:`, error);
        res.status(500).send('Internal server error.');
    }
});

app.get('/', (req, res) => {
  res.send('Solana Trading Bot Server is running!');
});

app.listen(port, () => {
    console.log(`✅ Server is running and listening on port ${port}`);
});