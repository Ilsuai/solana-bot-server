// server/firebaseAdmin.ts
import admin from "firebase-admin";

function initFirebaseAdmin() {
  if (admin.apps.length) return; // already initialized

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  try {
    if (json) {
      const cred = JSON.parse(json);
      admin.initializeApp({
        credential: admin.credential.cert(cred as admin.ServiceAccount),
      });
    } else if (b64) {
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      const cred = JSON.parse(decoded);
      admin.initializeApp({
        credential: admin.credential.cert(cred as admin.ServiceAccount),
      });
    } else {
      // Uses GOOGLE_APPLICATION_CREDENTIALS or GCP metadata if available
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
    }
  } catch (_e) {
    // Dev-only final fallback to a local file if present
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const local = require("./service-account-key.json");
    admin.initializeApp({
      credential: admin.credential.cert(local as admin.ServiceAccount),
    });
  }

  // Firestore quality-of-life setting
  try {
    admin.firestore().settings({ ignoreUndefinedProperties: true });
  } catch {
    // ignore if Firestore not used or settings already applied
  }
}

initFirebaseAdmin();

export default admin;
