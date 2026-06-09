// Tribal Emergency AI Dashboard App Logic

const CURRENT_VERSION = "2.5.19";

// 去識別化工具函式 (全域作用域，供不同資料庫渲染名冊時共用)
function maskName(name) {
    if (!name) return "";
    const len = name.length;
    if (len <= 2) return name.charAt(0) + "*";
    if (len === 3) return name.charAt(0) + "*" + name.charAt(2);
    return name.charAt(0) + "*".repeat(len - 2) + name.charAt(len - 1);
}

function maskPhone(phone) {
    if (!phone) return "";
    const clean = phone.replace(/[-\s]/g, '');
    if (clean.length >= 9) {
        return phone.substring(0, 4) + "****" + phone.substring(8);
    }
    return phone.replace(/.(?=.{2})/g, '*');
}

function maskAddress(addr) {
    if (!addr) return "";
    let masked = addr.replace(/(?:[0-9]+|[一二三四五六七八九十]+)鄰/g, '*鄰');
    masked = masked.replace(/(?:[0-9]+(?:之[0-9]+)?|[一二三四五六七八九十百]+(?:之[一二三四五六七八九十百]+)?)號/g, '**號');
    return masked;
}


// 全台測站動態快取
let cwaCachedRainStations = [];
let cwaCachedWindStations = [];

// 全域測站選擇管理器
let stationPickerManager = {
    open: null
};

// 清理 URL 中的版本參數並重置防重載鎖
try {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('sys_v')) {
        const sysV = urlParams.get('sys_v');
        if (sysV === CURRENT_VERSION) {
            urlParams.delete('sys_v');
            const newSearch = urlParams.toString();
            const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
            window.history.replaceState({}, '', newUrl);
            localStorage.removeItem('last_reload_attempt_version');
            localStorage.removeItem('last_reload_attempt_count');
        }
    }
} catch (e) {
    console.warn("Clean URL parameters failed", e);
}

async function checkSystemVersion() {
    try {
        const res = await fetch(`version.json?t=${Date.now()}`);
        if (res.ok) {
            const data = await res.json();
            if (data.version && data.version !== CURRENT_VERSION) {
                console.log(`New version detected: ${data.version}. CURRENT_VERSION is ${CURRENT_VERSION}`);
                
                // 檢查是否最近已經嘗試重載過此版本
                const lastAttemptVersion = localStorage.getItem('last_reload_attempt_version');
                const attemptCount = parseInt(localStorage.getItem('last_reload_attempt_count') || '0', 10);
                
                if (lastAttemptVersion === data.version && attemptCount >= 1) {
                    console.warn(`Already attempted to reload for version ${data.version}. Aborting to prevent reload loop.`);
                    return;
                }
                
                // 記錄嘗試
                localStorage.setItem('last_reload_attempt_version', data.version);
                localStorage.setItem('last_reload_attempt_count', String(attemptCount + 1));
                
                // 使用帶有版本號的 URL 重定向，強制瀏覽器/iOS Web Clip 抓取最新 index.html 和 JS
                const currentUrl = new URL(window.location.href);
                currentUrl.searchParams.set('sys_v', data.version);
                window.location.replace(currentUrl.toString());
            } else {
                // 如果版本一致，清除重載嘗試記錄
                localStorage.removeItem('last_reload_attempt_version');
                localStorage.removeItem('last_reload_attempt_count');
            }
        }
    } catch (e) {
        console.warn("Version check failed", e);
    }
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        checkSystemVersion();
    }
});
setTimeout(checkSystemVersion, 15000);

// 全域 API 金鑰，自 Firebase Firestore 載入，取代本機快取以保安全
const globalApiKeys = {
    cwaApiKey: "",
    geminiApiKey: ""
};

// 達仁鄉各村落經緯度座標對照表 (用於 Windy 地圖定位)
const villageCoordinates = {
    "南興村": { lat: 22.385800, lng: 120.892700 },
    "安朔村": { lat: 22.302300, lng: 120.887600 },
    "森永村": { lat: 22.271100, lng: 120.875300 },
    "土坂村": { lat: 22.454900, lng: 120.875900 },
    "台坂村": { lat: 22.463200, lng: 120.889100 },
    "新化村": { lat: 22.381500, lng: 120.849600 }
};

let db = null;
let auth = null;
let isCreatingUserDoc = false;
let currentUserVillage = "南興村";

document.addEventListener('DOMContentLoaded', () => {
    initSplashScreen(); // 優先初始化迎賓動畫
    initClock();
    
    // 初始化 Firebase
    if (typeof firebase !== 'undefined' && typeof firebaseConfig !== 'undefined') {
        firebase.initializeApp(firebaseConfig);
        db = firebase.firestore();
        auth = firebase.auth();
        auth.setPersistence(firebase.auth.Auth.Persistence.NONE).catch(e => console.error("Persistence NONE failed:", e));
        initAuthSystem(); // 載入登入與權限管理核心
    } else {
        console.error("Firebase SDK 或 firebase-config.js 載入失敗！");
        alert("系統連線錯誤：無法載入 Firebase 設定，請確認設定檔是否正確。");
    }

    // 這些前台小組件維持初始化，但其 API 呼叫會依賴後續登入成功後載入的金鑰
    initOfflineAICopilot();
    initWarningSystem();
    initSatelliteMap();
    initCctvMonitor();
    initTyphoonData();
    initLocationPositioning();
    initOfflineTemplateSystem();
    initResidentsDatabase();
    initSheltersDatabase();
    initRainfallGaugeSystem();
});

// 全域彈跳視窗滾動鎖定輔助函式
function toggleBodyScroll(lock) {
    if (lock) {
        document.body.classList.add('modal-open');
    } else {
        setTimeout(() => {
            const activeModals = document.querySelectorAll('.modal.active');
            const splash = document.getElementById('splashScreen');
            const authScreen = document.getElementById('authScreen');
            
            // 檢查迎賓畫面是否還在 (未淡出且 display 不為 none)
            const isSplashActive = splash && !splash.classList.contains('fade-out') && splash.style.display !== 'none';
            
            // 檢查登入畫面是否還在 (未淡出)
            const isAuthActive = authScreen && !authScreen.classList.contains('fade-out');
            
            // 只有當所有 Modal、迎賓頁、登入頁都關閉時，才解鎖滾動
            if (activeModals.length === 0 && !isSplashActive && !isAuthActive) {
                document.body.classList.remove('modal-open');
            }
        }, 50);
    }
}

// 0. SPLASH SCREEN WELCOME CONTROLLER
function initSplashScreen() {
    const splash = document.getElementById('splashScreen');
    if (!splash) return;

    // 停留 4.0 秒後啟動淡出，淡出過渡時間 2.0 秒（CSS 定義）
    setTimeout(() => {
        splash.classList.add('fade-out');
        // 淡出完成後徹底 display: none，避免阻擋點擊（2 秒淡出時間）
        setTimeout(() => {
            splash.style.display = 'none';
            toggleBodyScroll(false);
        }, 2000);
    }, 4000);
}

// 1. SYSTEM CLOCK
function initClock() {
    const timeEl = document.getElementById('systemTime');
    function updateClock() {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        timeEl.textContent = `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
    }
    updateClock();
    setInterval(updateClock, 1000);
}

// Dynamic Network & AI active mode badge updater (Live WAN connection check)
function updateNetworkStatus() {
    const wanStatus = document.getElementById('wanStatus');
    const aiModeBadge = document.getElementById('aiModeBadge');
    const satelliteImg = document.getElementById('satelliteImg');
    const satelliteFallback = document.getElementById('satelliteFallback');
    
    const hasGeminiKey = globalApiKeys.geminiApiKey;
    const isOnline = navigator.onLine;
    
    // 1. Update live WAN connectivity UI
    if (wanStatus) {
        if (isOnline) {
            wanStatus.className = 'badge wan-status online badge-sm';
            wanStatus.innerHTML = `
                <svg class="icon animate-pulse" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 12 10 10-4.48 10-12S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                聯外網路：已連線 (LIVE-ONLINE)
            `;
            
            // Show interactive Windy iframe, hide local sweep radar
            if (satelliteImg) satelliteImg.style.display = 'block';
            if (satelliteFallback) satelliteFallback.style.display = 'none';
        } else {
            wanStatus.className = 'badge wan-status offline badge-sm';
            wanStatus.innerHTML = `
                <svg class="icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 3c-4.97 0-9 4.03-9 9 0 2.12.74 4.07 1.97 5.61L4.35 19.4c-1.46-1.92-2.35-4.31-2.35-6.9 0-6.35 5.15-11.5 11.5-11.5 2.59 0 4.98.89 6.9 2.35l-1.79 1.79C17.07 3.74 15.12 3 12 3zm9.65 1.41l-1.41-1.41L3.35 19.88l1.41 1.41 2.94-2.94c1.33.67 2.82 1.05 4.3 1.05 6.35 0 11.5-5.15 11.5-11.5 0-1.48-.38-2.97-1.05-4.3l2.94-2.94zM12 21c-2.12 0-4.07-.74-5.61-1.97l1.79-1.79c.98.48 2.08.76 3.22.76 4.97 0 9-4.03 9-9 0-1.14-.28-2.24-.76-3.22l1.79-1.79c1.23 1.54 1.97 3.49 1.97 5.61 0 6.35-5.15 11.5-11.5 11.5z"/></svg>
                聯外網路：斷線 (OFFLINE)
            `;
            
            // Hide Windy iframe (would show browser error page offline), show tech fallback radar
            if (satelliteImg) satelliteImg.style.display = 'none';
            if (satelliteFallback) {
                satelliteFallback.style.display = 'flex';
                satelliteFallback.style.opacity = '1';
            }
        }
    }

    // 2. Update AI active mode badge
    if (aiModeBadge) {
        const hasCloudCapability = isOnline;
        if (hasCloudCapability) {
            aiModeBadge.textContent = "CLOUD MODEL";
            aiModeBadge.style.background = "rgba(6, 182, 212, 0.15)";
            aiModeBadge.style.color = "var(--color-cyan)";
            aiModeBadge.style.borderColor = "var(--color-cyan)";
        } else {
            aiModeBadge.textContent = "LOCAL MODEL";
            aiModeBadge.style.background = "rgba(224, 122, 95, 0.12)";
            aiModeBadge.style.color = "var(--color-accent)";
            aiModeBadge.style.borderColor = "rgba(224, 122, 95, 0.25)";
        }
    }

    // 3. Update AI Copilot welcome messages based on connectivity
    const aiSystemInstruction = document.getElementById('aiSystemInstruction');
    const aiWelcomeMessage = document.getElementById('aiWelcomeMessage');
    
    if (isOnline) {
        if (aiSystemInstruction) {
            aiSystemInstruction.textContent = "系統指示：目前AI助理在線上中，可以為指揮官服務。";
        }
        if (aiWelcomeMessage) {
            aiWelcomeMessage.textContent = "您好，AI助理在線上中，隨時為指揮官您服務";
        }
    } else {
        if (aiSystemInstruction) {
            aiSystemInstruction.textContent = "系統指示：當前已進入「離線模式」，AI 已切換至本地資料庫，可調用資料庫內預設資料解答問題。";
        }
        if (aiWelcomeMessage) {
            aiWelcomeMessage.textContent = "您好，我是部落防災 AI 協助系統的智慧助理。目前外部網路已中斷，但我擁有完整的本地防災知識庫、緊急救護指南以及族語廣播生成工具。請隨時向我提問或點選下方快捷問題";
        }
    }
}

// Watch network status
window.addEventListener('online', updateNetworkStatus);
window.addEventListener('offline', updateNetworkStatus);

// 2. OFFLINE AI COPILOT CHATBOT
const knowledgeBase = {
    "溪水": `### 🚨 溪水混濁與山鳴應變指南 (離線知識庫)

當觀測到溪水變混濁，且聽到類似直升機或火車開過的沉悶轟鳴聲（山鳴）時：

1. **立即啟動疏散**：這代表上游已被土石流堵塞並開始潰決，逃生時間僅剩 **3 至 5 分鐘**。
2. **避難方向**：務必往**垂直溪流方向的兩側高處**撤離，絕對不可順著溪谷往下游跑。
3. **通知鄰近住戶**：特別是居住於扇狀地出水口的長者，立即引導至高地避難所。`,
    
    "南興村": `### 🗣️ 南興村國語緊急撤離廣播詞

以下已為您生成南興村專用的國語緊急避難廣播詞：

> 「各位南興村的村民請注意，現在雨勢非常猛烈，溪水暴漲且土石流預警已達警戒指標。為了大家的安全，請即刻停止所有戶外與農事活動，配合南興村自主防災編組的引導，攜帶隨身貴重物品與避難包，迅速前往南興村避難收容所撤離避難！重複一次，請立刻前往收容所避難！」`,
    
    "發電機": `### ⚙️ 部落柴油發電機故障基本排查 (離線指南)

若斷電時發電機無法起動，請依序進行以下 4 步排查：

1. **油路檢查**：確認柴油箱開關已打開，並檢查機油高度（若低於油尺刻度，發電機內建安全閥會強制斷火）。
2. **電瓶電壓**：檢查啟動馬達是否有「喀喀」的無力聲。如果是電瓶沒電，可用救車線連接避難所發電車電瓶。
3. **空氣釋放 (Bleeding)**：如果曾有乾油耗盡的狀況，柴油管路可能吸入空氣。需鬆開油路排氣螺絲，手動泵油直到無氣泡排出。
4. **空氣濾清器**：在潮濕暴雨環境，濾網可能吸飽水導致進氣阻塞，可嘗試暫時拆下濾網發動看看。`,
    
    "落石": `### 🩹 創傷急救處置：落石砸傷出血

現場無醫生時，請按以下步驟急救：

1. **施加直接加壓**：使用急救包內的無菌紗布，直接覆蓋傷口並雙手用力下壓 **5-10分鐘**，這是最有效的止血法。
2. **抬高患處**：如果傷口在四肢，且未發生骨折，將患肢抬高至心臟高度以上。
3. **固定包紮**：止血後，用彈性繃帶做八字包紮，注意不可過緊（確認指尖仍呈粉紅色、有溫度）。
4. **預防休克**：讓患者平躺，雙腳抬高 30 公分，覆蓋毛毯保暖，並持續安撫其情緒。`
};

function initOfflineAICopilot() {
    const chatContainer = document.getElementById('chatContainer');
    const chatInput = document.getElementById('chatInput');
    const btnSend = document.getElementById('btnSend');
    const btnVoiceInput = document.getElementById('btnVoiceInput');

    // Update active badge status at startup
    updateNetworkStatus();

    function appendMessage(sender, text, isUser = false) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${isUser ? 'user-msg' : 'bot-msg'}`;
        
        const authorDiv = document.createElement('div');
        authorDiv.className = 'msg-author';
        authorDiv.textContent = sender;
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'msg-content';
        contentDiv.innerHTML = parseMarkdown(text);
        
        msgDiv.appendChild(authorDiv);
        msgDiv.appendChild(contentDiv);
        
        chatContainer.appendChild(msgDiv);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function handleUserInput() {
        const text = chatInput.value.trim();
        if (!text) return;

        appendMessage('指揮官', text, true);
        chatInput.value = '';

        const isOnline = navigator.onLine;

        // Add simulated typing indicator / loading state
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'message bot-msg animate-pulse';
        loadingDiv.innerHTML = `<div class="msg-author">AI 減災助理</div><div class="msg-content">${isOnline ? '正在進行雲端 LLM 推理 (Gemini 2.5 Flash)...' : '正在本機進行語義檢索與推理 (Local Inference)...'}</div>`;
        chatContainer.appendChild(loadingDiv);
        chatContainer.scrollTop = chatContainer.scrollHeight;

        if (isOnline) {
            // Cloud Gemini API Mode (透過 Cloud Function 代理)
            const url = `/api/askGemini`;
            const systemInstructionText = "你目前扮演的是部落防災協助系統的 AI 減災助理。你精通部落（特別是台東南興村）的防災、減災與緊急撤離引導。你的回答必須使用繁體中文、簡潔、具行動導向，並適時格式化為容易閱讀的 Markdown。若用戶詢問南興村國語廣播詞，請提供貼近在地且口吻專業的廣播詞對照。";
            
            (async () => {
                try {
                    let token = "";
                    if (auth && auth.currentUser) {
                        token = await auth.currentUser.getIdToken();
                    }

                    const res = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({
                            contents: [{
                                parts: [{ text: text }]
                            }],
                            systemInstruction: {
                                parts: [{ text: systemInstructionText }]
                            }
                        })
                    });

                    if (!res.ok) {
                        let errMsg = `HTTP ${res.status}`;
                        try {
                            const errText = await res.text();
                            if (errText) {
                                try {
                                    const errJson = JSON.parse(errText);
                                    if (errJson.error) {
                                        errMsg = typeof errJson.error === 'object' && errJson.error.message 
                                            ? errJson.error.message 
                                            : errJson.error;
                                    }
                                } catch (_) {
                                    errMsg = `${errMsg}: ${errText}`;
                                }
                            }
                        } catch (_) {}
                        throw new Error(errMsg);
                    }

                    const data = await res.json();
                    loadingDiv.remove();
                    let reply = "";
                    try {
                        reply = data.candidates[0].content.parts[0].text;
                    } catch (e) {
                        reply = "⚠️ API 回傳格式解析錯誤。已切換為本地模擬回答。";
                        console.error("Gemini Response parsing error:", e, data);
                        fallbackLocalSearch(text);
                        return;
                    }
                    appendMessage('AI 減災助理', reply);

                } catch (err) {
                    console.error("Gemini API call failed:", err);
                    loadingDiv.remove();
                    
                    // Fallback warning message
                    const fallbackLoading = document.createElement('div');
                    fallbackLoading.className = 'message bot-msg';
                    fallbackLoading.innerHTML = `<div class="msg-author">AI 減災助理</div><div class="msg-content">⚠️ 雲端 API 連線失敗 (${err.message})，將啟用本機離線知識庫...</div>`;
                    chatContainer.appendChild(fallbackLoading);
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                    
                    setTimeout(() => {
                        fallbackLoading.remove();
                        fallbackLocalSearch(text, err.message);
                    }, 3000);
                }
            })();
        } else {
            // Local Offline Mode
            setTimeout(() => {
                loadingDiv.remove();
                fallbackLocalSearch(text);
            }, 1200);
        }
    }

    function fallbackLocalSearch(text, failedReason = null) {
        let response = "";
        let matched = false;
        
        // 優先比對自訂離線模板
        try {
            const saved = localStorage.getItem('custom_knowledge_base');
            if (saved) {
                const customKB = JSON.parse(saved);
                for (let key in customKB) {
                    if (text.includes(key)) {
                        response = customKB[key];
                        matched = true;
                        break;
                    }
                }
            }
        } catch (e) {
            console.error("載入自訂離線知識庫錯誤:", e);
        }

        // 若無匹配則比對預設知識庫
        if (!matched) {
            for (let key in knowledgeBase) {
                if (text.includes(key)) {
                    response = knowledgeBase[key];
                    matched = true;
                    break;
                }
            }
        }

        if (!matched) {
            response = `### ℹ️ 離線 AI 搜尋完成

我已檢索部落本地知識庫，未找到針對「**${text}**」的專門手冊。

在目前的預警警戒下，建議採取以下通用安全守則：
1. 保持發電機與衛星電話（若有）的電力儲備。
2. 密切關注山豬窟的雨量告警面板（當雨量破 300mm 或 450mm 將自動聯動警報色）。
3. 土石流潛勢區居民請優先移往避難所收容。`;
        }

        if (failedReason) {
            response = `<blockquote>⚠️ <strong>系統提示：</strong>雲端 API 連線失敗 (${failedReason})，系統已自動啟用本機備援知識庫.</blockquote>\n\n` + response;
        }

        appendMessage('AI 減災助理', response);
    }

    // Markdown Parser utility
    function parseMarkdown(text) {
        let html = text;
        // Parse Headings
        html = html.replace(/^### (.*$)/gim, '<h4>$1</h4>');
        html = html.replace(/^## (.*$)/gim, '<h3>$1</h3>');
        html = html.replace(/^# (.*$)/gim, '<h2>$1</h2>');
        // Parse bold
        html = html.replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>');
        // Parse blockquote
        html = html.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');
        // Parse list items
        html = html.replace(/^\* (.*$)/gim, '<li>$1</li>');
        html = html.replace(/^\d+\. (.*$)/gim, '<li>$1</li>');
        // Wrap lists
        if (html.includes('<li>')) {
            html = html.replace(/(<li>.*<\/li>)/gim, '<ul>$1</ul>');
        }
        return html;
    }

    btnSend.addEventListener('click', handleUserInput);
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleUserInput();
    });

    // Web Speech API 語音輸入聽寫
    let recognition = null;
    let isRecording = false;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.lang = 'zh-TW';
        recognition.interimResults = false;

        recognition.onstart = () => {
            isRecording = true;
            if (btnVoiceInput) {
                btnVoiceInput.classList.add('btn-voice-active');
                btnVoiceInput.innerHTML = "🛑";
                chatInput.placeholder = "聆聽中，請開始說話...";
            }
        };

        recognition.onend = () => {
            isRecording = false;
            if (btnVoiceInput) {
                btnVoiceInput.classList.remove('btn-voice-active');
                btnVoiceInput.innerHTML = "🎙️";
                chatInput.placeholder = "請輸入您的防災問題...";
            }
        };

        recognition.onresult = (event) => {
            const resultText = event.results[0][0].transcript;
            if (resultText && chatInput) {
                chatInput.value = resultText;
                handleUserInput(); // 聽寫完成直接發送
            }
        };

        recognition.onerror = (event) => {
            console.error("Speech recognition error:", event.error);
            if (event.error === 'not-allowed') {
                alert("⚠️ 語音輸入失敗：麥克風存取權限被拒絕。請於瀏覽器設定中允許麥克風權限。");
            } else if (event.error === 'no-speech') {
                // quiet ignore
            } else {
                alert(`⚠️ 語音聽寫出錯：${event.error}`);
            }
        };

        if (btnVoiceInput) {
            btnVoiceInput.addEventListener('click', () => {
                if (isRecording) {
                    recognition.stop();
                } else {
                    recognition.start();
                }
            });
        }
    } else {
        if (btnVoiceInput) {
            btnVoiceInput.addEventListener('click', () => {
                alert("⚠️ 您的瀏覽器不支援內建語音辨識 (Web Speech API)，請改用 Chrome 或 Safari。");
            });
        }
    }

    // 離線 SOP 快速呼叫下拉選單連動
    const sopQuickSelect = document.getElementById('sopQuickSelect');
    function updateSopQuickSelect() {
        if (!sopQuickSelect) return;
        
        let customKB = {};
        try {
            const saved = localStorage.getItem('custom_knowledge_base');
            if (saved) customKB = JSON.parse(saved);
        } catch (e) {
            console.error(e);
        }
        
        const keys = Object.keys(customKB);
        let optionsHtml = `<option value="">-- 選擇已儲存之 SOP --</option>`;
        if (keys.length > 0) {
            keys.forEach(k => {
                optionsHtml += `<option value="${k}">🚨 SOP：${k}</option>`;
            });
        }
        sopQuickSelect.innerHTML = optionsHtml;
    }
    
    // 初始化呼叫
    updateSopQuickSelect();
    
    // 導出至全域，供 SOP 編輯管理 Modal 儲存或刪除時呼叫更新
    window.updateSopQuickSelect = updateSopQuickSelect;

    if (sopQuickSelect) {
        sopQuickSelect.addEventListener('change', () => {
            const val = sopQuickSelect.value;
            if (!val) return;
            
            let customKB = {};
            try {
                const saved = localStorage.getItem('custom_knowledge_base');
                if (saved) customKB = JSON.parse(saved);
            } catch (e) {
                console.error(e);
            }
            
            const content = customKB[val];
            if (content) {
                // 於 Chat 中模擬發送呼叫 SOP 訊息
                appendMessage('指揮官', `快速呼叫：【${val}】`, true);
                
                // 模擬系統立即回覆該 SOP 內容
                setTimeout(() => {
                    appendMessage('AI 減災助理', content);
                }, 300);
            }
            
            // 重置選單
            sopQuickSelect.value = "";
        });
    }
}

