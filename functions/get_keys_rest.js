const fetch = require('node-fetch');

const firebaseApiKey = "AIzaSyDrnfqVrS156bXRED2mTM76krr3Lvr3Qyw";
const username = "kf19810529";
const password = "hh648860";
const email = `${username}@tribal.disaster.local`;

async function main() {
  try {
    const signInUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`;
    const signInRes = await fetch(signInUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        password: password,
        returnSecureToken: true
      })
    });
    
    if (!signInRes.ok) {
      const errText = await signInRes.text();
      throw new Error(`Sign in failed: ${errText}`);
    }
    
    const signInData = await signInRes.json();
    const idToken = signInData.idToken;
    
    const docUrl = `https://firestore.googleapis.com/v1/projects/kaifang-management/databases/(default)/documents/settings/keys`;
    const docRes = await fetch(docUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${idToken}`
      }
    });
    
    if (!docRes.ok) {
      const errText = await docRes.text();
      throw new Error(`Fetch doc failed: ${errText}`);
    }
    
    const docData = await docRes.json();
    const fields = docData.fields || {};
    const keys = {};
    for (let k in fields) {
      keys[k] = fields[k].stringValue;
    }
    console.log("KEYS_DATA:", JSON.stringify(keys));
    
  } catch (err) {
    console.error("ERROR:", err.message);
  }
}

main();
