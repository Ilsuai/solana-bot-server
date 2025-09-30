import admin from 'firebase-admin';

let db: admin.firestore.Firestore;

export function initializeFirebase() {
  if (admin.apps.length) {
    db = admin.firestore();
    return;
  }
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

export async function managePosition(positionData: any) {
  if (!db) return;
  try {
    // Use signal_id as the document ID for easy lookup
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