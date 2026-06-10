const functions = require('firebase-functions');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');

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


exports.onUserApprovedSendEmail = functions.firestore
    .document('users/{uid}')
    .onUpdate(async (change, context) => {
        const beforeData = change.before.data();
        const afterData = change.after.data();

        // 偵測是否從未通過變更為通過
        if (!beforeData.approved && afterData.approved) {
            const userEmail = afterData.email;
            const userName = afterData.username || '防災人員';

            if (!userEmail) {
                console.warn(`User ${context.params.uid} has no email configured. Skip sending email.`);
                return null;
            }

            // 1. 動態從 Firestore settings/keys 讀取 SMTP 帳密
            let smtpEmail = null;
            let smtpPassword = null;
            try {
                const keysDoc = await admin.firestore().collection('settings').doc('keys').get();
                if (keysDoc.exists) {
                    smtpEmail = keysDoc.data().smtpEmail || null;
                    smtpPassword = keysDoc.data().smtpPassword || null;
                }
            } catch (dbErr) {
                console.error('Failed to read SMTP keys from Firestore:', dbErr);
            }

            if (!smtpEmail || !smtpPassword) {
                console.warn('SMTP credentials (smtpEmail, smtpPassword) not configured in settings/keys. Aborting email send.');
                return null;
            }

            // 2. 建立 nodemailer transporter
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: smtpEmail,
                    pass: smtpPassword
                }
            });

            const mailOptions = {
                from: `凱芳防災協助系統 <${smtpEmail}>`,
                to: userEmail,
                subject: '【凱芳防災協助系統】帳號審核通過通知',
                html: `
                    <div style="font-family: 'Noto Sans TC', sans-serif, Arial; padding: 25px; line-height: 1.6; color: #1e293b; background-color: #f8fafc; border-radius: 12px; max-width: 600px; margin: auto; border: 1px solid #e2e8f0;">
                        <div style="text-align: center; margin-bottom: 20px;">
                            <h2 style="color: #06b6d4; margin: 0; font-size: 1.5rem;">凱芳防災協助系統</h2>
                            <p style="color: #64748b; font-size: 0.85rem; margin: 5px 0 0 0;">自主防災・智慧決策輔助平台</p>
                        </div>
                        <hr style="border: none; border-top: 1px solid #e2e8f0; margin-bottom: 20px;">
                        <p style="font-size: 1.05rem; font-weight: bold; margin-bottom: 15px;">您好，${userName}：</p>
                        <p style="margin-bottom: 15px;">您申請的「凱芳防災協助系統」帳號已成功通過系統管理員審核！</p>
                        <p style="margin-bottom: 25px;">您現在可以前往前台登入系統，查看風雨即時監測、調閱保全戶與避難收容資料，並使用 AI 助理進行決策協助。</p>
                        
                        <div style="text-align: center; margin-bottom: 30px;">
                            <a href="https://kaifang-management.web.app" style="background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%); color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block; box-shadow: 0 4px 10px rgba(6, 182, 212, 0.25);">
                                💻 立即前往系統登入
                            </a>
                        </div>
                        
                        <p style="font-size: 0.85rem; color: #64748b; margin-top: 30px;">
                            ※ 若您並未申請此帳號，請忽略本郵件。<br>
                            ※ 本郵件由系統自動發送，請勿直接回覆本信。
                        </p>
                        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0 15px 0;">
                        <div style="text-align: center; font-size: 0.75rem; color: #94a3b8;">
                            © 凱芳智能管理顧問企業社 版權所有
                        </div>
                    </div>
                `
            };

            try {
                await transporter.sendMail(mailOptions);
                console.log(`Successfully sent account approval notification email to ${userEmail}`);
            } catch (error) {
                console.error('Failed to send account approval email:', error);
            }
        }
        return null;
    });

