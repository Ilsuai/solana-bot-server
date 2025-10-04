// src/firebaseAdmin.ts

import admin from 'firebase-admin';

// The getFirestore function is imported from the top-level 'firebase-admin' package
let db: admin.firestore.Firestore;

export function initializeFirebase() {
  if (admin.apps.length) {
    db = admin.firestore();
    return;
  }
  try {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
      : require('../service-account-key.json'); // This is the corrected line

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log('✅ Firebase Admin SDK initialized successfully.');
  } catch (error) {
    console.error('🔥 FIREBASE INITIALIZATION FAILED:', error);
    process.exit(1);
  }
}

/**
 * Fetches the bot's operational status from Firestore.
 * @returns {Promise<'RUNNING' | 'PAUSED' | 'OFF'>} The current status of the bot.
 */
export async function getBotStatus(): Promise<'RUNNING' | 'PAUSED' | 'OFF'> {
  if (!db) {
    console.warn('[Firestore] DB not initialized, returning PAUSED status as a safeguard.');
    return 'PAUSED';
  }
  try {
    // CORRECT SYNTAX: Chain .collection() and .doc() from the db object
    const settingsRef = db.collection('settings').doc('bot-settings');
    const docSnap = await settingsRef.get(); // Use .get() on the reference

    if (docSnap.exists && docSnap.data()?.botStatus === 'RUNNING') {
      return 'RUNNING';
    }
    
    // Default to PAUSED if not explicitly running or document doesn't exist
    return 'PAUSED';
  } catch (error) {
    console.error('[Firestore] Error fetching bot status, defaulting to PAUSED:', error);
    return 'PAUSED';
  }
}

export async function logTradeToFirestore(tradeData: any) {
  if (!db) return;
  try {
    const dataWithTimestamp = { ...tradeData, timestamp: new Date() };
    await db.collection('trades').add(dataWithTimestamp);
  } catch (error) {
    console.error('Failed to log trade:', error);
  }
}

export async function managePosition(positionData: any) {
  if (!db) return;
  try {
    await db.collection('positions').doc(String(positionData.signal_id)).set(positionData, { merge: true });
  } catch (error) {
    console.error('Failed to manage position:', error);
  }
}

export async function getOpenPositionBySignalId(signalId: number): Promise<any | null> {
  if (!db) return null;
  try {
    const docRef = db.collection('positions').doc(String(signalId));
    const doc = await docRef.get();

    if (!doc.exists) {
      return null;
    }
    
    const position = doc.data();
    if (position && position.status === 'open') {
        return { id: doc.id, ...position };
    }
    
    return null;
  } catch (error) {
    console.error(`Failed to fetch open position for signal ID ${signalId}:`, error);
    return null;
  }
}

export async function closePosition(signalId: string, sellTxid: string, solReceived: number) {
  if (!db) return;
  try {
    const docRef = db.collection('positions').doc(signalId);
    await docRef.update({
      status: 'closed',
      exitTx: sellTxid,
      solReceived: solReceived,
      closedAt: new Date(),
    });
  } catch (error) {
    console.error(`Failed to close position ${signalId}:`, error);
  }
}