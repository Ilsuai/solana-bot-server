import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { executeTrade } from './tradeExecutor';
import {
  initializeFirebase,
  getBotSettings,
  getOpenPositionByToken,
  closePosition
} from './firebaseAdmin';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

initializeFirebase();

app.use(cors());
app.use(express.json());

app.post('/nexagent-signal', async (req, res) => {
  console.log('Received signal:', req.body);

  if (!req.body.data || !req.body.data.token_address) {
    console.error('Invalid signal format. Missing data object or token_address.');
    return res.status(400).json({ error: 'Invalid signal payload: missing data.token_address' });
  }

  const settings = await getBotSettings();
  if (!settings || settings.botStatus !== 'RUNNING') {
    console.log(`Bot status is '${settings?.botStatus || 'OFF'}'. Ignoring signal.`);
    return res.status(200).json({ message: 'Signal ignored, bot is not running.' });
  }

  const signalData = req.body.data;
  const { token_address } = signalData;

  // Immediately acknowledge the signal to Nextgent AI
  res.status(200).json({ message: 'Signal received, processing trade.' });

  try {
    // Check our database for an existing open position for this token
    const openPosition = await getOpenPositionByToken(token_address);

    if (signalData.is_active === true) {
      // --- HANDLE BUY SIGNAL ---
      console.log(`[BUY SIGNAL] Received for ${token_address}`);
      
      // If a position already exists, ignore the signal to prevent double-buying.
      if (openPosition) {
        console.log(`[BUY IGNORED] An open position already exists for ${token_address}.`);
        return;
      }
      
      const amount_sol = settings.maxTradeSizeSol;
      if (!amount_sol || amount_sol <= 0) {
        console.log(`[BUY IGNORED] Invalid or zero maxTradeSizeSol configured in settings.`);
        return;
      }
      
      await executeTrade(token_address, 'BUY', amount_sol, signalData);

    } else if (signalData.is_active === false) {
      // --- HANDLE SELL SIGNAL ---
      console.log(`[SELL SIGNAL] Received for ${token_address}`);
      
      // If there's no open position to sell, ignore the signal.
      if (!openPosition) {
        console.log(`[SELL IGNORED] No open position found for ${token_address}.`);
        return;
      }

      if (!openPosition.tokenAmount || openPosition.tokenAmount <= 0) {
        console.log(`[SELL IGNORED] Position for ${token_address} has an invalid token amount.`);
        return;
      }
      
      await executeTrade(token_address, 'SELL', openPosition.tokenAmount, signalData);
      
      await closePosition(openPosition.id, signalData.price_at_signal, signalData.deactivationReason);
    }

  } catch (error: unknown) {
    let errorMessage = "An unknown error occurred in the signal handler.";
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    console.error(`[FATAL] Error processing signal for ${token_address}:`, errorMessage);
  }
});

app.listen(PORT, () => {
  console.log(`Bot server running on http://localhost:${PORT}`);
});