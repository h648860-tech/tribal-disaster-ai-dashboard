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

exports.geocode = functions.https.onRequest(async (req, res) => {
    // 啟用 CORS
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }

    if (req.method !== 'GET') {
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

    // 2. 獲取請求參數
    const { address } = req.query;
    if (!address) {
        return res.status(400).json({ error: 'Missing address parameter' });
    }

    // 3. 取得 TGOS API 金鑰 (優先讀取環境變數/config，若無則動態讀取 Firestore)
    let tgosAppId = process.env.TGOS_APP_ID || (functions.config().tgos ? functions.config().tgos.appid : null);
    let tgosApiKey = process.env.TGOS_API_KEY || (functions.config().tgos ? functions.config().tgos.key : null);

    if (!tgosAppId || !tgosApiKey) {
        try {
            const keysDoc = await admin.firestore().collection('settings').doc('keys').get();
            if (keysDoc.exists) {
                tgosAppId = keysDoc.data().tgosAppId || null;
                tgosApiKey = keysDoc.data().tgosApiKey || null;
            }
        } catch (dbErr) {
            console.error('Failed to read TGOS Keys from Firestore:', dbErr);
        }
    }

    if (!tgosAppId || !tgosApiKey) {
        console.warn('TGOS API keys not configured. Fallback required.');
        return res.status(200).json({ success: false, reason: 'TGOS keys not configured' });
    }

    // 4. 呼叫 TGOS API 進行 Geocoding 比對 (SRS 設定為 EPSG:4326 WGS84 經緯度)
    const url = `https://addr.tgos.tw/addrws/v30/QueryAddr.asmx/QueryAddr?oAPPId=${tgosAppId}&oAPIKey=${tgosApiKey}&oAddress=${encodeURIComponent(address)}&oSRS=EPSG:4326&oFuzzyType=2&oResultDataType=JSON`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TribalDisasterDashboard/1.0'
            }
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('TGOS API returned error:', response.status, errText);
            return res.status(200).json({ success: false, reason: `TGOS API error status ${response.status}` });
        }

        const rawData = await response.json();
        let data = rawData;
        if (typeof data === 'string') {
            data = JSON.parse(data);
        }

        if (data && data.AddressList && data.AddressList.length > 0) {
            const result = data.AddressList[0];
            return res.status(200).json({
                success: true,
                provider: 'TGOS',
                lat: parseFloat(result.Y),
                lng: parseFloat(result.X),
                formattedAddress: result.FULL_ADDR
            });
        }

        return res.status(200).json({ success: false, reason: 'Address not found' });
    } catch (err) {
        console.error('Failed to contact TGOS API:', err);
        return res.status(200).json({ success: false, reason: 'Failed to communicate with TGOS API' });
    }
});

