const {initializeApp} = require('firebase-admin/app');
const {HttpsError, onCall} = require('firebase-functions/v2/https');

initializeApp();

const ADMIN_GOOGLE_EMAIL = 'listratenkoelena1@gmail.com';

function requireOwner(request) {
  const email = String(request.auth?.token?.email || '').trim().toLowerCase();
  const expectedEmail = ADMIN_GOOGLE_EMAIL;

  if (!request.auth || !email || email !== expectedEmail) {
    throw new HttpsError('permission-denied', 'Access is limited to the app owner.');
  }
}

// Safe connectivity check. The 1688 OAuth and order-sync functions will be
// added after the Alibaba application grants the buyer-order API permission.
exports.integrationStatus = onCall(
    {region: 'us-central1', minInstances: 0, maxInstances: 1},
    (request) => {
      requireOwner(request);
      return {
        googleAuth: 'ready',
        alibaba1688: 'waiting_for_app_credentials',
      };
    },
);
