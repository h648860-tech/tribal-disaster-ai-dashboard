const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

function getFirebaseToken() {
  try {
    const userProfile = process.env.USERPROFILE || process.env.HOME;
    const configPath = path.join(userProfile, '.config', 'configstore', 'firebase-tools.json');
    if (!fs.existsSync(configPath)) {
      throw new Error(`Config file not found at ${configPath}`);
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!config.tokens || !config.tokens.refresh_token) {
      throw new Error("No refresh_token found in firebase-tools.json");
    }
    return {
      refreshToken: config.tokens.refresh_token,
      accessToken: config.tokens.access_token
    };
  } catch (err) {
    console.error("Failed to read firebase config:", err.message);
    process.exit(1);
  }
}

async function refreshAccessToken(refreshToken) {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return data.access_token;
  } catch (err) {
    console.error("Failed to refresh access token:", err.message);
    process.exit(1);
  }
}

async function getGeminiApiKey(accessToken, refreshToken) {
  let token = accessToken;
  const url = `https://firestore.googleapis.com/v1/projects/kaifang-management/databases/(default)/documents/settings/keys`;
  
  try {
    let res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.status === 401) {
      console.log("Access token expired. Refreshing...");
      token = await refreshAccessToken(refreshToken);
      res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
    }

    if (!res.ok) {
      throw new Error(`Firestore REST HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    if (!data.fields || !data.fields.geminiApiKey || !data.fields.geminiApiKey.stringValue) {
      throw new Error("geminiApiKey not found in settings/keys document");
    }
    return data.fields.geminiApiKey.stringValue;
  } catch (err) {
    console.error("Failed to fetch API key from Firestore:", err.message);
    process.exit(1);
  }
}

async function checkApi() {
  const tokens = getFirebaseToken();
  const geminiKey = await getGeminiApiKey(tokens.accessToken, tokens.refreshToken);
  
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
    
    await new Promise(resolve => setTimeout(resolve, 30000));
  }
}

checkApi();
