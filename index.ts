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

        if (!payloadData || payloadData.transaction_type !== 'swap') {
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

        if (!action || !tokenAddress || !solAmount || solAmount <= 0) {
            return res.status(400).send('Failed to extract necessary trade parameters.');
        }

        console.log(`✅ Signal Validated: ${action} ${solAmount} SOL for token ${tokenAddress}`);

        executeTrade(tokenAddress, action, solAmount).catch(error => {
            console.error(`CRITICAL ERROR during async trade execution for ${tokenAddress}:`, error.message);
        });

        res.status(200).send('Webhook received and trade initiated.');

    } catch (error) {
        console.error("A critical error occurred in the webhook handler:", error);
        res.status(500).send('Internal server error.');
    }
});

app.get('/', (req, res) => {
  res.send('Solana Trading Bot Server is running!');
});

app.listen(port, () => {
    console.log(`✅ Server is running and listening on port ${port}`);
});