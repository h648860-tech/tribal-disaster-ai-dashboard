const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp({
  projectId: "kaifang-management"
});
const db = admin.firestore();

async function checkApi() {
  try {
    const doc = await db.collection('settings').doc('keys').get();
    if (!doc.exists) {
      console.log("Error: keys document not found");
      process.exit(1);
    }
    const geminiKey = doc.data().geminiApiKey;
    if (!geminiKey) {
      console.log("Error: geminiApiKey is empty");
      process.exit(1);
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
    
    while (true) {
      try {
        console.log(`[${new Date().toISOString()}] Testing Gemini 2.5 Flash API...`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "ping" }] }]
          })
        });

        if (res.ok) {
          const data = await res.json();
          if (data.candidates && data.candidates[0].content.parts[0].text) {
            console.log("Gemini 2.5 Flash is back online!");
            process.exit(0);
          }
        } else {
          const status = res.status;
          const text = await res.text();
          console.log(`API returned status ${status}: ${text.substring(0, 150)}`);
        }
      } catch (err) {
        console.log(`Network or request error: ${err.message}`);
      }
      
      // Wait for 30 seconds before next check
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  } catch (err) {
    console.error("Initialization error:", err);
    process.exit(1);
  }
}

checkApi();
