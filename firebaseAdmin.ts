import admin from 'firebase-admin';

let db: admin.firestore.Firestore;

export function initializeFirebase() {
  try {
    // This logic allows the app to use the JSON file in local development
    // and an environment variable when deployed.
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON 
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
      : require('./service-account-key.json');

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

export async function logTradeToFirestore(tradeData: any) {
  if (!db) return;
  try {
    const tradeRef = await db.collection('trades').add(tradeData);
    console.log(`📝 Trade logged with ID: ${tradeRef.id}`);
  } catch (error) {
    console.error('Failed to log trade:', error);
  }
}

export async function getBotSettings() {
  if (!db) {
    console.error('Firestore is not initialized.');
    return null;
  }
  try {
    const settingsRef = db.collection('settings').doc('bot-settings');
    const doc = await settingsRef.get();
    if (!doc.exists) {
      console.log('No settings document found. Bot will be disabled by default.');
      return null;
    }
    return doc.data();
  } catch (error) {
    console.error('Failed to fetch bot settings:', error);
    return null;
  }
}

export async function managePosition(positionData: any) {
  if (!db) return;
  try {
    // Use the transaction ID as the document ID for easy lookup and to prevent duplicates
    const positionRef = db.collection('positions').doc(positionData.txid);
    await positionRef.set(positionData, { merge: true });
    console.log(`[Position] Managed position for tx: ${positionData.txid}`);
  } catch (error) {
    console.error('Failed to manage position:', error);
  }
}

export async function getOpenPositionByToken(tokenAddress: string): Promise<any | null> {
  if (!db) {
    console.error('Firestore is not initialized.');
    return null;
  }
  try {
    const positionsRef = db.collection('positions');
    const q = positionsRef.where('tokenAddress', '==', tokenAddress).where('status', '==', 'open').limit(1);
    const snapshot = await q.get();

    if (snapshot.empty) {
      return null;
    }
    
    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() };

  } catch (error) {
    console.error(`Failed to fetch open position for ${tokenAddress}:`, error);
    return null;
  }
}

export async function closePosition(docId: string, sellPrice: number, reason: string | null): Promise<void> {
  if (!db) return;
  try {
    const positionRef = db.collection('positions').doc(docId);
    await positionRef.update({
      status: 'closed',
      sellPrice: sellPrice,
      closedAt: new Date(),
      deactivationReason: reason || 'Unknown'
    });
    console.log(`[Position] Closed position with ID: ${docId}`);
  } catch (error) {
    console.error(`Failed to close position ${docId}:`, error);
  }
}