// 3. WARNING ALERT SYSTEM (Rainfall monitor & alert sync with sound)
let audioCtx = null;
let oscillator = null;
let gainNode = null;
let isAlarmPlaying = false;
let alarmIntervalId = null;
let hasBeenSilenced = false; // Prevents alarm from repeatedly starting after being manually muted

function playEmergencyAlarm() {
    if (isAlarmPlaying) return;
    isAlarmPlaying = true;
    
    // Unlock and light up button
    const btnSilenceAlarm = document.getElementById('btnSilenceAlarm');
    if (btnSilenceAlarm) {
        btnSilenceAlarm.disabled = false;
        btnSilenceAlarm.classList.add('alarm-active');
        btnSilenceAlarm.innerHTML = "🔕 關閉警報音";
    }

    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        oscillator = audioCtx.createOscillator();
        gainNode = audioCtx.createGain();

        oscillator.type = 'sawtooth'; // Sirens pierce best with sawtooth
        oscillator.frequency.setValueAtTime(450, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime);

        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.start();

        // Alternate frequencies to create siren wailing effect (650Hz <-> 450Hz)
        let toggle = false;
        alarmIntervalId = setInterval(() => {
            if (!audioCtx || audioCtx.state === 'closed') return;
            const targetFreq = toggle ? 650 : 450;
            oscillator.frequency.exponentialRampToValueAtTime(targetFreq, audioCtx.currentTime + 0.45);
            toggle = !toggle;
        }, 500);
    } catch (e) {
        console.error("Web Audio Context failure:", e);
    }
}

function silenceEmergencyAlarm() {
    if (!isAlarmPlaying) return;
    isAlarmPlaying = false;

    // Reset button
    const btnSilenceAlarm = document.getElementById('btnSilenceAlarm');
    if (btnSilenceAlarm) {
        btnSilenceAlarm.disabled = true;
        btnSilenceAlarm.classList.remove('alarm-active');
        btnSilenceAlarm.innerHTML = "🔇 警報音已關閉";
    }

    if (alarmIntervalId) {
        clearInterval(alarmIntervalId);
        alarmIntervalId = null;
    }

    if (oscillator) {
        try {
            oscillator.stop();
        } catch(e){}
        oscillator = null;
    }

    if (audioCtx) {
        try {
            audioCtx.close();
        } catch(e){}
        audioCtx = null;
    }
}

