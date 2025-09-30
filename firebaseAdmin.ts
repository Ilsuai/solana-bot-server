import admin from 'firebase-admin';

let db: admin.firestore.Firestore;

export function initializeFirebase() {
  try {
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
    await db.collection('trades').add(tradeData);
  } catch (error) {
    console.error('Failed to log trade:', error);
  }
}

export async function getBotSettings() {
  if (!db) return null;
  try {
    const doc = await db.collection('settings').doc('bot-settings').get();
    return doc.exists ? doc.data() : null;
  } catch (error) {
    console.error('Failed to fetch bot settings:', error);
    return null;
  }
}

export async function managePosition(positionData: any) {
  if (!db) return;
  try {
    await db.collection('positions').doc(positionData.txid).set(positionData, { merge: true });
  } catch (error) {
    console.error('Failed to manage position:', error);
  }
}

export async function getOpenPositionByToken(tokenAddress: string): Promise<any | null> {
  if (!db) return null;
  try {
    const snapshot = await db.collection('positions').where('tokenAddress', '==', tokenAddress).where('status', '==', 'open').limit(1).get();
    if (snapshot.empty) return null;
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
    await db.collection('positions').doc(docId).update({
      status: 'closed',
      sellPrice,
      closedAt: new Date(),
      deactivationReason: reason || 'Unknown'
    });
  } catch (error) {
    console.error(`Failed to close position ${docId}:`, error);
  }
}