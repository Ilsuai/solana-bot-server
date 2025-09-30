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
    console.log('--- SIGNAL RECEIVED ---');
    console.log('Payload:', JSON.stringify(req.body, null, 2));

    try {
        const payloadData = req.body.data;
        const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

        // 1. Validate the payload structure
        if (!payloadData || payloadData.transaction_type !== 'swap') {
            console.log('❌ Validation Failed: Signal is not a valid swap transaction.');
            return res.status(400).send('Invalid or unrecognized signal payload.');
        }

        // 2. Determine the action (BUY or SELL)
        let action: 'BUY' | 'SELL' | null = null;
        if (payloadData.input_mint === SOL_MINT_ADDRESS) {
            action = 'BUY';
        } else if (payloadData.output_mint === SOL_MINT_ADDRESS) {
            action = 'SELL';
        }

        // 3. Extract trade parameters
        const tokenAddress = action === 'BUY' ? payloadData.output_mint : payloadData.input_mint;
        const solAmount = action === 'BUY' ? payloadData.input_amount : payloadData.output_amount;

        // 4. Final validation check
        if (!action || !tokenAddress || !solAmount || solAmount <= 0) {
            console.log(`❌ Validation Failed: Incomplete parameters. Action: ${action}, Token: ${tokenAddress}, Amount: ${solAmount}`);
            return res.status(400).send('Failed to extract necessary trade parameters from signal.');
        }

        console.log(`✅ Signal Validated: ${action} ${solAmount} SOL for token ${tokenAddress}`);

        // 5. Execute the trade asynchronously. This sends an immediate "OK" response
        // to the webhook service and processes the trade in the background.
        executeTrade(tokenAddress, action, solAmount).catch(error => {
            console.error(`CRITICAL ERROR during async trade execution for ${tokenAddress}:`, error.message);
        });

        res.status(200).send('Webhook received and trade initiated.');

    } catch (error) {
        console.error("A critical error occurred in the webhook handler:", error);
        res.status(500).send('Internal server error.');
    }
});

// Root endpoint for health checks
app.get('/', (req, res) => {
  res.send('Solana Trading Bot Server is running!');
});

app.listen(port, () => {
    console.log(`✅ Server is running and listening for signals on port ${port}`);
});