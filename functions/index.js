const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

admin.initializeApp();

exports.askGemini = functions.https.onRequest(async (req, res) => {
    // 啟用 CORS
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // 1. 驗證 Firebase Auth ID Token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing token' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
        await admin.auth().verifyIdToken(idToken);
    } catch (err) {
        console.error('Token verification failed:', err);
        return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }

    // 2. 獲取請求體參數
    const { contents, systemInstruction } = req.body;
    if (!contents) {
        return res.status(400).json({ error: 'Missing contents parameter' });
    }

    // 3. 取得 API 金鑰 (優先讀取環境變數/config，若無則動態讀取 Firestore 資料庫)
    let geminiKey = process.env.GEMINI_API_KEY || (functions.config().gemini ? functions.config().gemini.key : null);
    
    if (!geminiKey) {
        try {
            const keysDoc = await admin.firestore().collection('settings').doc('keys').get();
            if (keysDoc.exists) {
                geminiKey = keysDoc.data().geminiApiKey || null;
            }
        } catch (dbErr) {
            console.error('Failed to read Gemini Key from Firestore:', dbErr);
        }
    }

    if (!geminiKey) {
        console.error('Missing GEMINI_API_KEY in environment/config/Firestore');
        return res.status(500).json({ error: 'Internal Server Error: Missing Gemini API Key' });
    }

    // 4. 調用 Google Generative Language API
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ contents, systemInstruction })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('Gemini API returned error:', response.status, errText);
            return res.status(response.status).send(errText);
        }

        const data = await response.json();
        return res.status(200).json(data);
    } catch (err) {
        console.error('Failed to contact Gemini API:', err);
        return res.status(500).json({ error: 'Failed to communicate with Gemini API' });
    }
});