function initWarningSystem() {
    const btnWarningRefresh = document.getElementById('btnWarningRefresh');
    const warningTimeText = document.getElementById('warningTimeText');
    const btnSilenceAlarm = document.getElementById('btnSilenceAlarm');
    const btnSelectAlertStation = document.getElementById('btnSelectAlertStation');
    
    const btnSimSafe = document.getElementById('btnSimSafe');
    const btnSimYellow = document.getElementById('btnSimYellow');
    const btnSimRed = document.getElementById('btnSimRed');

    let countdownSeconds = 3600;
    let timerId = null;
    let isSimulationMode = false;

    // 載入 localStorage 警報測站，預設為 C0S990|山豬窟
    let savedAlertStation = localStorage.getItem('alertStation') || "C0S990|山豬窟";
    if (savedAlertStation.startsWith("C0AC40")) {
        savedAlertStation = "C0S990|山豬窟";
        localStorage.setItem('alertStation', savedAlertStation);
    }
    
    function updateAlertStationButtonText() {
        if (!btnSelectAlertStation) return;
        const [stationId, stationName] = savedAlertStation.split('|');
        btnSelectAlertStation.textContent = `${stationName} (${stationId})`;
    }
    updateAlertStationButtonText();
    
    if (btnSelectAlertStation) {
        btnSelectAlertStation.addEventListener('click', () => {
            if (typeof stationPickerManager.open === 'function') {
                const stations = cwaCachedRainStations.length > 0 ? cwaCachedRainStations : [
                    { id: "C0S990", name: "山豬窟", county: "臺東縣" },
                    { id: "467540", name: "大武", county: "臺東縣" },
                    { id: "C0S840", name: "南田", county: "臺東縣" },
                    { id: "C0SA80", name: "土阪", county: "臺東縣" },
                    { id: "C0SA90", name: "達仁林場", county: "臺東縣" }
                ];
                stationPickerManager.open('alert', savedAlertStation, "📡 選擇監控觀測站", stations, (finalVal) => {
                    savedAlertStation = finalVal;
                    localStorage.setItem('alertStation', finalVal);
                    updateAlertStationButtonText();
                    fetchRainfallData();
                });
            }
        });
    }

    // Start timer countdown loop
    function startTimer() {
        if (timerId) clearInterval(timerId);
        isSimulationMode = false;
        timerId = setInterval(() => {
            countdownSeconds--;
            if (countdownSeconds <= 0) {
                countdownSeconds = 3600;
                fetchRainfallData();
            }
            updateTimerDisplay();
        }, 1000);
    }

    function updateTimerDisplay() {
        if (isSimulationMode) {
            warningTimeText.innerHTML = `<span style="color: var(--color-warning); font-weight: 700;">⚠️ 測試模式中 (自動更新已暫停)</span>`;
            return;
        }
        const mins = Math.floor(countdownSeconds / 60);
        const secs = countdownSeconds % 60;
        warningTimeText.textContent = `下次自動更新：${mins} 分 ${secs} 秒`;
    }

    async function fetchRainfallData() {
        const apiKey = globalApiKeys.cwaApiKey || "";
        const [stationId, stationName] = savedAlertStation.split('|');
        
        // 更新 UI 標題
        const warningRainLbl = document.getElementById('warningRainLbl');
        if (warningRainLbl) {
            warningRainLbl.textContent = `${stationName} 24H 累積降雨`;
        }
        const warningRain1hLbl = document.getElementById('warningRain1hLbl');
        if (warningRain1hLbl) {
            warningRain1hLbl.textContent = `${stationName} 1H 降雨量`;
        }
        
        // If no api key is found, fallback to simulated safe rain (15 ~ 45mm)
        if (!apiKey) {
            const simulatedRain = 15.0 + Math.random() * 30.0;
            const simulatedRain1h = 0.5 + Math.random() * 4.0;
            updateWarningLevel(simulatedRain, simulatedRain1h);
            return;
        }

        try {
            const rainUrl = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001?Authorization=${apiKey}&format=JSON`;
            const res = await fetch(rainUrl);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const data = await res.json();
            
            let rain24h = null;
            let rain1h = null;
            if (data && data.records && data.records.Station) {
                const s = data.records.Station.find(st => st.StationId === stationId || st.StationName === stationName);
                if (s) {
                    const past24 = s.RainfallElement && (s.RainfallElement.Past24hr || s.RainfallElement.Past24Hr);
                    if (past24 && past24.Precipitation !== undefined) {
                        const val = past24.Precipitation;
                        rain24h = (typeof val === 'object' && val !== null && val.value !== undefined) ? parseFloat(val.value) : parseFloat(val);
                    } else {
                        rain24h = findValByKey(s, "Precipitation") || findValByKey(s, "PrecipitationMax") || 0;
                    }

                    const past1 = s.RainfallElement && (s.RainfallElement.Past1hr || s.RainfallElement.Past1Hr);
                    if (past1 && past1.Precipitation !== undefined) {
                        const val = past1.Precipitation;
                        rain1h = (typeof val === 'object' && val !== null && val.value !== undefined) ? parseFloat(val.value) : parseFloat(val);
                    } else {
                        rain1h = findValByKey(s, "Past1hr") || findValByKey(s, "Past1Hr") || 0;
                    }
                }
            }
            
            if (rain24h !== null) {
                if (rain1h === null) rain1h = 0.0;
                updateWarningLevel(rain24h, rain1h);
            } else {
                throw new Error(`無法定位${stationName}雨量數據`);
            }
        } catch (error) {
            console.warn("自動抓取雨量失敗，啟用模擬數值:", error.message);
            // 在警告訊息中加入具體 API 連線錯誤提示
            const warningTimeText = document.getElementById('warningTimeText');
            if (warningTimeText) {
                warningTimeText.innerHTML = `<span style="color: var(--color-warning); font-size: 0.75rem;">⚠️ CWA API 連線異常 (${error.message})，已切換至備援模擬值</span>`;
            }
            updateWarningLevel(18.5, 2.5);
        }
    }

    // Helper: Find value in deep JSON
    function findValByKey(obj, targetKey) {
        if (!obj || typeof obj !== 'object') return null;
        if (obj[targetKey] !== undefined) {
            const val = obj[targetKey];
            if (typeof val === 'object' && val !== null && val.value !== undefined) {
                return parseFloat(val.value);
            }
            return parseFloat(val);
        }
        for (let k in obj) {
            if (obj.hasOwnProperty(k)) {
                let res = findValByKey(obj[k], targetKey);
                if (res !== null) return res;
            }
        }
        return null;
    }

    // Trigger refresh button click
    btnWarningRefresh.addEventListener('click', () => {
        countdownSeconds = 3600;
        hasBeenSilenced = false; // Reset silencer state on active manual check
        fetchRainfallData();
        startTimer();
    });

    // Silence alarm button click listener
    if (btnSilenceAlarm) {
        btnSilenceAlarm.addEventListener('click', () => {
            silenceEmergencyAlarm();
            hasBeenSilenced = true; // Mark as silenced
        });
    }

    // Simulated Warning testing
    btnSimSafe.addEventListener('click', () => {
        isSimulationMode = true;
        updateTimerDisplay();
        hasBeenSilenced = false; // Reset silencer for fresh simulation
        updateWarningLevel(15.0, 0.5);
    });

    btnSimYellow.addEventListener('click', () => {
        isSimulationMode = true;
        updateTimerDisplay();
        hasBeenSilenced = false;
        updateWarningLevel(320.0, 35.0);
    });

    btnSimRed.addEventListener('click', () => {
        isSimulationMode = true;
        updateTimerDisplay();
        hasBeenSilenced = false;
        updateWarningLevel(485.0, 58.0);
    });

    // Run initial fetch and trigger timer
    updateWarningLevel(0.0);
    fetchRainfallData();
    startTimer();
        // Autoplay Policy Bypass: Setup click trigger to resume context if blocked
    document.body.addEventListener('click', () => {
        if (isAlarmPlaying && audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    }, { once: false });

    // 導出到全域，允許登入時自動重新整理
    window.fetchRainfallData = fetchRainfallData;
}
function initSatelliteMap() {
    const satelliteImg = document.getElementById('satelliteImg');
    const windyLocateStatus = document.getElementById('windyLocateStatus');
    const btnWindyMyLocation = document.getElementById('btnWindyMyLocation');
    const btnWindyDefault = document.getElementById('btnWindyDefault');
    if (!satelliteImg) return;

    // 初始載入：嘗試抓取瀏覽器定位，若失敗或拒絕則採用預設村落
    tryGeolocation();

    function tryGeolocation(isManual = false) {
        if (windyLocateStatus) windyLocateStatus.textContent = "📡 定位中...";
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const lat = position.coords.latitude;
                    const lon = position.coords.longitude;
                    updateWindyRadar(lat, lon, 11);
                    if (windyLocateStatus) {
                        windyLocateStatus.textContent = `📡 已定位到您 (${lat.toFixed(2)}, ${lon.toFixed(2)})`;
                    }
                },
                (error) => {
                    console.warn("Geolocation failed:", error.message);
                    useDefaultCoordinateFallback();
                    if (windyLocateStatus) {
                        windyLocateStatus.textContent = isManual ? `⚠️ 瀏覽器拒絕定位，已切回預設` : `🏠 預設 ${currentUserVillage} 定位`;
                    }
                },
                { enableHighAccuracy: true, timeout: 5000 }
            );
        } else {
            useDefaultCoordinateFallback();
            if (windyLocateStatus) {
                windyLocateStatus.textContent = `🏠 預設 ${currentUserVillage} 定位`;
            }
        }
    }

    function useDefaultCoordinateFallback() {
        const coords = villageCoordinates[currentUserVillage] || { lat: 22.385800, lng: 120.892700 };
        updateWindyRadar(coords.lat, coords.lng, 11);
    }

    function updateWindyRadar(lat, lon, zoom = 11) {
        satelliteImg.src = `https://embed.windy.com/embed2.html?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&zoom=${zoom}&level=surface&overlay=radar&product=radar&menu=&message=&marker=&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=default&metricTemp=default&radarRange=true`;
    }

    // 綁定手動切換按鈕事件
    if (btnWindyMyLocation) {
        btnWindyMyLocation.addEventListener('click', () => {
            tryGeolocation(true);
        });
    }

    if (btnWindyDefault) {
        btnWindyDefault.addEventListener('click', () => {
            useDefaultCoordinateFallback();
            if (windyLocateStatus) windyLocateStatus.textContent = `🏠 已定位至 ${currentUserVillage}`;
        });
    }

    // 註冊為全域方法，供座標定位卡片連動使用
    window.updateWindyRadar = (lat, lon) => {
        updateWindyRadar(lat, lon, 11);
        if (windyLocateStatus) {
            windyLocateStatus.textContent = `📍 已由卡片定位 (${lat.toFixed(2)}, ${lon.toFixed(2)})`;
        }
    };

    // 註冊為全域方法，供登入成功時同步切換地圖中心與按鈕
    window.useWindyDefaultLocation = () => {
        useDefaultCoordinateFallback();
        if (windyLocateStatus) windyLocateStatus.textContent = `🏠 已定位至 ${currentUserVillage}`;
    };
}

function updateWarningLevel(rain, rain1h) {
    const warningBanner = document.getElementById('warningBanner');
    const warningLevelTitle = document.getElementById('warningLevelTitle');
    const warningLevelDesc = document.getElementById('warningLevelDesc');
    const warningRainVal = document.getElementById('warningRainVal');
    const warningRain1hVal = document.getElementById('warningRain1hVal');
    const warningHeaderIcon = document.getElementById('warningHeaderIcon');
    const header = document.querySelector('.app-header');

    if (warningRainVal) {
        warningRainVal.innerHTML = `${rain.toFixed(1)} <span class="unit">mm</span>`;
    }
    if (warningRain1hVal) {
        warningRain1hVal.innerHTML = `${(rain1h !== undefined && rain1h !== null) ? rain1h.toFixed(1) : '0.0'} <span class="unit">mm</span>`;
    }

    if (!warningBanner || !header) return;

    // Reset styles
    warningBanner.className = 'warning-banner';
    header.style.borderColor = 'rgba(255, 255, 255, 0.08)';
    header.style.boxShadow = 'var(--shadow-main)';

    if (rain >= 300) {
        // Triggers audio siren warning if not manually silenced
        if (!isAlarmPlaying && !hasBeenSilenced) {
            playEmergencyAlarm();
        }
    } else {
        // Lower than warning thresholds - auto turn off siren
        if (isAlarmPlaying) {
            silenceEmergencyAlarm();
        }
        hasBeenSilenced = false; // Reset silencer lock when safe
    }

    if (rain >= 450) {
        // Red alert
        warningBanner.classList.add('status-danger');
        warningLevelTitle.textContent = "🔴 紅色警戒";
        warningLevelDesc.textContent = "告警：累積降雨量已達紅色警戒 (>= 450mm)，建議執行預防性撤離！";
        if (warningHeaderIcon) warningHeaderIcon.style.color = "var(--color-danger)";
        
        // Header Sync
        header.style.borderColor = 'rgba(230, 57, 70, 0.4)';
        header.style.boxShadow = '0 0 25px rgba(230, 57, 70, 0.25)';
    } else if (rain >= 300) {
        // Yellow alert
        warningBanner.classList.add('status-warning');
        warningLevelTitle.textContent = "🟡 黃色警戒";
        warningLevelDesc.textContent = "告警：累積降雨量已達黃色警戒 (>= 300mm)，請各防災人員警戒並注意路況。";
        if (warningHeaderIcon) warningHeaderIcon.style.color = "var(--color-warning)";
        
        // Header Sync
        header.style.borderColor = 'rgba(255, 183, 3, 0.4)';
        header.style.boxShadow = '0 0 25px rgba(255, 183, 3, 0.2)';
    } else {
        // Safe Normal
        warningBanner.classList.add('status-safe');
        warningLevelTitle.textContent = "🟢 安全常態";
        warningLevelDesc.textContent = "目前累積降雨量在安全範圍內，請持續監控。";
        if (warningHeaderIcon) warningHeaderIcon.style.color = "var(--color-success)";
    }
}



// 5. CCTV MONITOR CONTROLLER (Lazy loads frames to preserve bandwidth and supports fullscreen)
function initCctvMonitor() {
    const btnOpenCctv = document.getElementById('btnOpenCctv');
    const cctvModal = document.getElementById('cctvModal');
    const btnCloseCctvModal = document.getElementById('btnCloseCctvModal');
    const cctvGrid = document.getElementById('cctvGrid');
    const btnToggleCctvSettings = document.getElementById('btnToggleCctvSettings');
    const cctvSettingsInputs = document.getElementById('cctvSettingsInputs');
    const btnSaveCctvUrls = document.getElementById('btnSaveCctvUrls');
    
    // 公路局 CCTV 伺服器列表，用於自動修復輪詢
    const cctvServers = ["cctv-ss05", "cctv-ss07", "cctv-ss01", "cctv-ss02", "cctv-ss03", "cctv-ss04", "cctv-ss06"];
    window.handleCctvError = function(img) {
        const currentUrl = img.src;
        let currentIdx = cctvServers.findIndex(srv => currentUrl.includes(srv));
        const nextIdx = currentIdx + 1;
        
        if (nextIdx < cctvServers.length) {
            const nextServer = cctvServers[nextIdx];
            const cameraId = img.getAttribute('data-id');
            if (cameraId) {
                const newUrl = `https://${nextServer}.thb.gov.tw:443/${cameraId}`;
                console.log(`CCTV ${cameraId} 載入失敗，嘗試自動切換至伺服器: ${nextServer}`);
                img.src = `${newUrl}?t=${Math.random()}`;
                img.setAttribute('data-src', newUrl);
            }
        } else {
            console.warn("所有公路局 CCTV 伺服器皆無法載入此 ID:", img.getAttribute('data-id'));
            
            // 嘗試退回原始 iframe 載入（如果原本不是 thb 圖片直連）
            const originalUrl = img.getAttribute('data-original-url');
            if (originalUrl && !originalUrl.includes('thb.gov.tw')) {
                const parent = img.parentElement;
                if (parent) {
                    console.log("圖片全部載入失敗，退回原始 iframe 載入:", originalUrl);
                    parent.innerHTML = `
                        <iframe src="${originalUrl}" class="cctv-image" style="border: none; width: 100%; height: 100%;" allow="autoplay; encrypted-media" allowfullscreen></iframe>
                        <div class="cctv-label">${img.alt}</div>
                        <button class="cctv-fs-btn" data-target="${parent.id}">
                            <svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
                            全螢幕
                        </button>
                    `;
                    return;
                }
            }
            
            img.src = "logo.png"; // 顯示凱芳預設 Logo
            img.removeAttribute('onerror'); // 避免無限循環
        }
    };
    
    if (!btnOpenCctv || !cctvModal || !cctvGrid) return;
    
    const defaultCctvUrls = [
        "https://cctv-ss05.thb.gov.tw:443/T9-422K+650",
        "https://cctv-ss05.thb.gov.tw:443/T9-425K+200",
        "https://cctv-ss05.thb.gov.tw:443/T9-423K+000",
        "https://cctv-ss07.thb.gov.tw:443/T9-421k+500-1"
    ];

    const defaultCctvLabels = [
        "台9線 422K+650 (大武路段)",
        "台9線 425K+200 (安朔路段)",
        "台9線 423K+000 (大武路段)",
        "台9線 421K+500 (大武之心)"
    ];
    
    let cctvConfigs = [];
    try {
        const saved = localStorage.getItem('cctv_configs');
        if (saved) {
            cctvConfigs = JSON.parse(saved);
        }
    } catch (e) {
        console.error("解析 cctv_configs 錯誤:", e);
    }
    
    // 補足 4 個影格設定
    for (let i = 0; i < 4; i++) {
        if (!cctvConfigs[i]) {
            cctvConfigs[i] = { url: defaultCctvUrls[i], label: defaultCctvLabels[i] };
        }
    }
    
    // 初始化自訂設定面板的輸入值
    for (let i = 0; i < 4; i++) {
        const urlInput = document.getElementById(`cctvUrl_${i}`);
        const labelInput = document.getElementById(`cctvLabel_${i}`);
        if (urlInput) urlInput.value = cctvConfigs[i].url || "";
        if (labelInput) labelInput.value = cctvConfigs[i].label || "";
    }
    
    // 展開 / 收合自訂設定
    if (btnToggleCctvSettings && cctvSettingsInputs) {
        btnToggleCctvSettings.addEventListener('click', () => {
            const isHidden = cctvSettingsInputs.classList.contains('hidden');
            if (isHidden) {
                cctvSettingsInputs.classList.remove('hidden');
                btnToggleCctvSettings.textContent = "收合自訂設定";
            } else {
                cctvSettingsInputs.classList.add('hidden');
                btnToggleCctvSettings.textContent = "展開自訂設定";
            }
        });
    }
    
    // 儲存自訂設定
    if (btnSaveCctvUrls) {
        btnSaveCctvUrls.addEventListener('click', () => {
            const newConfigs = [];
            for (let i = 0; i < 4; i++) {
                const urlVal = document.getElementById(`cctvUrl_${i}`)?.value.trim() || defaultCctvUrls[i];
                const labelVal = document.getElementById(`cctvLabel_${i}`)?.value.trim() || defaultCctvLabels[i];
                newConfigs.push({ url: urlVal, label: labelVal });
            }
            localStorage.setItem('cctv_configs', JSON.stringify(newConfigs));
            cctvConfigs = newConfigs;
            alert("CCTV 設定已成功儲存！");
            renderCctvGrid();
        });
    }
    
    let refreshInterval = null;

    function getRefreshedUrl(url) {
        if (url.includes('?')) {
            return `${url}&t=${Math.random()}`;
        }
        return `${url}?t=${Math.random()}`;
    }
    
    // 判斷是否為圖片格式以決定渲染為 img 還是 iframe
    function isImageUrl(url) {
        if (!url) return false;
        const lower = url.toLowerCase();
        return lower.includes('thb.gov.tw') || 
               lower.endsWith('.jpg') || 
               lower.endsWith('.jpeg') || 
               lower.endsWith('.png') || 
               lower.endsWith('.gif') || 
               lower.endsWith('.webp') ||
               lower.includes('format=jpg') ||
               lower.includes('image');
    }

    // 轉換為直連網址或已知 CCTV 格式
    function convertCctvUrl(url, label) {
        if (!url) return url;
        
        let decodedUrl = url.trim();
        let lastUrl = "";
        let limit = 5;
        // 循環解碼，徹底還原多重 URL 編碼的字元（例如 %252B -> %2B -> +）
        while (decodedUrl.includes('%') && decodedUrl !== lastUrl && limit > 0) {
            lastUrl = decodedUrl;
            try {
                decodedUrl = decodeURIComponent(decodedUrl);
            } catch (e) {
                console.warn("解碼 URL 失敗:", e);
                break;
            }
            limit--;
        }
        
        // 1. 優先從 URL 中尋找省道 ID
        let match = decodedUrl.match(/(T\d+-\d+[kK][\+\s]?\d+(?:-[a-zA-Z0-9]+)?)/i);
        
        // 2. 如果 URL 中找不到，且有標籤，則嘗試從標籤中提取省道 ID
        if (!match && label) {
            const labelMatch = label.match(/(?:台|省道)\s*(\d+)\s*線\s*(\d+[kK][\+\s]?\d+)/i);
            if (labelMatch) {
                let routeNum = labelMatch[1];
                let mileage = labelMatch[2];
                if (!mileage.includes("+")) {
                    mileage = mileage.replace(/([kK])\s*(\d+)/i, "$1+$2");
                }
                const cameraId = `T${routeNum}-${mileage}`;
                return `https://cctv-ss05.thb.gov.tw:443/${cameraId}`;
            }
        }
        
        if (match) {
            let cameraId = match[1];
            // 標準化：確保 K 之後有 + 連接符號
            if (!cameraId.includes("+")) {
                cameraId = cameraId.replace(/([kK])\s*(\d+)/i, "$1+$2");
            }
            
            const lowerId = cameraId.toLowerCase();
            
            // 比對已知確切伺服器以加速首次載入
            if (lowerId === "t9-422k+650") return "https://cctv-ss05.thb.gov.tw:443/T9-422K+650";
            if (lowerId === "t9-425k+200") return "https://cctv-ss05.thb.gov.tw:443/T9-425K+200";
            if (lowerId === "t9-423k+000") return "https://cctv-ss05.thb.gov.tw:443/T9-423K+000";
            if (lowerId === "t9-421k+500-1" || lowerId === "t9-421k+500") return "https://cctv-ss07.thb.gov.tw:443/T9-421k+500-1";
            
            // 針對公路局所有省道 CCTV (例如 T9-, T26-, T11- 等) 預設為 ss05 (載入失敗會由 handleCctvError 自動輪詢其他伺服器)
            if (lowerId.startsWith("t9-421k")) {
                return `https://cctv-ss07.thb.gov.tw:443/${cameraId}`;
            }
            return `https://cctv-ss05.thb.gov.tw:443/${cameraId}`;
        }
        return url.trim(); // 沒匹配成功則回傳原本經過整理的網址
    }
    
    function renderCctvGrid() {
        if (refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
        }
        
        cctvGrid.innerHTML = cctvConfigs.map((cfg, idx) => {
            const convertedUrl = convertCctvUrl(cfg.url, cfg.label);
            const isImg = isImageUrl(convertedUrl);
            let mediaHtml = "";
            let wrapperClass = "cctv-card-wrapper";
            
            if (convertedUrl.includes("tw.live") || cfg.url.includes("tw.live")) {
                wrapperClass += " cctv-wrapper-twlive";
            }
            
            if (isImg) {
                // 擷取 ID 用於 onerror 時更換伺服器輪詢
                const matchId = convertedUrl.match(/(T\d+-\d+[kK]\+\d+(?:-[a-zA-Z0-9]+)?)/i);
                const dataIdAttr = matchId ? `data-id="${matchId[1]}"` : "";
                
                mediaHtml = `<img src="${getRefreshedUrl(convertedUrl)}" data-src="${convertedUrl}" data-original-url="${cfg.url}" ${dataIdAttr} onerror="window.handleCctvError && window.handleCctvError(this)" alt="${cfg.label}" referrerpolicy="no-referrer" class="cctv-image">`;
            } else {
                mediaHtml = `<iframe src="${convertedUrl}" class="cctv-image" style="border: none; width: 100%; height: 100%;" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
            }
            
            return `
                <div class="${wrapperClass}" id="cctvWrapper_${idx}">
                    ${mediaHtml}
                    <div class="cctv-label">${cfg.label}</div>
                    <button class="cctv-fs-btn" data-target="cctvWrapper_${idx}">
                        <svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
                        全螢幕
                    </button>
                </div>
            `;
        }).join('');
        
        // 輔助函式：動態更新全螢幕按鈕狀態與圖示
        function updateFSButtonState(wrapper, isFS) {
            const btn = wrapper.querySelector('.cctv-fs-btn');
            if (!btn) return;
            if (isFS) {
                btn.innerHTML = `
                    <svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                    關閉全螢幕
                `;
            } else {
                btn.innerHTML = `
                    <svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
                    全螢幕
                `;
            }
        }

        // 使用事件委派監聽全螢幕按鈕點擊，以支援動態 Fallback iframe 生成的按鈕
        cctvGrid.addEventListener('click', (e) => {
            const btn = e.target.closest('.cctv-fs-btn');
            if (!btn) return;
            
            const targetId = btn.getAttribute('data-target');
            const wrapper = document.getElementById(targetId);
            if (!wrapper) return;
            
            // 1. 檢查是否已處於虛擬全螢幕
            if (wrapper.classList.contains('pseudo-fullscreen')) {
                wrapper.classList.remove('pseudo-fullscreen');
                updateFSButtonState(wrapper, false);
                return;
            }
            
            // 2. 檢查是否已處於原生全螢幕
            const isCurrentlyFS = document.fullscreenElement === wrapper ||
                                  document.webkitFullscreenElement === wrapper ||
                                  document.mozFullScreenElement === wrapper ||
                                  document.msFullscreenElement === wrapper;
            if (isCurrentlyFS) {
                const exitFS = document.exitFullscreen || 
                               document.webkitExitFullscreen || 
                               document.mozCancelFullScreen || 
                               document.msExitFullscreen;
                if (exitFS) {
                    exitFS.call(document);
                }
                return;
            }

            // 3. 偵測 Native Fullscreen APIs
            const requestFS = wrapper.requestFullscreen || 
                              wrapper.mozRequestFullScreen || 
                              wrapper.webkitRequestFullscreen || 
                              wrapper.msRequestFullscreen;

            // 偵測是否為 iOS (iPhone/iPad/iPod) 裝置，iOS 通常限制 div 原生全螢幕
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

            if (requestFS && !isIOS) {
                requestFS.call(wrapper).catch(err => {
                    console.warn("原生全螢幕呼叫失敗，切換為虛擬全螢幕:", err);
                    enablePseudoFS(wrapper);
                });
            } else {
                // 不支援或 iOS 裝置，直接切換為虛擬全螢幕
                enablePseudoFS(wrapper);
            }
        });

        // 輔助函式：啟用虛擬全螢幕
        function enablePseudoFS(wrapper) {
            wrapper.classList.add('pseudo-fullscreen');
            updateFSButtonState(wrapper, true);
        }

        // 監聽原生全螢幕變更事件，動態更新按鈕與狀態
        const handleFSChange = () => {
            const wrappers = cctvGrid.querySelectorAll('.cctv-card-wrapper');
            const fsElement = document.fullscreenElement || 
                              document.webkitFullscreenElement || 
                              document.mozFullScreenElement || 
                              document.msFullscreenElement;
            
            wrappers.forEach(w => {
                if (fsElement === w) {
                    updateFSButtonState(w, true);
                } else {
                    w.classList.remove('pseudo-fullscreen');
                    updateFSButtonState(w, false);
                }
            });
        };

        document.addEventListener('fullscreenchange', handleFSChange);
        document.addEventListener('webkitfullscreenchange', handleFSChange);
        document.addEventListener('mozfullscreenchange', handleFSChange);
        document.addEventListener('MSFullscreenChange', handleFSChange);

        // 啟動圖片定時刷新（每 10 秒）
        refreshInterval = setInterval(() => {
            const images = cctvGrid.querySelectorAll('img.cctv-image');
            images.forEach(img => {
                const baseUrl = img.getAttribute('data-src');
                if (baseUrl) {
                    img.src = getRefreshedUrl(baseUrl);
                }
            });
        }, 10000);
    }
    
    // 開啟 Modal 並加載影像
    btnOpenCctv.addEventListener('click', () => {
        renderCctvGrid();
        cctvModal.classList.add('active');
        toggleBodyScroll(true);
    });
    
    // 關閉 Modal 並卸載影像
    function closeCctv() {
        cctvModal.classList.remove('active');
        toggleBodyScroll(false);
        cctvGrid.innerHTML = '';
        if (refreshInterval) {
            clearInterval(refreshInterval);
            refreshInterval = null;
        }
    }
    
    if (btnCloseCctvModal) {
        btnCloseCctvModal.addEventListener('click', closeCctv);
    }
    
    cctvModal.addEventListener('click', (e) => {
        if (e.target === cctvModal) {
            closeCctv();
        }
    });
}

// 6. AUTHENTICATION & ADMIN PORTAL CONTROLLER
function initAuthSystem() {
    const authScreen = document.getElementById('authScreen');
    const loginView = document.getElementById('loginView');
    const signupView = document.getElementById('signupView');
    
    // Links
    const linkToSignup = document.getElementById('linkToSignup');
    const linkToLogin = document.getElementById('linkToLogin');
    
    // Login inputs
    const loginUsernameInput = document.getElementById('loginUsername');
    const loginPasswordInput = document.getElementById('loginPassword');
    const btnLoginSubmit = document.getElementById('btnLoginSubmit');
    
    // Signup inputs
    const signupUsernameInput = document.getElementById('signupUsername');
    const signupPasswordInput = document.getElementById('signupPassword');
    const signupConfirmPasswordInput = document.getElementById('signupConfirmPassword');
    const signupNameInput = document.getElementById('signupName');
    const signupPhoneInput = document.getElementById('signupPhone');
    const signupJobInput = document.getElementById('signupJob');
    const signupCountyInput = document.getElementById('signupCounty');
    const signupTownInput = document.getElementById('signupTown');
    const signupVillageInput = document.getElementById('signupVillage');
    const btnSignupSubmit = document.getElementById('btnSignupSubmit');
    
    // Profile Badge
    const userProfileBadge = document.getElementById('userProfileBadge');
    const profileUserName = document.getElementById('profileUserName');
    const profileUserRole = document.getElementById('profileUserRole');
    const btnAdminPortal = document.getElementById('btnAdminPortal');
    const btnLogout = document.getElementById('btnLogout');
    
    // 用戶連線狀態心跳機制 (Heartbeat Presence)
    let heartbeatIntervalId = null;

    function startHeartbeat(uid) {
        if (heartbeatIntervalId) clearInterval(heartbeatIntervalId);
        
        // 立即發送一次心跳
        sendHeartbeat(uid);
        
        // 每 30 秒定期發送心跳
        heartbeatIntervalId = setInterval(() => {
            sendHeartbeat(uid);
        }, 30000);
    }

    function stopHeartbeat() {
        if (heartbeatIntervalId) {
            clearInterval(heartbeatIntervalId);
            heartbeatIntervalId = null;
        }
    }

    async function sendHeartbeat(uid) {
        if (!db) return;
        try {
            await db.collection('users').doc(uid).update({
                lastActive: firebase.firestore.FieldValue.serverTimestamp()
            });
        } catch (err) {
            console.error("傳送心跳錯誤:", err);
        }
    }

    async function setOfflineStatus(uid) {
        if (!db) return;
        try {
            // 寫入 1970 年的時間戳記，後台便會立即可判定為離線
            await db.collection('users').doc(uid).update({
                lastActive: new Date(0)
            });
        } catch (err) {
            console.error("設定離線狀態錯誤:", err);
        }
    }

    // 當瀏覽器視窗關閉或重新整理時，嘗試通知離線
    window.addEventListener('beforeunload', () => {
        if (auth && auth.currentUser) {
            setOfflineStatus(auth.currentUser.uid);
        }
    });

    // 綁定 Enter 鍵事件響應 (登入與註冊)
    const triggerLoginOnEnter = (e) => {
        if (e.key === 'Enter') {
            btnLoginSubmit.click();
        }
    };
    if (loginUsernameInput) loginUsernameInput.addEventListener('keypress', triggerLoginOnEnter);
    if (loginPasswordInput) loginPasswordInput.addEventListener('keypress', triggerLoginOnEnter);

    const triggerSignupOnEnter = (e) => {
        if (e.key === 'Enter') {
            btnSignupSubmit.click();
        }
    };
    const signupInputs = [
        signupUsernameInput, signupPasswordInput, signupConfirmPasswordInput,
        signupNameInput, signupPhoneInput, signupJobInput,
        signupCountyInput, signupTownInput, signupVillageInput
    ];
    signupInputs.forEach(input => {
        if (input) input.addEventListener('keypress', triggerSignupOnEnter);
    });
    
    // Admin Panel
    const adminPanel = document.getElementById('adminPanel');
    const adminNameDisplay = document.getElementById('adminNameDisplay');
    const btnBackToDashboard = document.getElementById('btnBackToDashboard');
    const btnAdminLogout = document.getElementById('btnAdminLogout');
    const btnTabUsers = document.getElementById('btnTabUsers');
    const btnTabKeys = document.getElementById('btnTabKeys');
    const tabViewUsers = document.getElementById('tabViewUsers');
    const tabViewKeys = document.getElementById('tabViewKeys');
    
    const userCountBadge = document.getElementById('userCountBadge');
    const userTableBody = document.getElementById('userTableBody');
    const cwaApiKeyInput = document.getElementById('cwaApiKey');
    const geminiApiKeyInput = document.getElementById('geminiApiKey');
    const tgosAppIdInput = document.getElementById('tgosAppId');
    const tgosApiKeyInput = document.getElementById('tgosApiKey');
    const btnSaveSettings = document.getElementById('btnSaveSettings');
    
    const appContainer = document.querySelector('.app-container');

    // 1. Tab switching within Auth View
    if (linkToSignup) {
        linkToSignup.addEventListener('click', () => {
            loginView.classList.add('hidden');
            signupView.classList.remove('hidden');
        });
    }
    if (linkToLogin) {
        linkToLogin.addEventListener('click', () => {
            signupView.classList.add('hidden');
            loginView.classList.remove('hidden');
        });
    }

    // 格式驗證：英數混合且至少8位
    function validateFormat(text) {
        const regex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{8,}$/;
        return regex.test(text);
    }

    // 驗證並套用使用者登入與載入資料流程，封裝為函式以便在防競態流程中手動調用
    async function checkUserStatusAndLogin(user) {
        if (isCreatingUserDoc) {
            // 正在建立用戶文件中，暫不進行權限審查，避免競態條件 (Race Condition)
            return;
        }
        try {
            // 讀取 Firestore 使用者資料
            const userDoc = await db.collection('users').doc(user.uid).get();
            if (!userDoc.exists) {
                alert("找不到該用戶的權限設定，將自動登出。");
                auth.signOut();
                return;
            }

            const userData = userDoc.data();
            currentUserVillage = userData.village || "南興村";
            
            // 檢查權限狀態
            if (userData.status === 'pending') {
                alert("您的帳號註冊申請正在審核中，尚未開放使用系統，請聯絡管理員確認。");
                auth.signOut();
                return;
            } else if (userData.status === 'suspended') {
                alert("您的帳號已被管理員停用，無法登入系統。");
                auth.signOut();
                return;
            } else if (userData.status !== 'approved') {
                alert("異常的帳號狀態，將自動登出。");
                auth.signOut();
                return;
            }

            // 登入成功，配置前台使用者狀態
            profileUserName.textContent = userData.name;
            userProfileBadge.style.display = 'flex';
            startHeartbeat(user.uid);
            
            if (userData.role === 'admin') {
                profileUserRole.textContent = "ADMIN";
                profileUserRole.style.color = "var(--color-warning)";
                btnAdminPortal.style.display = 'inline-block';
                adminNameDisplay.textContent = userData.name;
                // 初始化後台金鑰輸入框
                loadApiKeysToAdminInputs();
                // 初始化後台用戶清單監聽
                initAdminUserListListener();
            } else {
                profileUserRole.textContent = "USER";
                profileUserRole.style.color = "var(--color-success)";
                btnAdminPortal.style.display = 'none';
            }

            // 載入全域 API 金鑰
            const keysDoc = await db.collection('settings').doc('keys').get();
            if (keysDoc.exists) {
                globalApiKeys.cwaApiKey = keysDoc.data().cwaApiKey || "";
                // 方案 A：金鑰收回至後端 Cloud Functions，前端不再下載與保存明文金鑰
                globalApiKeys.geminiApiKey = ""; 
            }
            
            // 更新 Windy 地圖的預設按鈕與定位
            const btnWindyDefault = document.getElementById('btnWindyDefault');
            if (btnWindyDefault) {
                btnWindyDefault.innerHTML = `🏠 ${currentUserVillage}`;
            }
            if (typeof window.useWindyDefaultLocation === 'function') {
                window.useWindyDefaultLocation();
            }

            // 隱藏登入遮罩並載入前台資料
            authScreen.classList.add('fade-out');
            toggleBodyScroll(false);
            updateNetworkStatus();
            if (typeof fetchRainfallData === 'function') {
                fetchRainfallData();
            }
            if (typeof fetchTyphoonData === 'function') {
                fetchTyphoonData();
            }

        } catch (err) {
            console.error("驗證使用者資料失敗:", err);
            alert("讀取權限失敗，將自動登出。");
            auth.signOut();
        }
    }

    // 2. 登入邏輯
    if (btnLoginSubmit) {
        btnLoginSubmit.addEventListener('click', async () => {
            const username = loginUsernameInput.value.trim();
            const password = loginPasswordInput.value;

            if (!username || !password) {
                alert("請輸入帳號與密碼！");
                return;
            }

            // 格式檢驗 (管理員帳密例外)
            const isAdminPreset = (username === "kf19810529" && password === "hh648860");
            if (!isAdminPreset) {
                if (username.length < 8 || password.length < 8) {
                    alert("帳號與密碼長度皆必須至少 8 位數！");
                    return;
                }
                if (!validateFormat(username) || !validateFormat(password)) {
                    alert("帳號與密碼皆必須為英文加數字的組合！");
                    return;
                }
            }

            const email = `${username}@tribal.disaster.local`;
            btnLoginSubmit.disabled = true;
            btnLoginSubmit.textContent = "登入中...";
            let loginSuccess = false;

            try {
                // 調用 Firebase Auth 進行登入
                await auth.signInWithEmailAndPassword(email, password);
                loginSuccess = true;
            } catch (error) {
                console.error("登入錯誤:", error);
                // 處理預設管理員自動註冊 logic (兼容用戶列舉保護下的 auth/invalid-credential 錯誤)
                if (isAdminPreset && (error.code === "auth/user-not-found" || error.code === "auth/invalid-credential")) {
                    try {
                        btnLoginSubmit.textContent = "首次登入，建立管理員中...";
                        isCreatingUserDoc = true;
                        const cred = await auth.createUserWithEmailAndPassword(email, password);
                        const user = cred.user;
                        
                        await db.collection('users').doc(user.uid).set({
                            username: username,
                            name: "系統管理員",
                            phone: "N/A",
                            jobTitle: "管理員",
                            county: "台東縣",
                            town: "達仁鄉",
                            village: "南興村",
                            role: "admin",
                            status: "approved",
                            createdAt: firebase.firestore.FieldValue.serverTimestamp()
                        });
                        
                        isCreatingUserDoc = false;
                        alert("預設管理員帳號已成功於 Firebase 初始化！");
                        await checkUserStatusAndLogin(user);
                        loginSuccess = true;
                    } catch (regErr) {
                        isCreatingUserDoc = false;
                        console.error("建立預設管理員失敗:", regErr);
                        if (regErr.code === "auth/email-already-in-use") {
                            alert("登入失敗：密碼錯誤。");
                        } else {
                            alert("建立預設管理員失敗：" + regErr.message);
                        }
                    }
                } else {
                    alert("登入失敗：帳號或密碼錯誤。");
                }
            } finally {
                if (!loginSuccess) {
                    btnLoginSubmit.disabled = false;
                    btnLoginSubmit.textContent = "登入";
                }
            }
        });
    }

    // 3. 註冊邏輯
    if (btnSignupSubmit) {
        btnSignupSubmit.addEventListener('click', async () => {
            const username = signupUsernameInput.value.trim();
            const password = signupPasswordInput.value;
            const confirmPassword = signupConfirmPasswordInput.value;
            const name = signupNameInput.value.trim();
            const phone = signupPhoneInput.value.trim();
            const job = signupJobInput.value.trim();
            const county = signupCountyInput.value.trim();
            const town = signupTownInput.value.trim();
            const village = signupVillageInput.value.trim();

            if (!username || !password || !confirmPassword || !name || !phone || !job || !county || !town || !village) {
                alert("所有欄位均為必填！");
                return;
            }

            if (username.length < 8 || password.length < 8) {
                alert("帳號與密碼長度均必須至少 8 位數！");
                return;
            }

            if (!validateFormat(username) || !validateFormat(password)) {
                alert("帳號與密碼皆必須包含英文與數字！");
                return;
            }

            if (password !== confirmPassword) {
                alert("兩次輸入的密碼不一致！");
                return;
            }

            btnSignupSubmit.disabled = true;
            btnSignupSubmit.textContent = "正在送出申請...";

            const email = `${username}@tribal.disaster.local`;

            try {
                // 1. 在 Firebase Auth 中建立使用者
                isCreatingUserDoc = true;
                const cred = await auth.createUserWithEmailAndPassword(email, password);
                const user = cred.user;

                // 2. 寫入使用者詳細資料到 Firestore，狀態預設為待審核 'pending'
                await db.collection('users').doc(user.uid).set({
                    username: username,
                    name: name,
                    phone: phone,
                    jobTitle: job,
                    county: county,
                    town: town,
                    village: village,
                    role: 'user',
                    status: 'pending',
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });

                isCreatingUserDoc = false;
                await auth.signOut();
                alert("註冊申請已成功送出！將由後台管理者進行使用權利審核。");
                
                // 清空表單
                signupUsernameInput.value = "";
                signupPasswordInput.value = "";
                signupConfirmPasswordInput.value = "";
                signupNameInput.value = "";
                signupPhoneInput.value = "";
                signupJobInput.value = "";
                signupCountyInput.value = "";
                signupTownInput.value = "";
                signupVillageInput.value = "";

                // 返回登入畫面
                signupView.classList.add('hidden');
                loginView.classList.remove('hidden');

            } catch (error) {
                isCreatingUserDoc = false;
                console.error("註冊失敗:", error);
                if (error.code === "auth/email-already-in-use") {
                    alert("該帳號名稱已被註冊，請更換其他帳號！");
                } else {
                    alert("註冊失敗：" + error.message);
                }
            } finally {
                btnSignupSubmit.disabled = false;
                btnSignupSubmit.textContent = "送出註冊申請";
            }
        });
    }

    // 4. 登出邏輯
    const handleLogout = async () => {
        if (auth.currentUser) {
            try {
                await setOfflineStatus(auth.currentUser.uid);
            } catch (e) {
                console.error("登出時設定離線失敗:", e);
            }
        }
        stopHeartbeat();
        auth.signOut().then(() => {
            // 清空金鑰與介面狀態
            globalApiKeys.cwaApiKey = "";
            globalApiKeys.geminiApiKey = "";
            currentUserVillage = "南興村";
            updateNetworkStatus();
            alert("您已成功登出系統。");
        });
    };

    if (btnLogout) btnLogout.addEventListener('click', handleLogout);
    if (btnAdminLogout) btnAdminLogout.addEventListener('click', handleLogout);

    // 5. Firebase 驗證狀態監聽
    auth.onAuthStateChanged(async (user) => {
        if (user) {
            await checkUserStatusAndLogin(user);
        } else {
            // 未登入，顯示登入遮罩
            stopHeartbeat();
            authScreen.classList.remove('fade-out');
            toggleBodyScroll(true);
            loginView.classList.remove('hidden');
            signupView.classList.add('hidden');
            userProfileBadge.style.display = 'none';
            adminPanel.classList.add('hidden');
            appContainer.classList.remove('hidden');
            
            // 清空輸入
            loginUsernameInput.value = "";
            loginPasswordInput.value = "";

            // 還原登入按鈕狀態，防範非同步異常卡住
            if (btnLoginSubmit) {
                btnLoginSubmit.disabled = false;
                btnLoginSubmit.textContent = "登入";
            }
        }
    });

    // 6. 後台面板切換邏輯
    if (btnAdminPortal) {
        btnAdminPortal.addEventListener('click', () => {
            appContainer.classList.add('hidden');
            adminPanel.classList.remove('hidden');
        });
    }

    if (btnBackToDashboard) {
        btnBackToDashboard.addEventListener('click', () => {
            adminPanel.classList.add('hidden');
            appContainer.classList.remove('hidden');
        });
    }

    // 後台 Tab 切換
    const btnTabPresence = document.getElementById('btnTabPresence');
    const tabViewPresence = document.getElementById('tabViewPresence');

    function switchAdminTab(activeBtn, activeView) {
        const tabs = [
            { btn: btnTabUsers, view: tabViewUsers },
            { btn: btnTabKeys, view: tabViewKeys },
            { btn: btnTabPresence, view: tabViewPresence }
        ];
        
        tabs.forEach(t => {
            if (t.btn && t.view) {
                if (t.btn === activeBtn) {
                    t.btn.classList.add('active');
                    t.view.classList.remove('hidden');
                } else {
                    t.btn.classList.remove('active');
                    t.view.classList.add('hidden');
                }
            }
        });
    }

    if (btnTabUsers) {
        btnTabUsers.addEventListener('click', () => switchAdminTab(btnTabUsers, tabViewUsers));
    }
    if (btnTabKeys) {
        btnTabKeys.addEventListener('click', () => switchAdminTab(btnTabKeys, tabViewKeys));
    }
    if (btnTabPresence) {
        btnTabPresence.addEventListener('click', () => {
            switchAdminTab(btnTabPresence, tabViewPresence);
            renderPresenceDashboard(); // 切換時立即更新一次畫面
        });
    }

    // 7. 管理者金鑰存取與寫入
    function loadApiKeysToAdminInputs() {
        db.collection('settings').doc('keys').get().then(doc => {
            if (doc.exists) {
                cwaApiKeyInput.value = doc.data().cwaApiKey || "";
                geminiApiKeyInput.value = doc.data().geminiApiKey || "";
                if (tgosAppIdInput) tgosAppIdInput.value = doc.data().tgosAppId || "";
                if (tgosApiKeyInput) tgosApiKeyInput.value = doc.data().tgosApiKey || "";
            }
        }).catch(err => console.error("後台載入金鑰錯誤:", err));
    }

    if (btnSaveSettings) {
        btnSaveSettings.addEventListener('click', async () => {
            const cwaKey = cwaApiKeyInput.value.trim();
            const geminiKey = geminiApiKeyInput.value.trim();
            const tgosId = tgosAppIdInput ? tgosAppIdInput.value.trim() : "";
            const tgosKey = tgosApiKeyInput ? tgosApiKeyInput.value.trim() : "";

            btnSaveSettings.disabled = true;
            btnSaveSettings.textContent = "⏳ 正在儲存金鑰...";

            try {
                await db.collection('settings').doc('keys').set({
                    cwaApiKey: cwaKey,
                    geminiApiKey: geminiKey,
                    tgosAppId: tgosId,
                    tgosApiKey: tgosKey
                });
                
                // 同步至記憶體
                globalApiKeys.cwaApiKey = cwaKey;
                globalApiKeys.geminiApiKey = geminiKey;
                updateNetworkStatus();
                if (typeof fetchRainfallData === 'function') {
                    fetchRainfallData();
                }

                alert("API 金鑰已成功同步寫入 Firebase 資料庫！");
            } catch (err) {
                console.error("儲存金鑰失敗:", err);
                alert("儲存金鑰失敗：" + err.message);
            } finally {
                btnSaveSettings.disabled = false;
                btnSaveSettings.textContent = "💾 儲存金鑰設定";
            }
        });
    }

    // 8. 用戶即時監聽與狀態變更
    let usersUnsubscribe = null;
    let localUsersData = []; // 用於在線偵測與看板
    let presenceRefreshIntervalId = null;

    function initAdminUserListListener() {
        if (usersUnsubscribe) usersUnsubscribe();
        if (presenceRefreshIntervalId) clearInterval(presenceRefreshIntervalId);

        usersUnsubscribe = db.collection('users')
            .orderBy('createdAt', 'desc')
            .onSnapshot(snapshot => {
                userCountBadge.textContent = `全部用戶：${snapshot.size} 人`;
                localUsersData = [];
                snapshot.forEach(doc => {
                    localUsersData.push({ id: doc.id, ...doc.data() });
                });

                renderAdminUsersTable();
                renderPresenceDashboard();
            }, err => {
                console.error("讀取帳號列表錯誤:", err);
                userTableBody.innerHTML = `<tr><td colspan="7" class="text-center" style="color: var(--color-danger);">讀取資料失敗：權限不足。</td></tr>`;
            });

        // 每 10 秒自動重新計算一次時間差（在線狀態）
        presenceRefreshIntervalId = setInterval(() => {
            renderPresenceDashboard();
        }, 10000);
    }

    function renderAdminUsersTable() {
        userTableBody.innerHTML = "";
        if (localUsersData.length === 0) {
            userTableBody.innerHTML = `<tr><td colspan="7" class="text-center" style="color: var(--color-text-muted);">目前無任何註冊用戶。</td></tr>`;
            return;
        }

        localUsersData.forEach(u => {
            const uid = u.id;
            const dateStr = u.createdAt ? new Date(u.createdAt.seconds * 1000).toLocaleString() : "載入中...";
            
            let statusLabelClass = "pending";
            let statusText = "待審核";
            if (u.status === "approved") {
                statusLabelClass = "approved";
                statusText = "使用中";
            } else if (u.status === "suspended") {
                statusLabelClass = "suspended";
                statusText = "已停用";
            }

            // 判斷是否為目前登入的管理者，不允許自我停用或刪除
            const isSelf = (auth.currentUser && auth.currentUser.uid === uid) || (u.username === "kf19810529");
            
            let actionButtonsHtml = "";
            if (!isSelf) {
                if (u.status === "pending") {
                    actionButtonsHtml += `<button class="btn-admin-act btn-admin-approve" onclick="changeUserStatus('${uid}', 'approved')">核准</button>`;
                } else if (u.status === "approved") {
                    actionButtonsHtml += `<button class="btn-admin-act btn-admin-suspend" onclick="changeUserStatus('${uid}', 'suspended')">停用</button>`;
                } else if (u.status === "suspended") {
                    actionButtonsHtml += `<button class="btn-admin-act btn-admin-activate" onclick="changeUserStatus('${uid}', 'approved')">啟用</button>`;
                }
                actionButtonsHtml += `<button class="btn-admin-act btn-admin-edit" onclick="openEditUserModal('${uid}')">編輯</button>`;
                actionButtonsHtml += `<button class="btn-admin-act btn-admin-delete" onclick="deleteUserDoc('${uid}', '${u.username}')">刪除</button>`;
            } else {
                actionButtonsHtml = `<button class="btn-admin-act btn-admin-edit" onclick="openEditUserModal('${uid}')">編輯</button>`;
                actionButtonsHtml += `<span style="color: var(--color-text-muted); font-style: italic; margin-left: 0.5rem;">(本帳)</span>`;
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-family: monospace; font-weight: 700;">${u.username}</td>
                <td>${u.name}</td>
                <td>${u.phone}</td>
                <td>
                    <div style="font-weight: 600;">${u.jobTitle}</div>
                    <div style="font-size: 0.75rem; color: var(--color-text-muted);">${u.county}${u.town}${u.village}</div>
                </td>
                <td style="font-size: 0.75rem; color: var(--color-text-muted);">${dateStr}</td>
                <td><span class="status-badge ${statusLabelClass}">${statusText}</span></td>
                <td><div class="admin-table-actions">${actionButtonsHtml}</div></td>
            `;
            userTableBody.appendChild(tr);
        });
    }

    // 渲染連線監控畫面 (心跳偵測 + 村落分組)
    function renderPresenceDashboard() {
        const presenceTableBody = document.getElementById('presenceTableBody');
        const presenceVillageGrid = document.getElementById('presenceVillageGrid');
        const onlineCountBadge = document.getElementById('onlineCountBadge');
        
        if (!presenceTableBody || !presenceVillageGrid || !onlineCountBadge) return;
        
        const now = new Date();
        let onlineCount = 0;
        
        // 判定在線 (60 秒內回傳過心跳)
        const checkOnline = (u) => {
            if (!u.lastActive) return false;
            const lastActiveTime = u.lastActive.toDate ? u.lastActive.toDate() : new Date(u.lastActive.seconds * 1000);
            const diffSeconds = (now - lastActiveTime) / 1000;
            return diffSeconds >= 0 && diffSeconds < 60;
        };

        // 1. 計算在線人數與全部人數
        const totalUsers = localUsersData.length;
        localUsersData.forEach(u => {
            if (checkOnline(u)) onlineCount++;
        });
        onlineCountBadge.textContent = `在線用戶：${onlineCount} / ${totalUsers} 人`;

        // 2. 按村落分組計算在線狀態
        const villages = {};
        localUsersData.forEach(u => {
            const vName = u.village || "未設定村落";
            if (!villages[vName]) {
                villages[vName] = {
                    name: vName,
                    users: [],
                    onlineCount: 0
                };
            }
            villages[vName].users.push(u);
            if (checkOnline(u)) {
                villages[vName].onlineCount++;
            }
        });

        // 繪製村落看板
        const villageNames = Object.keys(villages).sort();
        if (villageNames.length === 0) {
            presenceVillageGrid.innerHTML = `<div class="text-center" style="grid-column: 1/-1; padding: 2rem; color: var(--color-text-muted);">目前無任何村落資料。</div>`;
        } else {
            presenceVillageGrid.innerHTML = villageNames.map(vName => {
                const v = villages[vName];
                const isOnline = v.onlineCount > 0;
                const statusClass = isOnline ? 'online' : 'offline';
                const statusText = isOnline ? `在線 (${v.onlineCount} 人)` : '離線';
                
                return `
                    <div class="presence-card ${statusClass}">
                        <div class="presence-info">
                            <span class="presence-village-name">🏡 ${v.name}</span>
                            <span class="presence-status-text">${statusText}</span>
                        </div>
                        <div class="presence-indicator">
                            <div class="presence-dot ${statusClass}"></div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        // 3. 繪製詳細使用者連線清單
        if (localUsersData.length === 0) {
            presenceTableBody.innerHTML = `<tr><td colspan="6" class="text-center" style="color: var(--color-text-muted); padding: 1.5rem;">無任何使用者資料。</td></tr>`;
            return;
        }

        presenceTableBody.innerHTML = localUsersData.map(u => {
            const isOnline = checkOnline(u);
            const statusClass = isOnline ? 'online' : 'offline';
            const statusText = isOnline ? '在線' : '離線';
            
            let lastActiveStr = "從未上線";
            if (u.lastActive) {
                const lastActiveTime = u.lastActive.toDate ? u.lastActive.toDate() : new Date(u.lastActive.seconds * 1000);
                lastActiveStr = lastActiveTime.toLocaleString();
            }
            
            return `
                <tr>
                    <td style="font-family: monospace; font-weight: 700;">${u.username}</td>
                    <td>${u.name}</td>
                    <td style="font-weight: 600; color: #ffffff;">🏡 ${u.village || "未設定"}</td>
                    <td style="font-size: 0.8rem; color: var(--color-text-muted);">
                        <div>📞 ${u.phone || "無"}</div>
                        <div>💼 ${u.jobTitle || "無"}</div>
                    </td>
                    <td>
                        <span class="user-online-badge ${statusClass}">
                            <span class="dot"></span>${statusText}
                        </span>
                    </td>
                    <td style="font-size: 0.75rem; color: var(--color-text-muted); font-family: monospace;">${lastActiveStr}</td>
                </tr>
            `;
        }).join('');
    }

    // 綁定編輯用戶 Modal 事件
    const editUserModal = document.getElementById('editUserModal');
    const btnCloseEditUserModal = document.getElementById('btnCloseEditUserModal');
    const btnSaveEditUser = document.getElementById('btnSaveEditUser');

    if (btnCloseEditUserModal && editUserModal) {
        btnCloseEditUserModal.addEventListener('click', () => {
            editUserModal.classList.remove('active');
            toggleBodyScroll(false);
        });
        editUserModal.addEventListener('click', (e) => {
            if (e.target === editUserModal) {
                editUserModal.classList.remove('active');
                toggleBodyScroll(false);
            }
        });
    }

    if (btnSaveEditUser) {
        btnSaveEditUser.addEventListener('click', async () => {
            const uid = document.getElementById('editUserUid').value;
            const name = document.getElementById('editUserName').value.trim();
            const phone = document.getElementById('editUserPhone').value.trim();
            const job = document.getElementById('editUserJob').value.trim();
            const county = document.getElementById('editUserCounty').value.trim();
            const town = document.getElementById('editUserTown').value.trim();
            const village = document.getElementById('editUserVillage').value.trim();

            if (!name || !phone || !job || !county || !town || !village) {
                alert("所有欄位均為必填！");
                return;
            }

            btnSaveEditUser.disabled = true;
            btnSaveEditUser.textContent = "⏳ 正在儲存...";

            try {
                await db.collection('users').doc(uid).update({
                    name: name,
                    phone: phone,
                    jobTitle: job,
                    county: county,
                    town: town,
                    village: village
                });
                
                alert("用戶資料修改成功！");
                editUserModal.classList.remove('active');
                toggleBodyScroll(false);
            } catch (err) {
                console.error("修改用戶資料失敗:", err);
                alert("修改用戶資料失敗：" + err.message);
            } finally {
                btnSaveEditUser.disabled = false;
                btnSaveEditUser.textContent = "💾 儲存修改";
            }
        });
    }
}

// 供後台表格按鈕全域呼叫的資料庫修改函式
window.changeUserStatus = function(uid, newStatus) {
    if (!confirm(`確定要將此用戶的狀態變更為 ${newStatus === 'approved' ? '已核准/啟用' : '停用'} 嗎？`)) return;
    db.collection('users').doc(uid).update({
        status: newStatus
    }).then(() => {
        console.log(`狀態變更成功: ${uid} -> ${newStatus}`);
    }).catch(err => {
        alert("變更狀態失敗：" + err.message);
    });
};

window.deleteUserDoc = function(uid, username) {
    if (!confirm(`警告：確定要刪除用戶「${username}」的系統存取資格嗎？\n此動作將會移除該用戶的 Firestore 設定文件。`)) return;
    db.collection('users').doc(uid).delete().then(() => {
        console.log(`用戶刪除成功: ${uid}`);
    }).catch(err => {
        alert("刪除用戶失敗：" + err.message);
    });
};

window.openEditUserModal = function(uid) {
    const modal = document.getElementById('editUserModal');
    if (!modal) return;
    
    db.collection('users').doc(uid).get().then(doc => {
        if (doc.exists) {
            const u = doc.data();
            document.getElementById('editUserUid').value = uid;
            document.getElementById('editUserName').value = u.name || "";
            document.getElementById('editUserPhone').value = u.phone || "";
            document.getElementById('editUserJob').value = u.jobTitle || "";
            document.getElementById('editUserCounty').value = u.county || "";
            document.getElementById('editUserTown').value = u.town || "";
            document.getElementById('editUserVillage').value = u.village || "";
            
            modal.classList.add('active');
            toggleBodyScroll(true);
        } else {
            alert("找不到該用戶的資料！");
        }
    }).catch(err => {
        alert("讀取用戶資料失敗：" + err.message);
    });
};

// 7. TYPHOON DATA & ALERTS CONTROLLER
function initTyphoonData() {
    const btnTyphoonData = document.getElementById('btnTyphoonData');
    const typhoonModal = document.getElementById('typhoonModal');
    const btnCloseModal = document.getElementById('btnCloseModal');
    const modalLoading = document.getElementById('modalLoading');
    const modalResults = document.getElementById('modalResults');
    const loadingText = document.getElementById('loadingText');

    const rainVal = document.getElementById('rainVal');
    const rainStatus = document.getElementById('rainStatus');
    const windVal = document.getElementById('windVal');
    const windStatus = document.getElementById('windStatus');
    const typhoonNews = document.getElementById('typhoonNews');
    const lineSummaryText = document.getElementById('lineSummaryText');
    const btnCopyLineText = document.getElementById('btnCopyLineText');
    
    const btnSelectRainStation = document.getElementById('btnSelectRainStation');
    const btnSelectWindStation = document.getElementById('btnSelectWindStation');

    const stationPickerModal = document.getElementById('stationPickerModal');
    const stationPickerTitle = document.getElementById('stationPickerTitle');
    const pickerCountySelect = document.getElementById('pickerCountySelect');
    const pickerStationSelect = document.getElementById('pickerStationSelect');
    const pickerCustomStationContainer = document.getElementById('pickerCustomStationContainer');
    const pickerCustomStationInput = document.getElementById('pickerCustomStationInput');
    const btnCancelPicker = document.getElementById('btnCancelPicker');
    const btnConfirmPicker = document.getElementById('btnConfirmPicker');
    const btnClosePickerModal = document.getElementById('btnClosePickerModal');

    if (!btnTyphoonData || !typhoonModal) return;

    // 載入 localStorage 設定
    let savedRainStation = localStorage.getItem('typhoonRainStation') || "C0S990|山豬窟";
    if (savedRainStation.startsWith("C0AC40")) {
        savedRainStation = "C0S990|山豬窟";
        localStorage.setItem('typhoonRainStation', savedRainStation);
    }
    let savedWindStation = localStorage.getItem('typhoonWindStation') || "C0V250|南田";

    // 本地預設防災測站 (無金鑰或離線時備援)
    const defaultRainStations = [
        { id: "C0S990", name: "山豬窟", county: "臺東縣" },
        { id: "467540", name: "大武", county: "臺東縣" },
        { id: "C0S840", name: "南田", county: "臺東縣" },
        { id: "C0SA80", name: "土阪", county: "臺東縣" },
        { id: "C0SA90", name: "達仁林場", county: "臺東縣" }
    ];

    const defaultWindStations = [
        { id: "C0S840", name: "南田", county: "臺東縣" },
        { id: "467540", name: "大武", county: "臺東縣" },
        { id: "C0SA90", name: "達仁林場", county: "臺東縣" },
        { id: "467620", name: "蘭嶼", county: "臺東縣" }
    ];

    let activePickerType = 'rain'; // 'rain' or 'wind'

    function updateStationButtonsText() {
        const [_, rainName] = savedRainStation.split('|');
        const [__, windName] = savedWindStation.split('|');
        if (btnSelectRainStation) btnSelectRainStation.textContent = `${rainName} (${savedRainStation.split('|')[0]})`;
        if (btnSelectWindStation) btnSelectWindStation.textContent = `${windName} (${savedWindStation.split('|')[0]})`;
    }
    updateStationButtonsText();

    function initStationPickerModal() {
        if (!stationPickerModal) return;

        let activeCallback = null;

        function openPicker(type, currentVal, title, stations, callback) {
            activePickerType = type;
            activeCallback = callback;
            stationPickerModal.classList.add('active');
            stationPickerTitle.textContent = title;

            const [currentId, currentName] = currentVal.split('|');

            // 1. 提取所有縣市並渲染
            const countiesSet = new Set();
            stations.forEach(s => {
                if (s.county) countiesSet.add(s.county);
            });
            const counties = Array.from(countiesSet).sort();

            pickerCountySelect.innerHTML = counties.map(c => `<option value="${c}">${c}</option>`).join('');
            pickerCountySelect.innerHTML += `<option value="custom">-- 自訂觀測站 --</option>`;

            // 2. 縣市變更時，聯動更新觀測站
            function populateStations(selectedCounty) {
                if (selectedCounty === 'custom') {
                    pickerStationSelect.style.display = 'none';
                    pickerCustomStationContainer.style.display = 'block';
                    pickerCustomStationInput.value = currentVal.includes('|') ? currentVal : "";
                } else {
                    pickerStationSelect.style.display = 'block';
                    pickerCustomStationContainer.style.display = 'none';
                    
                    const filteredStations = stations.filter(s => s.county === selectedCounty);
                    pickerStationSelect.innerHTML = filteredStations.map(s => 
                        `<option value="${s.id}|${s.name}">${s.name} (${s.id})</option>`
                    ).join('');
                }
            }

            pickerCountySelect.onchange = () => {
                populateStations(pickerCountySelect.value);
            };

            // 3. 預設選取當前測站
            let matchedStation = stations.find(s => s.id === currentId);
            if (matchedStation) {
                pickerCountySelect.value = matchedStation.county;
                populateStations(matchedStation.county);
                pickerStationSelect.value = `${currentId}|${currentName}`;
            } else {
                pickerCountySelect.value = 'custom';
                populateStations('custom');
            }
        }

        stationPickerManager.open = openPicker;

        if (btnSelectRainStation) {
            btnSelectRainStation.addEventListener('click', () => {
                const stations = cwaCachedRainStations.length > 0 ? cwaCachedRainStations : defaultRainStations;
                openPicker('rain', savedRainStation, "🌧️ 選擇雨量觀測站", stations, (finalVal) => {
                    savedRainStation = finalVal;
                    localStorage.setItem('typhoonRainStation', finalVal);
                    updateStationButtonsText();
                    fetchTyphoonData();
                });
            });
        }
        if (btnSelectWindStation) {
            btnSelectWindStation.addEventListener('click', () => {
                const stations = cwaCachedWindStations.length > 0 ? cwaCachedWindStations : defaultWindStations;
                openPicker('wind', savedWindStation, "💨 選擇風速觀測站", stations, (finalVal) => {
                    savedWindStation = finalVal;
                    localStorage.setItem('typhoonWindStation', finalVal);
                    updateStationButtonsText();
                    fetchTyphoonData();
                });
            });
        }

        function closePicker() {
            stationPickerModal.classList.remove('active');
        }

        if (btnCancelPicker) btnCancelPicker.addEventListener('click', closePicker);
        if (btnClosePickerModal) btnClosePickerModal.addEventListener('click', closePicker);
        if (btnConfirmPicker) {
            btnConfirmPicker.addEventListener('click', () => {
                let finalVal = "";
                const isCustom = pickerCountySelect.value === 'custom';

                if (isCustom) {
                    const customInput = pickerCustomStationInput.value.trim();
                    if (customInput && customInput.includes('|')) {
                        finalVal = customInput;
                    } else {
                        alert("自訂觀測站格式不正確 (格式: 代碼|名稱)");
                        return;
                    }
                } else {
                    finalVal = pickerStationSelect.value;
                }

                if (activeCallback) {
                    activeCallback(finalVal);
                }
                closePicker();
            });
        }
    }
    initStationPickerModal();

    function getSelectedStations() {
        const [rainId, rainName] = savedRainStation.split('|');
        const [windId, windName] = savedWindStation.split('|');
        return { rainId, rainName, windId, windName };
    }

    // Open Typhoon Modal & Load Data
    btnTyphoonData.addEventListener('click', () => {
        typhoonModal.classList.add('active');
        toggleBodyScroll(true);
        fetchTyphoonData();
    });

    // Close Modal
    if (btnCloseModal) {
        btnCloseModal.addEventListener('click', () => {
            typhoonModal.classList.remove('active');
            toggleBodyScroll(false);
        });
    }

    typhoonModal.addEventListener('click', (e) => {
        if (e.target === typhoonModal) {
            typhoonModal.classList.remove('active');
            toggleBodyScroll(false);
        }
    });

    // Copy LINE text to Clipboard
    if (btnCopyLineText) {
        btnCopyLineText.addEventListener('click', () => {
            lineSummaryText.select();
            lineSummaryText.setSelectionRange(0, 99999);
            navigator.clipboard.writeText(lineSummaryText.value).then(() => {
                const originalText = btnCopyLineText.innerHTML;
                btnCopyLineText.innerHTML = "✅ 已成功複製到剪貼簿！";
                btnCopyLineText.style.background = "#2ec4b6";
                btnCopyLineText.style.borderColor = "#2ec4b6";
                setTimeout(() => {
                    btnCopyLineText.innerHTML = originalText;
                    btnCopyLineText.style.background = "";
                    btnCopyLineText.style.borderColor = "";
                }, 2000);
            }).catch(err => {
                alert('複製失敗，請手動全選複製。');
            });
        });
    }

    // Fetch Typhoon & station weather data
    async function fetchTyphoonData() {
        modalLoading.classList.remove('hidden');
        modalResults.classList.add('hidden');
        loadingText.textContent = "正在向中央氣象署要求即時數據...";

        const apiKey = globalApiKeys.cwaApiKey || "";
        const { rainId, rainName, windId, windName } = getSelectedStations();
        
        // 更新 UI 標題
        const rainTitleEl = document.getElementById('typhoonRainTitle');
        const rain1hTitleEl = document.getElementById('typhoonRain1hTitle');
        const windTitleEl = document.getElementById('typhoonWindTitle');
        if (rainTitleEl) rainTitleEl.textContent = `🌧️ ${rainName} 24H 累積降雨`;
        if (rain1hTitleEl) rain1hTitleEl.textContent = `🌧️ ${rainName} 1H 降雨量`;
        if (windTitleEl) windTitleEl.textContent = `💨 ${windName} 最大陣風資料`;

        // If no API Key is provided, use simulated high-quality current CWA data
        if (!apiKey) {
            setTimeout(() => {
                renderSimulatedData(rainName, windName);
            }, 1500);
            return;
        }

        try {
            // Setup CWA Endpoints
            const rainUrl = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001?Authorization=${apiKey}&format=JSON`;
            const windUrl = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0001-001?Authorization=${apiKey}&format=JSON`;
            const warningUrl = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-001?Authorization=${apiKey}&format=JSON`;

            // Parallel fetching
            loadingText.textContent = "與中央氣象署連線中 (API 請求)...";
            const [rainRes, windRes, warnRes] = await Promise.all([
                fetch(rainUrl).then(r => r.json()).catch(e => ({ error: true, msg: e.message })),
                fetch(windUrl).then(r => r.json()).catch(e => ({ error: true, msg: e.message })),
                fetch(warningUrl).then(r => r.json()).catch(e => ({ error: true, msg: e.message }))
            ]);

            // 1. Process Rain Data & Cache all stations
            let rain24h = null;
            let rain1h = null;
            if (rainRes && rainRes.records && rainRes.records.Station) {
                // 快取最新的雨量測站，並依縣市分組所需資料格式
                cwaCachedRainStations = rainRes.records.Station.map(s => {
                    const county = (s.GeoInfo && s.GeoInfo.CountyName) ? s.GeoInfo.CountyName : "其他";
                    return {
                        id: s.StationId,
                        name: s.StationName,
                        county: county
                    };
                }).filter(s => s.id && s.name);

                const s = rainRes.records.Station.find(st => st.StationId === rainId || st.StationName === rainName);
                if (s) {
                    const past24 = s.RainfallElement && (s.RainfallElement.Past24hr || s.RainfallElement.Past24Hr);
                    if (past24 && past24.Precipitation !== undefined) {
                        const val = past24.Precipitation;
                        rain24h = (typeof val === 'object' && val !== null && val.value !== undefined) ? parseFloat(val.value) : parseFloat(val);
                    } else {
                        rain24h = findValByKey(s, "Precipitation") || findValByKey(s, "PrecipitationMax") || 0;
                    }

                    const past1 = s.RainfallElement && (s.RainfallElement.Past1hr || s.RainfallElement.Past1Hr);
                    if (past1 && past1.Precipitation !== undefined) {
                        const val = past1.Precipitation;
                        rain1h = (typeof val === 'object' && val !== null && val.value !== undefined) ? parseFloat(val.value) : parseFloat(val);
                    } else {
                        rain1h = findValByKey(s, "Past1hr") || findValByKey(s, "Past1Hr") || 0;
                    }
                }
            }

            // 2. Process Wind Data & Cache all stations
            let maxGustMps = null;
            if (windRes && windRes.records && windRes.records.Station) {
                // 快取最新的風速測站，並依縣市分組所需資料格式
                cwaCachedWindStations = windRes.records.Station.map(s => {
                    const county = (s.GeoInfo && s.GeoInfo.CountyName) ? s.GeoInfo.CountyName : "其他";
                    return {
                        id: s.StationId,
                        name: s.StationName,
                        county: county
                    };
                }).filter(s => s.id && s.name);

                const s = windRes.records.Station.find(st => st.StationId === windId || st.StationName === windName);
                if (s) {
                    maxGustMps = findValByKey(s, "PeakGustSpeed") || findValByKey(s, "GustSpeed") || findValByKey(s, "WindSpeed") || 0;
                }
            }

            // 3. Process Typhoon Warning
            let warnDesc = "目前西北太平洋無發布中之颱風警報。";
            if (warnRes && warnRes.records && warnRes.records.dataset) {
                const dataset = warnRes.records.dataset;
                const info = dataset.datasetInfo?.datasetDescription || "";
                const content = findValByKey(dataset, "content") || findValByKey(dataset, "text") || "";
                if (info || content) {
                    warnDesc = `【${info}】\n${content.substring(0, 300)}... (點擊氣象署網頁查看完整內容)`;
                }
            }

            if (rainRes.error && windRes.error) {
                throw new Error(`氣象署 API 請求失敗: ${rainRes.msg || '未知錯誤'} (可能是跨域 CORS 阻擋)`);
            }

            // Rendering actual results
            renderRealData(rain24h, rain1h, maxGustMps, warnDesc, rainName, windName);

        } catch (error) {
            console.warn(error.message);
            loadingText.textContent = `⚠️ API 連線失敗 (${error.message})，正在切換為本地模擬防災數據...`;
            setTimeout(() => {
                renderSimulatedData(rainName, windName);
            }, 3000);
        }
    }

    // Helper: Find value by key recursively in deep JSON objects
    function findValByKey(obj, targetKey) {
        if (!obj || typeof obj !== 'object') return null;
        if (obj[targetKey] !== undefined) {
            const val = obj[targetKey];
            if (typeof val === 'object' && val !== null && val.value !== undefined) {
                return parseFloat(val.value);
            }
            return parseFloat(val);
        }
        for (let k in obj) {
            if (obj.hasOwnProperty(k)) {
                let res = findValByKey(obj[k], targetKey);
                if (res !== null) return res;
            }
        }
        return null;
    }

    // Convert m/s wind speed to Beaufort scale
    function toBeaufort(mps) {
        if (mps === null || isNaN(mps)) return "--";
        if (mps < 0.3) return 0;
        if (mps <= 1.5) return 1;
        if (mps <= 3.3) return 2;
        if (mps <= 5.4) return 3;
        if (mps <= 7.9) return 4;
        if (mps <= 10.7) return 5;
        if (mps <= 13.8) return 6;
        if (mps <= 17.1) return 7;
        if (mps <= 20.7) return 8;
        if (mps <= 24.4) return 9;
        if (mps <= 28.4) return 10;
        if (mps <= 32.6) return 11;
        if (mps <= 36.9) return 12;
        return 13;
    }

    // Render Real fetched CWA Data
    function renderRealData(rain24h, rain1h, gust, warning, rainName, windName) {
        modalLoading.classList.add('hidden');
        modalResults.classList.remove('hidden');

        // 1H Rain display
        const rain1hVal = document.getElementById('rain1hVal');
        const rain1hStatus = document.getElementById('rain1hStatus');
        if (rain1hVal && rain1hStatus) {
            if (rain1h !== null) {
                rain1hVal.innerHTML = `${rain1h.toFixed(1)} <span class="unit">mm</span>`;
                if (rain1h >= 40) {
                    rain1hStatus.textContent = "🔴 警戒：短時強降雨警戒！";
                    rain1hStatus.style.color = "#e63946";
                } else if (rain1h >= 15) {
                    rain1hStatus.textContent = "🟡 注意：短時強降雨注意。";
                    rain1hStatus.style.color = "#ffb703";
                } else {
                    rain1hStatus.textContent = "🟢 正常：降雨強度在安全範圍。";
                    rain1hStatus.style.color = "#2ec4b6";
                }
            } else {
                rain1hVal.textContent = "無資料";
                rain1hStatus.textContent = "測站維護中或未回傳。";
            }
        }

        // Rain display
        if (rain24h !== null) {
            rainVal.innerHTML = `${rain24h.toFixed(1)} <span class="unit">mm</span>`;
            if (rain24h >= 200) {
                rainStatus.textContent = "🔴 警戒：已達大豪雨等級！";
                rainStatus.style.color = "#e63946";
            } else if (rain24h >= 80) {
                rainStatus.textContent = "🟡 注意：已達大雨等級。";
                rainStatus.style.color = "#ffb703";
            } else {
                rainStatus.textContent = "🟢 正常：降雨量在安全範圍內。";
                rainStatus.style.color = "#2ec4b6";
            }
        } else {
            rainVal.textContent = "無資料";
            rainStatus.textContent = "測站維護中或未回傳。";
        }

        // Wind display
        if (gust !== null) {
            const b = toBeaufort(gust);
            windVal.innerHTML = `${b} <span class="unit">級 (${gust.toFixed(1)} m/s)</span>`;
            if (b >= 10) {
                windStatus.textContent = "🔴 警告：狂風！有吹倒路樹危險！";
                windStatus.style.color = "#e63946";
            } else if (b >= 7) {
                windStatus.textContent = "🟡 戒備：強風！外出請注意落石。";
                windStatus.style.color = "#ffb703";
            } else {
                windStatus.textContent = "🟢 正常：風力溫和。";
                windStatus.style.color = "#2ec4b6";
            }
        } else {
            windVal.textContent = "無資料";
            windStatus.textContent = "測站維護中或未回傳.";
        }

        typhoonNews.textContent = warning;

        // Compile LINE formatted message
        const summary = compileLineSummary(rain1h, rain24h, gust, warning, false, rainName, windName);
        lineSummaryText.value = summary;

        triggerAICopilotBroadcast(summary);
    }

    // Render Simulated Data
    function renderSimulatedData(rainName, windName) {
        modalLoading.classList.add('hidden');
        modalResults.classList.remove('hidden');

        const simRain1h = 42.5;
        const simRain = 342.5;
        const simGust = 30.2;
        const simWarning = "【強烈颱風瑪娃海陸上警報】\n目前颱風中心在鵝鑾鼻東南方 280 公里處，向西北西移動。其暴風圈已覆蓋台東及恆春半島，預計未來 24 小時花東山區將迎來劇烈雨勢，累積雨量可達 500mm 以上。請東半部及南部山區居民做好土石流防範準備！";

        const rain1hVal = document.getElementById('rain1hVal');
        const rain1hStatus = document.getElementById('rain1hStatus');
        if (rain1hVal && rain1hStatus) {
            rain1hVal.innerHTML = `${simRain1h.toFixed(1)} <span class="unit">mm</span>`;
            rain1hStatus.textContent = "🔴 警戒：短時強降雨警戒！";
            rain1hStatus.style.color = "#e63946";
        }

        rainVal.innerHTML = `${simRain.toFixed(1)} <span class="unit">mm</span>`;
        rainStatus.textContent = "🔴 警戒：已突破超大豪雨臨界值！";
        rainStatus.style.color = "#e63946";

        const b = toBeaufort(simGust);
        windVal.innerHTML = `${b} <span class="unit">級 (${simGust.toFixed(1)} m/s)</span>`;
        windStatus.textContent = "🔴 警告：11級狂風！道路有樹倒與鐵皮吹飛危險！";
        windStatus.style.color = "#e63946";

        typhoonNews.textContent = simWarning;

        const summary = compileLineSummary(simRain1h, simRain, simGust, simWarning, true, rainName, windName);
        lineSummaryText.value = summary;

        triggerAICopilotBroadcast(summary);
    }

    // Format the text specifically for LINE transmission
    function compileLineSummary(rain1h, rain24h, gust, warning, isSimulated, rainName, windName) {
        const now = new Date();
        const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        
        let rain1hStr = rain1h !== null ? `${rain1h.toFixed(1)} mm` : "無回傳";
        let rain24hStr = rain24h !== null ? `${rain24h.toFixed(1)} mm` : "無回傳";
        let gustStr = gust !== null ? `${toBeaufort(gust)} 級 (${gust.toFixed(1)} m/s)` : "無回傳";
        
        if (rain1h >= 40) {
            rain1hStr += " ⚠️ (短時強降雨警戒)";
        } else if (rain1h >= 15) {
            rain1hStr += " ⚠️ (短時強降雨注意)";
        }
        if (rain24h >= 200) rain24hStr += " ⚠️ (大豪雨警戒)";
        if (gust >= 17.2) gustStr += " ⚠️ (強烈陣風警戒)";

        return `⚠️【部落防汛警戒通報】⚠️
發布時間：${timeStr}${isSimulated ? ' (模擬氣象站即時數據)' : ''}
---------------------------
📍 關鍵測站監測數據：
1. 🌧️ ${rainName} (1H降雨量)：${rain1hStr}
2. 🌧️ ${rainName} (24H累積降雨)：${rain24hStr}
3. 💨 ${windName} (最大陣風)：${gustStr}
 
🌀 最新颱風動態摘要：
${warning.substring(0, 180)}...
---------------------------
本訊息由${currentUserVillage}自主防災編組彙整發送`;
    }

    // Feed CWA summary into Chatbot automatically
    function triggerAICopilotBroadcast(text) {
        const chatContainer = document.getElementById('chatContainer');
        if (!chatContainer) return;

        const botMessages = document.querySelectorAll('.bot-msg .msg-content');
        if (botMessages.length > 0 && botMessages[botMessages.length - 1].innerText.includes('【部落防汛警戒通報】')) {
            return;
        }

        const msgDiv = document.createElement('div');
        msgDiv.className = `message bot-msg`;
        
        const authorDiv = document.createElement('div');
        authorDiv.className = 'msg-author';
        authorDiv.textContent = 'AI 減災助理';
        
        const contentDiv = document.createElement('div');
        contentDiv.className = 'msg-content';
        
        let html = `<h3>🌀 一鍵取得颱風資料成功</h3><p>已成功從氣象署（或本地快取）獲取數據，並彙整出適合 LINE 轉傳的警報文本。我已將其呈現在下方：</p>`;
        html += `<pre style="background: rgba(0,0,0,0.4); padding: 0.75rem; border-radius: 8px; font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; margin-top: 0.5rem; border: 1px solid rgba(255,255,255,0.05); color: #34d399;">${text}</pre>`;
        
        contentDiv.innerHTML = html;
        msgDiv.appendChild(authorDiv);
        msgDiv.appendChild(contentDiv);
        
        chatContainer.appendChild(msgDiv);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    // 導出到全域，允許登入時自動重新整理
    window.fetchTyphoonData = fetchTyphoonData;
}

// 8. COORDINATE POSITIONING & MAP CONTROLLER
function initLocationPositioning() {
    const btnLocate = document.getElementById('btnLocate');
    const locLatInput = document.getElementById('locLat');
    const locLngInput = document.getElementById('locLng');
    const locAddressInput = document.getElementById('locAddress');
    const btnGeocode = document.getElementById('btnGeocode');
    const mapIframe = document.getElementById('mapIframe');
    const mapOfflineFallback = document.getElementById('mapOfflineFallback');
    const offlineMapCoords = document.getElementById('offlineMapCoords');

    if (!btnLocate || !locLatInput || !locLngInput || !mapIframe) return;

    // 輔助函式：剝皮裁剪地址以進行模糊比對
    function peelAddress(addr) {
        // 逐步去除門牌、鄰里、弄巷、路名
        let newAddr = addr.replace(/(?:[0-9]+(?:之[0-9]+)?|[一二三四五六七八九十百]+(?:之[一二三四五六七八九十百]+)?)號$/, '');
        if (newAddr !== addr) return newAddr.trim();

        newAddr = addr.replace(/(?:[0-9]+|[一二三四五六七八九十百]+)鄰$/, '');
        if (newAddr !== addr) return newAddr.trim();

        newAddr = addr.replace(/(?:[0-9]+|[一二三四五六七八九十百]+)(?:巷|弄)$/, '');
        if (newAddr !== addr) return newAddr.trim();

        newAddr = addr.replace(/[^縣市鄉鎮市區]+(?:路|街|大道|段)$/, '');
        if (newAddr !== addr) return newAddr.trim();

        return null;
    }

    // 地址地理編碼定位邏輯
    async function handleGeocoding() {
        if (!locAddressInput || !btnGeocode) return;
        const address = locAddressInput.value.trim();
        if (!address) {
            alert("請輸入要搜尋的地址！");
            return;
        }

        const isOnline = navigator.onLine;
        if (!isOnline) {
            alert("⚠️ 聯外網路斷線，離線狀態下無法使用地址搜尋定位。請直接輸入經緯度座標進行定位。");
            return;
        }

        const originalBtnText = btnGeocode.textContent;
        btnGeocode.textContent = "搜尋中...";
        btnGeocode.disabled = true;

        try {
            let lat = null;
            let lng = null;
            let resolvedAddr = "";
            let method = "";

            // 1. 優先透過後端 Cloud Functions 呼叫 TGOS API
            const currentUser = auth.currentUser;
            if (currentUser) {
                try {
                    const idToken = await currentUser.getIdToken();
                    const tgosUrl = `/api/geocode?address=${encodeURIComponent(address)}`;
                    const tgosResponse = await fetch(tgosUrl, {
                        headers: {
                            'Authorization': `Bearer ${idToken}`
                        }
                    });
                    if (tgosResponse.ok) {
                         const tgosResult = await tgosResponse.json();
                         if (tgosResult && tgosResult.success) {
                             lat = tgosResult.lat;
                             lng = tgosResult.lng;
                             resolvedAddr = tgosResult.formattedAddress;
                             method = "TGOS";
                         }
                    }
                } catch (tgosErr) {
                    console.warn("TGOS Geocoding failed, trying fallback...", tgosErr);
                }
            }

            // 2. 若 TGOS 解析無果或未配置金鑰，Fallback 啟用「OSM 剝皮式自動裁剪模糊搜尋」
            if (lat === null || lng === null) {
                let currentSearchAddr = address;
                let attempts = 0;
                while (currentSearchAddr && attempts < 4) {
                    attempts++;
                    try {
                        const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(currentSearchAddr)}&email=disaster-prevention@local.org`;
                        const response = await fetch(url);
                        if (response.ok) {
                            const results = await response.json();
                            if (results && results.length > 0) {
                                const result = results[0];
                                lat = parseFloat(result.lat);
                                lng = parseFloat(result.lon);
                                resolvedAddr = currentSearchAddr;
                                method = "OSM";
                                break;
                            }
                        }
                    } catch (osmErr) {
                        console.warn(`OSM attempt ${attempts} failed:`, osmErr);
                    }
                    // 剝皮裁剪地址
                    const peeled = peelAddress(currentSearchAddr);
                    if (!peeled || peeled === currentSearchAddr) break;
                    currentSearchAddr = peeled;
                }
            }

            if (lat !== null && lng !== null) {
                locLatInput.value = lat.toFixed(6);
                locLngInput.value = lng.toFixed(6);

                // 更新地圖
                updateMap();

                // 彈出友善的定位結果提示
                if (method === "TGOS") {
                    console.log(`TGOS 精準定位成功: ${resolvedAddr}`);
                } else if (method === "OSM") {
                    if (resolvedAddr !== address) {
                        alert(`⚠️ 詳細門牌查無資料，系統已自動模糊定位至：\n『${resolvedAddr}』`);
                    }
                }
            } else {
                alert("⚠️ 找不到該地址的座標，請確認行政區是否正確（南興村屬大武鄉而非達仁鄉），或嘗試僅輸入村里名稱。");
            }
        } catch (err) {
            console.error("Geocoding failed:", err);
            alert("⚠️ 地址搜尋失敗，請檢查網路連線或稍後再試。");
        } finally {
            btnGeocode.textContent = originalBtnText;
            btnGeocode.disabled = false;
        }
    }

    if (btnGeocode) {
        btnGeocode.addEventListener('click', handleGeocoding);
    }
    if (locAddressInput) {
        locAddressInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                handleGeocoding();
            }
        });
    }

    function updateMap() {
        const lat = parseFloat(locLatInput.value) || 22.385800;
        const lng = parseFloat(locLngInput.value) || 120.892700;

        const isOnline = navigator.onLine;

        if (isOnline) {
            mapIframe.style.display = "block";
            if (mapOfflineFallback) mapOfflineFallback.style.display = "none";
            
            // 使用 Google Maps 免金鑰嵌入式 API，支援紅色 Marker 標記
            mapIframe.src = `https://maps.google.com/maps?q=${lat},${lng}&hl=zh-TW&z=16&output=embed`;
            
            // 連動更新 Windy 颱風雷達圖中心點
            if (typeof window.updateWindyRadar === 'function') {
                window.updateWindyRadar(lat, lng);
            }
        } else {
            mapIframe.style.display = "none";
            if (mapOfflineFallback) {
                mapOfflineFallback.style.display = "flex";
                offlineMapCoords.textContent = `📡 聯外網路斷線，已啟用本機微波定位對照座標：${lat.toFixed(6)}, ${lng.toFixed(6)}`;
            }
        }
    }

    btnLocate.addEventListener('click', updateMap);

    // Sync positioning on offline/online events
    window.addEventListener('online', updateMap);
    window.addEventListener('offline', updateMap);

    // Initial check
    updateMap();
}

// 9. OFFLINE防災模板管理與 AI 自動生成系統
function initOfflineTemplateSystem() {
    const btnOpenTemplateModal = document.getElementById('btnOpenTemplateModal');
    const offlineTemplateModal = document.getElementById('offlineTemplateModal');
    const btnCloseTemplateModal = document.getElementById('btnCloseTemplateModal');
    
    const templateKeyword = document.getElementById('templateKeyword');
    const templatePrompt = document.getElementById('templatePrompt');
    const btnGenerateTemplate = document.getElementById('btnGenerateTemplate');
    const templateContent = document.getElementById('templateContent');
    const btnSaveTemplate = document.getElementById('btnSaveTemplate');
    const templateStatus = document.getElementById('templateStatus');
    const customTemplateList = document.getElementById('customTemplateList');
    
    if (!offlineTemplateModal) return;

    // 開啟 Modal
    if (btnOpenTemplateModal) {
        btnOpenTemplateModal.addEventListener('click', () => {
            offlineTemplateModal.classList.add('active');
            toggleBodyScroll(true);
            renderCustomTemplateList();
            if (templateKeyword) templateKeyword.value = "";
            if (templatePrompt) templatePrompt.value = "";
            if (templateContent) templateContent.value = "";
            if (templateStatus) templateStatus.textContent = "";
        });
    }

    // 關閉 Modal
    const closeModal = () => {
        offlineTemplateModal.classList.remove('active');
        toggleBodyScroll(false);
    };
    if (btnCloseTemplateModal) btnCloseTemplateModal.addEventListener('click', closeModal);
    offlineTemplateModal.addEventListener('click', (e) => {
        if (e.target === offlineTemplateModal) closeModal();
    });

    // AI 生成防災模板
    if (btnGenerateTemplate) {
        btnGenerateTemplate.addEventListener('click', async () => {
            const promptVal = templatePrompt.value.trim();
            const keywordVal = templateKeyword.value.trim();
            if (!promptVal) {
                alert("請輸入 AI 生成指令！");
                return;
            }

            const isOnline = navigator.onLine;

            if (!isOnline) {
                alert("⚠️ 系統處於離線狀態。無法進行 AI 自動生成。\n您仍可在下方的知識庫內容區中手動編輯並儲存。");
                return;
            }

            btnGenerateTemplate.disabled = true;
            btnGenerateTemplate.textContent = "⏳ 正在生成...";
            if (templateStatus) templateStatus.textContent = "AI 正在撰寫離線 SOP 中...";

            try {
                const url = `/api/askGemini`;
                const promptText = `你目前是一位專業的防災減災專家。請針對主題「${promptVal}」，撰寫一篇實用、簡潔、具步驟化與行動導向的防災知識。
如果觸發關鍵字是「${keywordVal || '防災'}」，請適時融入。
要求：使用繁體中文、排版漂亮的 Markdown 格式（可以包含 🚨、⚠️ 等 emoji、h3/h4 標題、粗體、列表或引用區塊）、總字數不超過 300 字、直接給出專業指南，不需任何客套話與多餘的前言。`;

                let token = "";
                if (auth && auth.currentUser) {
                    token = await auth.currentUser.getIdToken();
                }

                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: promptText }] }]
                    })
                });

                if (!res.ok) {
                    let errMsg = `HTTP ${res.status}`;
                    try {
                        const errText = await res.text();
                        if (errText) {
                            try {
                                const errJson = JSON.parse(errText);
                                if (errJson.error) {
                                    errMsg = typeof errJson.error === 'object' && errJson.error.message 
                                        ? errJson.error.message 
                                        : errJson.error;
                                }
                            } catch (_) {
                                errMsg = `${errMsg}: ${errText}`;
                            }
                        }
                    } catch (_) {}
                    throw new Error(errMsg);
                }

                const data = await res.json();
                const reply = data.candidates[0].content.parts[0].text;
                
                templateContent.value = reply;
                if (templateStatus) templateStatus.textContent = "✨ 生成成功！您可以對內容進行編輯微調。";
            } catch (err) {
                console.error("Gemini template generation failed:", err);
                alert(`⚠️ AI 模板生成失敗：${err.message}\n您可以直接在內容欄中手動輸入。`);
                if (templateStatus) templateStatus.textContent = `生成失敗 (${err.message})`;
            } finally {
                btnGenerateTemplate.disabled = false;
                btnGenerateTemplate.textContent = "✨ AI 生成";
            }
        });
    }

    // 儲存模板
    if (btnSaveTemplate) {
        btnSaveTemplate.addEventListener('click', () => {
            const key = templateKeyword.value.trim();
            const content = templateContent.value.trim();

            if (!key || !content) {
                alert("請填寫觸發關鍵字與知識庫內容！");
                return;
            }

            let customKB = {};
            try {
                const saved = localStorage.getItem('custom_knowledge_base');
                if (saved) customKB = JSON.parse(saved);
            } catch (e) {
                console.error(e);
            }

            customKB[key] = content;
            localStorage.setItem('custom_knowledge_base', JSON.stringify(customKB));

            if (templateStatus) templateStatus.textContent = `✅ 儲存成功！離線 SOP「${key}」已建立。`;
            templateKeyword.value = "";
            templatePrompt.value = "";
            templateContent.value = "";
            renderCustomTemplateList();

            // 連動更新首頁的 SOP 下拉選單
            if (typeof window.updateSopQuickSelect === 'function') {
                window.updateSopQuickSelect();
            }
        });
    }

    // 渲染清單
    function renderCustomTemplateList() {
        if (!customTemplateList) return;
        
        let customKB = {};
        try {
            const saved = localStorage.getItem('custom_knowledge_base');
            if (saved) customKB = JSON.parse(saved);
        } catch (e) {
            console.error(e);
        }

        const keys = Object.keys(customKB);
        if (keys.length === 0) {
            customTemplateList.innerHTML = `<div style="text-align: center; color: var(--color-text-muted); font-size: 0.75rem; padding: 1rem;">目前無任何自訂離線 SOP。</div>`;
            return;
        }

        customTemplateList.innerHTML = keys.map(k => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 0.8rem;">
                <span style="color: var(--color-accent); font-weight: 600;">🔑 ${k}</span>
                <button class="btn btn-outline btn-sim" style="font-size: 0.7rem; padding: 0.15rem 0.45rem; border-color: rgba(230,57,70,0.4); color: #f87171;" onclick="deleteCustomTemplate('${k}')">
                    刪除
                </button>
            </div>
        `).join('');
    }

    // 綁定全域刪除函式供 onclick 調用
    window.deleteCustomTemplate = function(key) {
        if (!confirm(`確定要刪除「${key}」這個自訂離線 SOP 嗎？`)) return;
        
        let customKB = {};
        try {
            const saved = localStorage.getItem('custom_knowledge_base');
            if (saved) customKB = JSON.parse(saved);
        } catch (e) {
            console.error(e);
        }

        delete customKB[key];
        localStorage.setItem('custom_knowledge_base', JSON.stringify(customKB));
        renderCustomTemplateList();

        // 連動更新首頁的 SOP 下拉選單
        if (typeof window.updateSopQuickSelect === 'function') {
            window.updateSopQuickSelect();
        }
    };
}

// 7. RESIDENTS DATABASE SYSTEM (User-level Isolation)
let localResidentsData = []; // 快取當前使用者的保全戶資料，供跨 Modal 連動使用

function initResidentsDatabase() {
    const btnOpenResidents = document.getElementById('btnOpenResidents');
    const residentsModal = document.getElementById('residentsModal');
    const btnCloseResidentsModal = document.getElementById('btnCloseResidentsModal');
    
    // Add/Edit Form Modal Elements
    const btnOpenAddResidentModal = document.getElementById('btnOpenAddResidentModal');
    const residentFormModal = document.getElementById('residentFormModal');
    const btnCloseResidentFormModal = document.getElementById('btnCloseResidentFormModal');
    
    const residentsTableBody = document.getElementById('residentsTableBody');
    const residentsSearch = document.getElementById('residentsSearch');
    
    // Form fields
    const residentId = document.getElementById('residentId');
    const residentsFormTitle = document.getElementById('residentsFormTitle');
    const residentName = document.getElementById('residentName');
    const residentGender = document.getElementById('residentGender');
    const residentBirthday = document.getElementById('residentBirthday');
    const residentAge = document.getElementById('residentAge');
    const residentPhone = document.getElementById('residentPhone');
    const residentAddress = document.getElementById('residentAddress');
    
    const residentRelationRadios = document.getElementsByName('residentRelation');
    const familyHeadSelectContainer = document.getElementById('familyHeadSelectContainer');
    const residentFamilyHeadSelect = document.getElementById('residentFamilyHeadSelect');
    
    const btnSaveResident = document.getElementById('btnSaveResident');
    const btnResetResident = document.getElementById('btnResetResident');
    
    const residentsTotalHouseholds = document.getElementById('residentsTotalHouseholds');
    const residentsTotalPeople = document.getElementById('residentsTotalPeople');
    
    if (!btnOpenResidents || !residentsModal || !residentsTableBody) return;
    
    let residentsUnsubscribe = null;
    
    // Open Main Modal
    btnOpenResidents.addEventListener('click', () => {
        residentsModal.classList.add('active');
        toggleBodyScroll(true);
        startResidentsListening();
    });
    
    // Open Add Resident Form Modal
    if (btnOpenAddResidentModal && residentFormModal) {
        btnOpenAddResidentModal.addEventListener('click', () => {
            try {
                resetResidentForm();
            } catch (e) {
                console.error("Failed to reset form:", e);
            }
            residentFormModal.classList.add('active');
        });
    }
    
    // Close Form Modal helper
    function closeResidentForm() {
        if (residentFormModal) {
            residentFormModal.classList.remove('active');
        }
    }
    
    if (btnCloseResidentFormModal) {
        btnCloseResidentFormModal.addEventListener('click', closeResidentForm);
    }
    
    if (residentFormModal) {
        residentFormModal.addEventListener('click', (e) => {
            if (e.target === residentFormModal) closeResidentForm();
        });
    }
    
    // Close Main Modal
    function closeResidents() {
        residentsModal.classList.remove('active');
        closeResidentForm();
        toggleBodyScroll(false);
        if (residentsUnsubscribe) {
            residentsUnsubscribe();
            residentsUnsubscribe = null;
        }
    }
    
    if (btnCloseResidentsModal) btnCloseResidentsModal.addEventListener('click', closeResidents);
    residentsModal.addEventListener('click', (e) => {
        if (e.target === residentsModal) closeResidents();
    });
    
    // Auto calculate age when birthday changes
    residentBirthday.addEventListener('change', () => {
        const birthdayVal = residentBirthday.value;
        if (!birthdayVal) {
            residentAge.value = "";
            return;
        }
        const birthDate = new Date(birthdayVal);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const m = today.getMonth() - birthDate.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
            age--;
        }
        residentAge.value = isNaN(age) ? "" : Math.max(0, age);
    });
    
    // Relation radio change handler
    residentRelationRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            syncRelationUI();
        });
    });
    
    function syncRelationUI() {
        const isHead = getSelectedRelation() === 'head';
        if (isHead) {
            familyHeadSelectContainer.classList.add('hidden');
            residentFamilyHeadSelect.required = false;
        } else {
            familyHeadSelectContainer.classList.remove('hidden');
            residentFamilyHeadSelect.required = true;
            populateFamilyHeadSelect();
        }
    }
    
    function getSelectedRelation() {
        for (let r of residentRelationRadios) {
            if (r.checked) return r.value;
        }
        return 'head';
    }
    
    function populateFamilyHeadSelect(selectedHeadId = "") {
        residentFamilyHeadSelect.innerHTML = '<option value="">-- 請選擇家戶長 --</option>';
        const heads = localResidentsData.filter(r => r.relation === 'head' && r.id !== residentId.value);
        
        heads.forEach(h => {
            const opt = document.createElement('option');
            opt.value = h.id;
            opt.textContent = `${h.name} (${h.address})`;
            if (h.id === selectedHeadId) {
                opt.selected = true;
            }
            residentFamilyHeadSelect.appendChild(opt);
        });
    }
    
    // Start Realtime Listener with User-level Isolation
    function startResidentsListening() {
        if (!auth.currentUser) return;
        
        residentsTableBody.innerHTML = '<tr><td colspan="7" class="text-center" style="padding: 2rem;">載入中...</td></tr>';
        
        residentsUnsubscribe = db.collection('residents')
            .where('ownerUid', '==', auth.currentUser.uid)
            .onSnapshot(snapshot => {
                localResidentsData = [];
                snapshot.forEach(doc => {
                    localResidentsData.push({ id: doc.id, ...doc.data() });
                });
                renderResidentsTable();
                updateResidentsStatistics();
                // If relation container is active, refresh the dropdown
                if (!familyHeadSelectContainer.classList.contains('hidden')) {
                    populateFamilyHeadSelect(residentFamilyHeadSelect.value);
                }
            }, error => {
                console.error("Residents sync error:", error);
                residentsTableBody.innerHTML = '<tr><td colspan="7" class="text-center" style="color: var(--color-danger); padding: 2rem;">資料加載失敗，請檢查權限設定。</td></tr>';
            });
    }
    
    // Render Table
    function renderResidentsTable() {
        const query = residentsSearch.value.trim().toLowerCase();
        let filtered = localResidentsData;
        
        if (query) {
            filtered = localResidentsData.filter(r => 
                (r.name && r.name.toLowerCase().includes(query)) || 
                (r.address && r.address.toLowerCase().includes(query)) ||
                (r.phone && r.phone.includes(query))
            );
        }
        
        if (filtered.length === 0) {
            residentsTableBody.innerHTML = '<tr><td colspan="7" class="text-center" style="color: var(--color-text-muted); padding: 2rem;">目前查無保全戶資料。</td></tr>';
            return;
        }
        
        residentsTableBody.innerHTML = filtered.map(r => {
            let relationText = "";
            if (r.relation === 'head') {
                relationText = '<span class="sensor-badge" style="background: rgba(6,182,212,0.15); color: var(--color-cyan);">🏠 戶長 (自立)</span>';
            } else {
                const head = localResidentsData.find(h => h.id === r.householdId);
                const headName = head ? maskName(head.name) : "未知戶長";
                relationText = `<span class="sensor-badge" style="background: rgba(255,255,255,0.06); color: var(--color-text-muted);">👪 家人 (戶長: ${headName})</span>`;
            }
            
            return `
                <tr>
                    <td style="font-weight: 700;">${maskName(r.name || "")}</td>
                    <td>${r.gender === 'male' ? '男' : r.gender === 'female' ? '女' : '其他'}</td>
                    <td style="font-family: monospace;">${r.age ?? ""} 歲</td>
                    <td style="font-family: monospace;">${maskPhone(r.phone || "")}</td>
                    <td style="font-size: 0.8rem; color: var(--color-text-muted); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${maskAddress(r.address || "")}</td>
                    <td>${relationText}</td>
                    <td>
                        <div style="display: flex; gap: 0.4rem;">
                            <button class="btn btn-outline btn-sim" style="font-size: 0.7rem; padding: 0.2rem 0.5rem; border-color: rgba(6,182,212,0.4); color: var(--color-cyan);" onclick="editResident('${r.id}')">✏️ 編輯</button>
                            <button class="btn btn-outline btn-sim" style="font-size: 0.7rem; padding: 0.2rem 0.5rem; border-color: rgba(230,57,70,0.4); color: #f87171;" onclick="deleteResident('${r.id}')">🗑️ 刪除</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }
    
    // Live statistics
    function updateResidentsStatistics() {
        residentsTotalPeople.textContent = localResidentsData.length;
        
        // Count distinct householdIds
        const uniqueHouseholds = new Set(
            localResidentsData.map(r => r.householdId).filter(id => id)
        );
        residentsTotalHouseholds.textContent = uniqueHouseholds.size;
    }
    
    residentsSearch.addEventListener('input', renderResidentsTable);
    
    // Reset Form
    function resetResidentForm() {
        if (residentId) residentId.value = "";
        if (residentsFormTitle) residentsFormTitle.textContent = "➕ 新增保全戶";
        if (residentName) residentName.value = "";
        if (residentGender) residentGender.value = "male";
        if (residentBirthday) residentBirthday.value = "";
        if (residentAge) residentAge.value = "";
        if (residentPhone) residentPhone.value = "";
        if (residentAddress) residentAddress.value = "";
        
        if (residentRelationRadios && residentRelationRadios.length > 0) {
            residentRelationRadios[0].checked = true; // Default head
        }
        syncRelationUI();
        if (btnSaveResident) btnSaveResident.innerHTML = "💾 儲存保全戶";
    }
    
    btnResetResident.addEventListener('click', resetResidentForm);
    
    // Save or Update Resident
    btnSaveResident.addEventListener('click', async () => {
        const nameVal = residentName.value.trim();
        const addressVal = residentAddress.value.trim();
        const birthdayVal = residentBirthday.value;
        const genderVal = residentGender.value;
        const phoneVal = residentPhone.value.trim();
        const relationVal = getSelectedRelation();
        const familyHeadVal = residentFamilyHeadSelect.value;
        
        if (!nameVal || !addressVal || !birthdayVal) {
            alert("請填寫姓名、地址與出生年月日！");
            return;
        }
        
        if (relationVal === 'member' && !familyHeadVal) {
            alert("請選擇此保全戶所屬的戶長家人！");
            return;
        }
        
        const ageVal = parseInt(residentAge.value) || 0;
        
        btnSaveResident.disabled = true;
        btnSaveResident.innerHTML = "正在儲存...";
        
        const id = residentId.value;
        const dataObj = {
            name: nameVal,
            gender: genderVal,
            birthday: birthdayVal,
            age: ageVal,
            phone: phoneVal,
            address: addressVal,
            relation: relationVal,
            ownerUid: auth.currentUser.uid,
            // Keep default evacuation status if new
            evacuationStatus: "none",
            shelterId: ""
        };
        
        try {
            if (id) {
                // Edit
                // If relation changed to head, householdId is himself.
                // If member, householdId is familyHeadVal.
                dataObj.householdId = relationVal === 'head' ? id : familyHeadVal;
                
                // Keep the original evac status from local copy to avoid overwriting
                const original = localResidentsData.find(r => r.id === id);
                if (original) {
                    dataObj.evacuationStatus = original.evacuationStatus || "none";
                    dataObj.shelterId = original.shelterId || "";
                }
                
                await db.collection('residents').doc(id).update(dataObj);
                alert("保全戶資料修改成功！");
            } else {
                // Add
                const docRef = await db.collection('residents').add(dataObj);
                const householdId = relationVal === 'head' ? docRef.id : familyHeadVal;
                await db.collection('residents').doc(docRef.id).update({ householdId: householdId });
                alert("保全戶新增成功！");
            }
            resetResidentForm();
            closeResidentForm(); // 儲存成功後自動關閉彈跳視窗
        } catch (err) {
            console.error("Save resident error:", err);
            alert("儲存失敗：" + err.message);
        } finally {
            btnSaveResident.disabled = false;
            btnSaveResident.innerHTML = id ? "💾 儲存修改" : "💾 儲存保全戶";
        }
    });
    
    // Wire up global edit and delete helpers
    window.editResident = function(id) {
        const res = localResidentsData.find(r => r.id === id);
        if (!res) return;
        
        residentId.value = res.id;
        residentsFormTitle.textContent = "✏️ 修改保全戶資料";
        residentName.value = res.name || "";
        residentGender.value = res.gender || "male";
        residentBirthday.value = res.birthday || "";
        
        // Trigger age recalculate trigger manually
        const event = new Event('change');
        residentBirthday.dispatchEvent(event);
        
        residentPhone.value = res.phone || "";
        residentAddress.value = res.address || "";
        
        if (res.relation === 'head') {
            residentRelationRadios[0].checked = true;
        } else {
            residentRelationRadios[1].checked = true;
        }
        syncRelationUI();
        
        if (res.relation === 'member') {
            residentFamilyHeadSelect.value = res.householdId || "";
        }
        
        btnSaveResident.innerHTML = "💾 儲存修改";
        
        // 彈出表單彈跳視窗
        if (residentFormModal) {
            residentFormModal.classList.add('active');
        }
    };
    
    window.deleteResident = async function(id) {
        if (!confirm("確定要刪除此保全戶資料嗎？相關的家人連動關係可能會受影響。")) return;
        try {
            await db.collection('residents').doc(id).delete();
            alert("保全戶資料已成功刪除！");
            // If we are currently editing the deleted resident, reset form
            if (residentId.value === id) {
                resetResidentForm();
                closeResidentForm();
            }
        } catch (err) {
            console.error("Delete resident error:", err);
            alert("刪除失敗：" + err.message);
        }
    };
}

