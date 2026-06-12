const admin = require('firebase-admin');
admin.initializeApp({
  projectId: "kaifang-management"
});
const db = admin.firestore();
db.collection('settings').doc('keys').get()
  .then(doc => {
    if (doc.exists) {
      console.log("KEYS_DATA:", JSON.stringify(doc.data()));
    } else {
      console.log("KEYS_DATA: Document settings/keys not found.");
    }
    process.exit(0);
  })
  .catch(err => {
    console.error("KEYS_ERROR:", err);
    process.exit(1);
  });