// 8. SHELTERS & EVACUATION MANAGEMENT SYSTEM (User-level Isolation)
function initSheltersDatabase() {
    const btnOpenShelters = document.getElementById('btnOpenShelters');
    const sheltersModal = document.getElementById('sheltersModal');
    const btnCloseSheltersModal = document.getElementById('btnCloseSheltersModal');
    
    // Shelter Form
    const editShelterId = document.getElementById('editShelterId');
    const shelterNameInput = document.getElementById('shelterNameInput');
    const btnSaveShelter = document.getElementById('btnSaveShelter');
    const btnCancelEditShelter = document.getElementById('btnCancelEditShelter');
    
    // Panels & Tables
    const sheltersTableBody = document.getElementById('sheltersTableBody');
    const evacTableBody = document.getElementById('evacTableBody');
    const sheltersSearch = document.getElementById('sheltersSearch');
    const evacStatusFilter = document.getElementById('evacStatusFilter');
    const chkSelectAllEvac = document.getElementById('chkSelectAllEvac');
    
    // Batch operations
    const batchEvacRadios = document.getElementsByName('batchEvacStatus');
    const batchShelterSelect = document.getElementById('batchShelterSelect');
    const btnSubmitBatchEvac = document.getElementById('btnSubmitBatchEvac');
    
    // Stats Summary
    const evacRelativesCount = document.getElementById('evacRelativesCount');
    const evacShelterCount = document.getElementById('evacShelterCount');
    const evacShelterHouseholds = document.getElementById('evacShelterHouseholds');
    const evacNoneCount = document.getElementById('evacNoneCount');
    const btnResetAllEvac = document.getElementById('btnResetAllEvac');
    
    if (!btnOpenShelters || !sheltersModal || !sheltersTableBody || !evacTableBody) return;
    
    let localSheltersData = [];
    let databaseUnsubscribe = null;
    
    // Open Modal
    btnOpenShelters.addEventListener('click', () => {
        sheltersModal.classList.add('active');
        toggleBodyScroll(true);
        resetShelterForm();
        startDatabaseListening();
    });
    
    // Close Modal
    function closeShelters() {
        sheltersModal.classList.remove('active');
        toggleBodyScroll(false);
        if (databaseUnsubscribe) {
            databaseUnsubscribe();
            databaseUnsubscribe = null;
        }
    }
    
    if (btnCloseSheltersModal) btnCloseSheltersModal.addEventListener('click', closeShelters);
    sheltersModal.addEventListener('click', (e) => {
        if (e.target === sheltersModal) closeShelters();
    });
    
    // Batch radio change listener
    batchEvacRadios.forEach(radio => {
        radio.addEventListener('change', () => {
            batchShelterSelect.disabled = (radio.value !== 'shelter');
            if (radio.value !== 'shelter') batchShelterSelect.value = "";
        });
    });
    
    // Realtime Database Listening (Shelters and Residents combined)
    function startDatabaseListening() {
        if (!auth.currentUser) return;
        
        sheltersTableBody.innerHTML = '<tr><td colspan="3" class="text-center" style="padding: 2rem;">載入中...</td></tr>';
        evacTableBody.innerHTML = '<tr><td colspan="5" class="text-center" style="padding: 2rem;">載入中...</td></tr>';
        
        // Listen to shelters
        const unshelters = db.collection('shelters')
            .where('ownerUid', '==', auth.currentUser.uid)
            .onSnapshot(snapshot => {
                localSheltersData = [];
                snapshot.forEach(doc => {
                    localSheltersData.push({ id: doc.id, ...doc.data() });
                });
                renderSheltersTable();
                populateBatchShelterSelect();
                renderEvacTable();
                updateEvacStatistics();
            }, error => {
                console.error("Shelters sync error:", error);
            });
            
        // Listen to residents (already synced in localResidentsData if open, but here we listen independently for this modal)
        const unresidents = db.collection('residents')
            .where('ownerUid', '==', auth.currentUser.uid)
            .onSnapshot(snapshot => {
                localResidentsData = [];
                snapshot.forEach(doc => {
                    localResidentsData.push({ id: doc.id, ...doc.data() });
                });
                renderSheltersTable();
                renderEvacTable();
                updateEvacStatistics();
            }, error => {
                console.error("Residents sync in shelters error:", error);
            });
            
        databaseUnsubscribe = () => {
            unshelters();
            unresidents();
        };
    }
    
    // Render Shelters list (With custom occupancy statistics: households & people)
    function renderSheltersTable() {
        if (localSheltersData.length === 0) {
            sheltersTableBody.innerHTML = '<tr><td colspan="3" class="text-center" style="color: var(--color-text-muted); padding: 1.5rem;">目前無收容中心資料，請於上方新增。</td></tr>';
            return;
        }
        
        sheltersTableBody.innerHTML = localSheltersData.map(s => {
            // Count people in this shelter
            const inShelter = localResidentsData.filter(r => r.evacuationStatus === 'shelter' && r.shelterId === s.id);
            const peopleCount = inShelter.length;
            const uniqueHouseholds = new Set(inShelter.map(r => r.householdId).filter(id => id)).size;
            
            return `
                <tr>
                    <td style="font-weight: 700; color: #ffffff;">⛺ ${s.name}</td>
                    <td style="font-size: 0.85rem; color: var(--color-success); font-weight: 600;">
                        ${uniqueHouseholds} 戶 ${peopleCount} 人
                    </td>
                    <td>
                        <div style="display: flex; gap: 0.4rem;">
                            <button class="btn btn-outline btn-sim" style="font-size: 0.7rem; padding: 0.2rem 0.5rem; border-color: rgba(255,183,3,0.4); color: var(--color-warning);" onclick="editShelter('${s.id}')">✏️ 編輯</button>
                            <button class="btn btn-outline btn-sim" style="font-size: 0.7rem; padding: 0.2rem 0.5rem; border-color: rgba(230,57,70,0.4); color: #f87171;" onclick="deleteShelter('${s.id}')">🗑️ 刪除</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }
    
    // Populate dropdowns in batch panel
    function populateBatchShelterSelect() {
        batchShelterSelect.innerHTML = '<option value="">-- 選擇收容中心 --</option>';
        localSheltersData.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name;
            batchShelterSelect.appendChild(opt);
        });
    }
    
    // Render Evacuation 명단 Table
    function renderEvacTable() {
        try {
            const query = sheltersSearch ? sheltersSearch.value.trim().toLowerCase() : "";
            const statusFilter = evacStatusFilter ? evacStatusFilter.value : "all";
            let filtered = localResidentsData || [];
            
            // 1. 依避難狀態進行過濾
            if (statusFilter !== 'all') {
                filtered = filtered.filter(r => {
                    if (statusFilter === 'none') {
                        return r.evacuationStatus !== 'relatives' && r.evacuationStatus !== 'shelter';
                    }
                    return r.evacuationStatus === statusFilter;
                });
            }
            
            // 2. 依姓名或地址關鍵字進行搜尋
            if (query) {
                filtered = filtered.filter(r => 
                    (r.name && r.name.toLowerCase().includes(query)) || 
                    (r.address && r.address.toLowerCase().includes(query))
                );
            }
            
            if (filtered.length === 0) {
                if (evacTableBody) {
                    evacTableBody.innerHTML = '<tr><td colspan="5" class="text-center" style="color: var(--color-text-muted); padding: 1.5rem;">查無名冊資料。</td></tr>';
                }
                return;
            }
            
            const html = filtered.map(r => {
                // Find head name
                let headName = "自己";
                if (r.relation === 'member') {
                    const headDoc = localResidentsData.find(h => h.id === r.householdId);
                    headName = headDoc ? maskName(headDoc.name) : "未知戶長";
                }
                
                // Render evac status text
                let statusBadge = "";
                if (r.evacuationStatus === 'relatives') {
                    statusBadge = '<span class="sensor-badge" style="background: rgba(255, 183, 3, 0.15); color: var(--color-warning);">🏡 依親撤離</span>';
                } else if (r.evacuationStatus === 'shelter') {
                    const sh = localSheltersData.find(s => s.id === r.shelterId);
                    const shName = sh ? sh.name : "已刪除的收容所";
                    statusBadge = `<span class="sensor-badge" style="background: rgba(46, 196, 182, 0.15); color: var(--color-success);">⛺ 收容於：${shName}</span>`;
                } else {
                    statusBadge = '<span class="sensor-badge" style="background: rgba(230, 57, 70, 0.15); color: var(--color-danger);">🚨 尚未撤離</span>';
                }
                
                return `
                    <tr>
                        <td><input type="checkbox" class="chk-evac-row" value="${r.id}"></td>
                        <td style="font-weight: 700;">${maskName(r.name)}</td>
                        <td style="font-size: 0.75rem; color: var(--color-text-muted); max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${maskAddress(r.address || "")}</td>
                        <td style="font-size: 0.8rem;">${headName}</td>
                        <td>${statusBadge}</td>
                    </tr>
                `;
            }).join('');
            
            if (evacTableBody) {
                evacTableBody.innerHTML = html;
            }
            
            // Reset check all
            if (chkSelectAllEvac) {
                chkSelectAllEvac.checked = false;
            }
            
            // Bind row checkboxes
            const rows = evacTableBody ? evacTableBody.querySelectorAll('.chk-evac-row') : [];
            rows.forEach(chk => {
                chk.addEventListener('change', () => {
                    const checkedCount = evacTableBody.querySelectorAll('.chk-evac-row:checked').length;
                    if (chkSelectAllEvac) {
                        chkSelectAllEvac.checked = (checkedCount === rows.length);
                    }
                });
            });
        } catch (e) {
            console.error("renderEvacTable error:", e);
        }
    }
    
    // Select all handler
    chkSelectAllEvac.addEventListener('change', () => {
        const isChecked = chkSelectAllEvac.checked;
        const rows = evacTableBody.querySelectorAll('.chk-evac-row');
        rows.forEach(chk => chk.checked = isChecked);
    });
    
    sheltersSearch.addEventListener('input', renderEvacTable);
    if (evacStatusFilter) {
        evacStatusFilter.addEventListener('change', renderEvacTable);
    }
    
    // Recalculate and display statistics
    function updateEvacStatistics() {
        const relatives = localResidentsData.filter(r => r.evacuationStatus === 'relatives');
        evacRelativesCount.textContent = relatives.length;
        
        const shelterList = localResidentsData.filter(r => r.evacuationStatus === 'shelter');
        evacShelterCount.textContent = shelterList.length;
        
        const shelterHouseholds = new Set(shelterList.map(r => r.householdId).filter(id => id));
        evacShelterHouseholds.textContent = shelterHouseholds.size;
        
        const noneList = localResidentsData.filter(r => r.evacuationStatus !== 'relatives' && r.evacuationStatus !== 'shelter');
        evacNoneCount.textContent = noneList.length;
    }
    
    // Save Shelter
    btnSaveShelter.addEventListener('click', async () => {
        const nameVal = shelterNameInput.value.trim();
        if (!nameVal) {
            alert("請輸入收容中心名稱！");
            return;
        }
        
        const id = editShelterId.value;
        btnSaveShelter.disabled = true;
        
        try {
            if (id) {
                await db.collection('shelters').doc(id).update({ name: nameVal });
                alert("收容中心修改成功！");
            } else {
                await db.collection('shelters').add({
                    name: nameVal,
                    ownerUid: auth.currentUser.uid
                });
                alert("收容中心新增成功！");
            }
            resetShelterForm();
        } catch (err) {
            console.error("Save shelter error:", err);
            alert("儲存失敗：" + err.message);
        } finally {
            btnSaveShelter.disabled = false;
        }
    });
    
    function resetShelterForm() {
        editShelterId.value = "";
        shelterNameInput.value = "";
        btnSaveShelter.innerHTML = "💾 儲存收容中心";
        btnCancelEditShelter.classList.add('hidden');
    }
    
    btnCancelEditShelter.addEventListener('click', resetShelterForm);
    
    // Submit Batch evacuation state
    btnSubmitBatchEvac.addEventListener('click', async () => {
        const checkedBoxes = evacTableBody.querySelectorAll('.chk-evac-row:checked');
        if (checkedBoxes.length === 0) {
            alert("請先勾選要變更避難狀態的保全戶！");
            return;
        }
        
        let batchStatusVal = "none";
        for (let r of batchEvacRadios) {
            if (r.checked) {
                batchStatusVal = r.value;
                break;
            }
        }
        
        const shelterIdVal = batchShelterSelect.value;
        if (batchStatusVal === 'shelter' && !shelterIdVal) {
            alert("請選擇所要收容的收容中心！");
            return;
        }
        
        if (!confirm(`確定要將所選 ${checkedBoxes.length} 位保全戶設定為「${batchStatusVal === 'none' ? '尚未撤離' : batchStatusVal === 'relatives' ? '依親' : '收容'}」嗎？`)) return;
        
        btnSubmitBatchEvac.disabled = true;
        btnSubmitBatchEvac.innerHTML = "正在儲存變更...";
        
        const batch = db.batch();
        checkedBoxes.forEach(cb => {
            const rId = cb.value;
            const ref = db.collection('residents').doc(rId);
            batch.update(ref, {
                evacuationStatus: batchStatusVal,
                shelterId: batchStatusVal === 'shelter' ? shelterIdVal : ""
            });
        });
        
        try {
            await batch.commit();
            alert("避難撤離設定已成功批次更新！");
            // Clear checks
            chkSelectAllEvac.checked = false;
            evacTableBody.querySelectorAll('.chk-evac-row').forEach(chk => chk.checked = false);
        } catch (err) {
            console.error("Batch evac update error:", err);
            alert("批次更新失敗：" + err.message);
        } finally {
            btnSubmitBatchEvac.disabled = false;
            btnSubmitBatchEvac.innerHTML = "💾 儲存避難設定";
        }
    });
    
    // Wire up global helpers
    window.editShelter = function(id) {
        const sh = localSheltersData.find(s => s.id === id);
        if (!sh) return;
        
        editShelterId.value = sh.id;
        shelterNameInput.value = sh.name || "";
        btnSaveShelter.innerHTML = "💾 儲存修改";
        btnCancelEditShelter.classList.remove('hidden');
        shelterNameInput.focus();
    };
    
    window.deleteShelter = async function(id) {
        if (!confirm("確定要刪除此收容中心嗎？\n原先收容於此處的保全戶避難狀態將會重設。")) return;
        
        try {
            // Batch reset residents in this shelter
            const resToReset = localResidentsData.filter(r => r.evacuationStatus === 'shelter' && r.shelterId === id);
            const batch = db.batch();
            resToReset.forEach(r => {
                const ref = db.collection('residents').doc(r.id);
                batch.update(ref, {
                    evacuationStatus: "none",
                    shelterId: ""
                });
            });
            await batch.commit();
            
            // Delete shelter
            await db.collection('shelters').doc(id).delete();
            alert("收容中心已成功刪除！");
            if (editShelterId.value === id) resetShelterForm();
        } catch (err) {
            console.error("Delete shelter error:", err);
            alert("刪除失敗：" + err.message);
        }
    };

    // Reset all evacuation status
    if (btnResetAllEvac) {
        btnResetAllEvac.addEventListener('click', async () => {
            if (localResidentsData.length === 0) {
                alert("目前沒有任何保全戶資料可以重置。");
                return;
            }
            
            const needsReset = localResidentsData.filter(r => r.evacuationStatus !== 'none' || (r.shelterId && r.shelterId !== ""));
            if (needsReset.length === 0) {
                alert("所有保全戶均已處於「尚未撤離」狀態。");
                return;
            }
            
            if (!confirm(`警告：此操作將會把本系統全體保全戶（共 ${needsReset.length} 位有撤離狀態者）的避難狀態重置為「尚未撤離」，並清空收容中心關聯。確定要在颱風結束後重置嗎？`)) {
                return;
            }
            
            btnResetAllEvac.disabled = true;
            const originalText = btnResetAllEvac.innerHTML;
            btnResetAllEvac.innerHTML = "🔄 正在重置中...";
            
            try {
                // Limit is 500 writes per batch in Firestore
                const chunks = [];
                for (let i = 0; i < needsReset.length; i += 450) {
                    chunks.push(needsReset.slice(i, i + 450));
                }
                
                for (const chunk of chunks) {
                    const batch = db.batch();
                    chunk.forEach(r => {
                        const ref = db.collection('residents').doc(r.id);
                        batch.update(ref, {
                            evacuationStatus: "none",
                            shelterId: ""
                        });
                    });
                    await batch.commit();
                }
                
                alert("已成功重置全體保全戶之避難狀態！");
            } catch (err) {
                console.error("Reset all evacuation status error:", err);
                alert("重置失敗：" + err.message);
            } finally {
                btnResetAllEvac.disabled = false;
                btnResetAllEvac.innerHTML = originalText;
            }
        });
    }
}

// ==========================================
// RAINFALL GAUGE DETECTION DATA SYSTEM
// ==========================================
let rainfallRecords = [];
let gaugeChartInstance = null;
let rainfallUnsubscribe = null;

function initRainfallGaugeSystem() {
    const btnOpenRainfallGauge = document.getElementById('btnOpenRainfallGauge');
    const rainfallGaugeModal = document.getElementById('rainfallGaugeModal');
    const btnCloseRainfallGaugeModal = document.getElementById('btnCloseRainfallGaugeModal');
    const btnSubmitGaugeRecord = document.getElementById('btnSubmitGaugeRecord');
    const btnCancelGaugeEdit = document.getElementById('btnCancelGaugeEdit');
    const btnExportGaugeChart = document.getElementById('btnExportGaugeChart');
    const btnExportGaugeCsv = document.getElementById('btnExportGaugeCsv');
    const btnResetGaugeData = document.getElementById('btnResetGaugeData');
    
    if (!btnOpenRainfallGauge || !rainfallGaugeModal) return;
    
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, "&amp;")
                  .replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;")
                  .replace(/"/g, "&quot;")
                  .replace(/'/g, "&#039;");
    }
    
    function stopRainfallListening() {
        if (rainfallUnsubscribe) {
            rainfallUnsubscribe();
            rainfallUnsubscribe = null;
        }
    }
    
    function startRainfallListening() {
        stopRainfallListening();
        const currentUser = auth ? auth.currentUser : null;
        if (!currentUser) {
            console.warn("No logged in user found. Cannot listen to rainfall data.");
            return;
        }
        const currentUserId = currentUser.uid;
        
        if (!db || !navigator.onLine) {
            console.log("Offline mode. Loading from localStorage for uid:", currentUserId);
            loadRainfallFromLocalStorage(currentUserId);
            return;
        }
        
        rainfallUnsubscribe = db.collection('rainfall_gauges')
            .where('userId', '==', currentUserId)
            .onSnapshot(snapshot => {
                rainfallRecords = [];
                snapshot.forEach(doc => {
                    rainfallRecords.push({ id: doc.id, ...doc.data() });
                });
                rainfallRecords.sort((a, b) => b.timestamp - a.timestamp);
                localStorage.setItem('offline_rainfall_gauges_' + currentUserId, JSON.stringify(rainfallRecords));
                renderRainfallUI();
            }, error => {
                console.error("Firestore snapshot error for rainfall gauges, using localStorage backup:", error);
                loadRainfallFromLocalStorage(currentUserId);
            });
    }
    
    function loadRainfallFromLocalStorage(userId) {
        if (!userId) return;
        const saved = localStorage.getItem('offline_rainfall_gauges_' + userId);
        rainfallRecords = saved ? JSON.parse(saved) : [];
        renderRainfallUI();
    }
    
    function renderRainfallUI() {
        const tableBody = document.getElementById('gaugeTableBody');
        if (!tableBody) return;
        
        // 動態維護 Location 下拉選單項目 (利用 dataset 快取避免重複繪製)
        const filterSelect = document.getElementById('gaugeLocationFilter');
        const uniqueLocs = [...new Set(rainfallRecords.map(r => r.location).filter(Boolean))].sort();
        const locsJson = JSON.stringify(uniqueLocs);
        
        if (filterSelect && filterSelect.dataset.lastLocs !== locsJson) {
            filterSelect.dataset.lastLocs = locsJson;
            const currentSelected = filterSelect.value;
            
            filterSelect.innerHTML = `<option value="">🔍 所有量測地點</option>`;
            uniqueLocs.forEach(loc => {
                const opt = document.createElement('option');
                opt.value = loc;
                opt.textContent = loc;
                filterSelect.appendChild(opt);
            });
            
            if (uniqueLocs.includes(currentSelected)) {
                filterSelect.value = currentSelected;
            } else {
                filterSelect.value = "";
            }
        }
        
        const selectedLoc = filterSelect ? filterSelect.value : "";
        const displayRecords = selectedLoc ? rainfallRecords.filter(r => r.location === selectedLoc) : rainfallRecords;
        
        // 計算累積降雨量並渲染統計卡片 (動態更新)
        const summaryContainer = document.getElementById('gaugeAccumulationSummary');
        if (summaryContainer) {
            const totals = {};
            rainfallRecords.forEach(record => {
                const loc = record.location || '未知地點';
                const val = parseFloat(record.value) || 0;
                totals[loc] = (totals[loc] || 0) + val;
            });
            
            const totalKeys = Object.keys(totals).sort();
            if (totalKeys.length === 0) {
                summaryContainer.innerHTML = `<span style="font-size: 0.85rem; color: var(--color-text-muted);">尚無累積雨量統計。</span>`;
            } else {
                summaryContainer.innerHTML = totalKeys.map(loc => {
                    const isSelected = selectedLoc === loc;
                    const activeStyle = isSelected 
                        ? 'background: rgba(6, 182, 212, 0.18); border-color: var(--color-cyan); box-shadow: 0 0 10px rgba(6,182,212,0.15);' 
                        : 'background: rgba(255,255,255,0.03); border-color: rgba(255,255,255,0.08);';
                    return `
                        <div class="stat-summary-card" data-location="${escapeHtml(loc)}" style="${activeStyle} padding: 0.55rem 0.85rem; border-radius: 6px; border: 1px solid; display: flex; flex-direction: column; gap: 0.15rem; min-width: 120px; cursor: pointer; transition: all 0.2s;">
                            <span style="font-size: 0.75rem; color: var(--color-text-muted); font-weight: 500;">${escapeHtml(loc)}</span>
                            <span style="font-size: 1.15rem; font-weight: bold; color: ${isSelected ? 'var(--color-cyan)' : '#ffffff'};">${totals[loc].toFixed(1)} <span style="font-size: 0.7rem; font-weight: normal; color: var(--color-text-muted);">mm</span></span>
                        </div>
                    `;
                }).join('');
                
                // 點擊卡片與下拉選單連動篩選
                summaryContainer.querySelectorAll('.stat-summary-card').forEach(card => {
                    card.addEventListener('click', () => {
                        const clickedLoc = card.getAttribute('data-location');
                        if (filterSelect) {
                            if (filterSelect.value === clickedLoc) {
                                filterSelect.value = "";
                            } else {
                                filterSelect.value = clickedLoc;
                            }
                            renderRainfallUI();
                        }
                    });
                });
            }
        }
        
        if (displayRecords.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="4" class="text-center" style="padding: 2rem; color: var(--color-text-muted);">無歷史登錄資料。</td></tr>`;
        } else {
            tableBody.innerHTML = displayRecords.map(record => {
                const dateStr = record.timestamp ? new Date(record.timestamp).toLocaleString() : 'N/A';
                return `
                    <tr>
                        <td>${escapeHtml(record.location)}</td>
                        <td>${Number(record.value).toFixed(1)}</td>
                        <td>${dateStr}</td>
                        <td>
                            <button class="btn btn-outline edit-gauge-btn" data-id="${record.id}" style="font-size: 0.75rem; padding: 0.2rem 0.5rem; min-height: auto; margin-right: 0.25rem; border-color: var(--color-cyan); color: var(--color-cyan);">✏️ 編輯</button>
                            <button class="btn btn-outline delete-gauge-btn" data-id="${record.id}" style="font-size: 0.75rem; padding: 0.2rem 0.5rem; min-height: auto; border-color: var(--color-danger); color: var(--color-danger);">🗑️ 刪除</button>
                        </td>
                    </tr>
                `;
            }).join('');
            
            tableBody.querySelectorAll('.edit-gauge-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = btn.getAttribute('data-id');
                    editGaugeRecord(id);
                });
            });
            tableBody.querySelectorAll('.delete-gauge-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = btn.getAttribute('data-id');
                    deleteGaugeRecord(id);
                });
            });
        }
        
        updateRainfallChart();
    }
    
    function updateRainfallChart() {
        const canvas = document.getElementById('gaugeChartCanvas');
        if (!canvas) return;
        
        if (gaugeChartInstance) {
            gaugeChartInstance.destroy();
            gaugeChartInstance = null;
        }
        
        if (typeof Chart === 'undefined') {
            console.error("Chart.js is not loaded.");
            return;
        }
        
        const filterSelect = document.getElementById('gaugeLocationFilter');
        const selectedLoc = filterSelect ? filterSelect.value : "";
        const ctx = canvas.getContext('2d');
        
        // 建立漸層
        const barGradient = ctx.createLinearGradient(0, 0, 0, 200);
        barGradient.addColorStop(0, 'rgba(6, 182, 212, 0.85)');
        barGradient.addColorStop(1, 'rgba(59, 130, 246, 0.15)');
        
        let chartData = {};
        let chartOptions = {};
        
        if (selectedLoc === "") {
            // A. 所有地點累積與最大單次雨量對比 (混合圖表)
            const totals = {};
            const maxVal = {};
            rainfallRecords.forEach(record => {
                const loc = record.location || '未知地點';
                const val = parseFloat(record.value) || 0;
                totals[loc] = (totals[loc] || 0) + val;
                if (!maxVal[loc] || val > maxVal[loc]) {
                    maxVal[loc] = val;
                }
            });
            
            const labels = Object.keys(totals).sort();
            const accData = labels.map(loc => totals[loc]);
            const maxData = labels.map(loc => maxVal[loc]);
            
            chartData = {
                labels: labels,
                datasets: [
                    {
                        type: 'bar',
                        label: '累積總雨量 (mm)',
                        data: accData,
                        backgroundColor: barGradient,
                        borderColor: 'rgba(6, 182, 212, 1)',
                        borderWidth: 1.5,
                        borderRadius: 4,
                        barPercentage: 0.45,
                        order: 2
                    },
                    {
                        type: 'line',
                        label: '單次最高雨量 (mm)',
                        data: maxData,
                        borderColor: 'rgba(239, 68, 68, 1)',
                        backgroundColor: 'rgba(239, 68, 68, 0.1)',
                        borderWidth: 2,
                        tension: 0.3,
                        fill: false,
                        pointBackgroundColor: 'rgba(239, 68, 68, 1)',
                        order: 1
                    }
                ]
            };
            
            chartOptions = {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: {
                        display: true,
                        text: '各地點累積雨量與單次最高雨量統計圖',
                        color: '#e2e8f0',
                        font: { size: 12, weight: 'bold', family: 'Inter, sans-serif' },
                        padding: { bottom: 10 }
                    },
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: '#e2e8f0',
                            font: { size: 10, family: 'Inter, sans-serif' }
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(15, 23, 42, 0.9)',
                        titleColor: '#fff',
                        bodyColor: '#38bdf8',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: 'rgba(255, 255, 255, 0.08)' },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.6)',
                            callback: function(value) { return value + ' mm'; }
                        }
                    },
                    x: {
                        grid: { display: false },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.8)',
                            font: { weight: 'bold', family: 'Inter, sans-serif' }
                        }
                    }
                }
            };
            
        } else {
            // B. 特定地點降雨趨勢 (當次降雨 vs 累積趨勢，雙 Y 軸混合圖表)
            const locRecords = rainfallRecords.filter(r => r.location === selectedLoc).sort((a, b) => a.timestamp - b.timestamp);
            
            const labels = locRecords.map(r => {
                if (!r.timestamp) return 'N/A';
                const d = new Date(r.timestamp);
                return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            });
            
            const singleData = locRecords.map(r => parseFloat(r.value) || 0);
            
            let currentSum = 0;
            const cumData = locRecords.map(r => {
                currentSum += parseFloat(r.value) || 0;
                return currentSum;
            });
            
            chartData = {
                labels: labels,
                datasets: [
                    {
                        type: 'bar',
                        label: '當次雨量 (mm)',
                        data: singleData,
                        backgroundColor: barGradient,
                        borderColor: 'rgba(6, 182, 212, 1)',
                        borderWidth: 1.5,
                        borderRadius: 4,
                        barPercentage: 0.45,
                        yAxisID: 'ySingle',
                        order: 2
                    },
                    {
                        type: 'line',
                        label: '累積趨勢 (mm)',
                        data: cumData,
                        borderColor: 'rgba(245, 158, 11, 1)',
                        backgroundColor: 'rgba(245, 158, 11, 0.1)',
                        borderWidth: 2.5,
                        tension: 0.2,
                        fill: false,
                        pointBackgroundColor: 'rgba(245, 158, 11, 1)',
                        yAxisID: 'yCumulative',
                        order: 1
                    }
                ]
            };
            
            chartOptions = {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: {
                        display: true,
                        text: `${selectedLoc} - 降雨歷史趨勢圖`,
                        color: '#e2e8f0',
                        font: { size: 12, weight: 'bold', family: 'Inter, sans-serif' },
                        padding: { bottom: 10 }
                    },
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: '#e2e8f0',
                            font: { size: 10, family: 'Inter, sans-serif' }
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(15, 23, 42, 0.9)',
                        titleColor: '#fff',
                        bodyColor: '#38bdf8',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1
                    }
                },
                scales: {
                    ySingle: {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: '當次雨量 (mm)',
                            color: 'rgba(6, 182, 212, 1)',
                            font: { family: 'Inter, sans-serif', weight: 'bold' }
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.08)' },
                        ticks: { color: 'rgba(255, 255, 255, 0.6)' }
                    },
                    yCumulative: {
                        type: 'linear',
                        display: true,
                        position: 'right',
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: '累積趨勢 (mm)',
                            color: 'rgba(245, 158, 11, 1)',
                            font: { family: 'Inter, sans-serif', weight: 'bold' }
                        },
                        grid: { drawOnChartArea: false },
                        ticks: { color: 'rgba(255, 255, 255, 0.6)' }
                    },
                    x: {
                        grid: { display: false },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.8)',
                            font: { size: 9, family: 'Inter, sans-serif' }
                        }
                    }
                }
            };
        }
        
        gaugeChartInstance = new Chart(ctx, {
            data: chartData,
            options: chartOptions
        });
    }
    
    function editGaugeRecord(id) {
        const record = rainfallRecords.find(r => r.id === id);
        if (!record) return;
        
        document.getElementById('gaugeRecordId').value = record.id;
        document.getElementById('gaugeLocation').value = record.location;
        document.getElementById('gaugeValue').value = record.value;
        
        document.getElementById('gaugeFormTitle').textContent = "✏️ 修改雨量資料";
        document.getElementById('btnCancelGaugeEdit').style.display = 'inline-block';
    }
    
    function cancelGaugeEdit() {
        document.getElementById('gaugeRecordId').value = "";
        document.getElementById('gaugeLocation').value = "";
        document.getElementById('gaugeValue').value = "";
        
        document.getElementById('gaugeFormTitle').textContent = "📝 登錄雨量資料";
        document.getElementById('btnCancelGaugeEdit').style.display = 'none';
    }
    
    async function submitGaugeRecord() {
        const currentUser = auth ? auth.currentUser : null;
        if (!currentUser) {
            alert("登入逾時，請重新登入！");
            return;
        }
        const currentUserId = currentUser.uid;

        const locationInput = document.getElementById('gaugeLocation');
        const valueInput = document.getElementById('gaugeValue');
        const recordIdInput = document.getElementById('gaugeRecordId');
        
        const location = locationInput.value.trim();
        const valStr = valueInput.value.trim();
        
        if (!location) {
            alert("請輸入測量地點！");
            return;
        }
        if (valStr === "" || isNaN(parseFloat(valStr))) {
            alert("請輸入有效的雨量筒數據 (mm)！");
            return;
        }
        
        const value = parseFloat(valStr);
        const id = recordIdInput.value;
        const isEdit = !!id;
        const timestamp = Date.now();
        
        const submitBtn = document.getElementById('btnSubmitGaugeRecord');
        submitBtn.disabled = true;
        submitBtn.textContent = "儲存中...";
        
        try {
            if (db && navigator.onLine) {
                if (isEdit) {
                    await db.collection('rainfall_gauges').doc(id).update({
                        location,
                        value,
                        timestamp,
                        userId: currentUserId
                    });
                } else {
                    await db.collection('rainfall_gauges').add({
                        location,
                        value,
                        timestamp,
                        userId: currentUserId
                    });
                }
            } else {
                console.log("Saving in offline mode to LocalStorage.");
                if (isEdit) {
                    const idx = rainfallRecords.findIndex(r => r.id === id);
                    if (idx !== -1) {
                        rainfallRecords[idx] = { id, location, value, timestamp, userId: currentUserId };
                    }
                } else {
                    const newId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                    rainfallRecords.push({ id: newId, location, value, timestamp, userId: currentUserId });
                }
                rainfallRecords.sort((a, b) => b.timestamp - a.timestamp);
                localStorage.setItem('offline_rainfall_gauges_' + currentUserId, JSON.stringify(rainfallRecords));
                renderRainfallUI();
            }
            
            cancelGaugeEdit();
        } catch (error) {
            console.error("Error saving rainfall gauge record:", error);
            alert("儲存失敗，請重試：" + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = "💾 儲存資料";
        }
    }
    
    async function deleteGaugeRecord(id) {
        if (!confirm("確定要刪除此筆雨量資料嗎？")) return;
        const currentUser = auth ? auth.currentUser : null;
        if (!currentUser) return;
        const currentUserId = currentUser.uid;
        
        try {
            if (db && navigator.onLine) {
                await db.collection('rainfall_gauges').doc(id).delete();
            } else {
                rainfallRecords = rainfallRecords.filter(r => r.id !== id);
                localStorage.setItem('offline_rainfall_gauges_' + currentUserId, JSON.stringify(rainfallRecords));
                renderRainfallUI();
            }
        } catch (error) {
            console.error("Error deleting gauge record:", error);
            alert("刪除失敗：" + error.message);
        }
    }
    
    async function resetGaugeData() {
        const currentUser = auth ? auth.currentUser : null;
        if (!currentUser) return;
        const currentUserId = currentUser.uid;

        if (!confirm("警告：此操作將會清空您所有雨量筒偵測紀錄！\n確定要執行一鍵重製嗎？")) {
            return;
        }
        if (!confirm("請再次確認：您確定要徹底清除您帳號下所有累積的降雨量數據嗎？此操作將無法還原。")) {
            return;
        }
        
        const resetBtn = document.getElementById('btnResetGaugeData');
        resetBtn.disabled = true;
        const originalText = resetBtn.textContent;
        resetBtn.textContent = "🔄 正在重製數據...";
        
        try {
            if (db && navigator.onLine) {
                const snapshot = await db.collection('rainfall_gauges').where('userId', '==', currentUserId).get();
                if (snapshot.size > 0) {
                    const chunks = [];
                    const docs = snapshot.docs;
                    for (let i = 0; i < docs.length; i += 450) {
                        chunks.push(docs.slice(i, i + 450));
                    }
                    
                    for (const chunk of chunks) {
                        const batch = db.batch();
                        chunk.forEach(doc => {
                            batch.delete(doc.ref);
                        });
                        await batch.commit();
                    }
                }
            }
            
            rainfallRecords = [];
            localStorage.removeItem('offline_rainfall_gauges_' + currentUserId);
            renderRainfallUI();
            alert("您帳號下的所有雨量筒偵測資料已被重置成功！");
        } catch (error) {
            console.error("Error resetting rainfall gauge data:", error);
            alert("重置失敗：" + error.message);
        } finally {
            resetBtn.disabled = false;
            resetBtn.textContent = originalText;
        }
    }
    
    function exportGaugeCsv() {
        const filterSelect = document.getElementById('gaugeLocationFilter');
        const selectedLoc = filterSelect ? filterSelect.value : "";
        const recordsToExport = selectedLoc ? rainfallRecords.filter(r => r.location === selectedLoc) : rainfallRecords;
        
        if (recordsToExport.length === 0) {
            alert("無符合篩選條件的歷史資料可供匯出。");
            return;
        }
        
        let csvContent = "\ufeff測量地點,單次雨量 (mm),輸入時間\r\n";
        
        recordsToExport.forEach(r => {
            const timeStr = r.timestamp ? new Date(r.timestamp).toLocaleString() : 'N/A';
            const loc = (r.location || '').replace(/"/g, '""');
            csvContent += `"${loc}",${Number(r.value).toFixed(1)},"${timeStr}"\r\n`;
        });
        
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const hh = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        
        link.setAttribute("href", url);
        link.setAttribute("download", `雨量筒偵測數據_${yyyy}${mm}${dd}_${hh}${min}${ss}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
    
    function exportGaugeChart() {
        const canvas = document.getElementById('gaugeChartCanvas');
        if (!canvas) {
            alert("找不到圖表畫布！");
            return;
        }
        
        if (rainfallRecords.length === 0) {
            alert("尚無雨量數據，無法生成統計圖表圖片。");
            return;
        }
        
        try {
            const imageURI = canvas.toDataURL("image/png");
            const link = document.createElement("a");
            
            const now = new Date();
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const hh = String(now.getHours()).padStart(2, '0');
            const min = String(now.getMinutes()).padStart(2, '0');
            const ss = String(now.getSeconds()).padStart(2, '0');
            
            link.setAttribute("href", imageURI);
            link.setAttribute("download", `雨量累積統計圖_${yyyy}${mm}${dd}_${hh}${min}${ss}.png`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } catch (error) {
            console.error("Failed to export chart image:", error);
            alert("圖表圖片匯出失敗，可能由於瀏覽器安全限制。");
        }
    }
    
    btnOpenRainfallGauge.addEventListener('click', () => {
        rainfallGaugeModal.classList.add('active');
        toggleBodyScroll(true);
        startRainfallListening();
    });
    
    btnCloseRainfallGaugeModal.addEventListener('click', () => {
        rainfallGaugeModal.classList.remove('active');
        toggleBodyScroll(false);
        stopRainfallListening();
    });
    
    btnSubmitGaugeRecord.addEventListener('click', submitGaugeRecord);
    
    if (btnCancelGaugeEdit) {
        btnCancelGaugeEdit.addEventListener('click', cancelGaugeEdit);
    }
    
    if (btnResetGaugeData) {
        btnResetGaugeData.addEventListener('click', resetGaugeData);
    }
    
    if (btnExportGaugeCsv) {
        btnExportGaugeCsv.addEventListener('click', exportGaugeCsv);
    }
    
    if (btnExportGaugeChart) {
        btnExportGaugeChart.addEventListener('click', exportGaugeChart);
    }
    
    const filterSelect = document.getElementById('gaugeLocationFilter');
    if (filterSelect) {
        filterSelect.addEventListener('change', () => {
            renderRainfallUI();
        });
    }
    
    window.addEventListener('online', () => {
        if (rainfallGaugeModal.classList.contains('active')) {
            startRainfallListening();
        }
    });
    window.addEventListener('offline', () => {
        if (rainfallGaugeModal.classList.contains('active')) {
            const currentUser = auth ? auth.currentUser : null;
            if (currentUser) {
                loadRainfallFromLocalStorage(currentUser.uid);
            }
        }
    });
}

