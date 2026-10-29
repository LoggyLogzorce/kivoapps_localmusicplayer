const { app, BrowserWindow, ipcMain, globalShortcut, session } = require('electron');
const path = require('path');
const fs = require('fs');

app.name = 'KivoPlayer';

// ══════════════════════════════════════════════════════
//  ЛОГИ
// ══════════════════════════════════════════════════════
const TAG = '%c[Киво:main]';
const TAG_CSS = 'color:#4dabf7;font-weight:700';

// дублируем логи main-процесса в консоль DevTools рендерера,
// иначе при обычном запуске (без терминала) их не видно
function forwardLog(level, args) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const text = args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');
    try { mainWindow.webContents.send('voice:log', { level, text }); } catch (_) {}
}

const mlog = {
    step: (...a) => { console.log(TAG, TAG_CSS, ...a); forwardLog('log', a); },
    ok:   (...a) => { console.log(TAG, TAG_CSS, '✓', ...a); forwardLog('log', ['✓', ...a]); },
    warn: (...a) => { console.warn(TAG, TAG_CSS, '⚠', ...a); forwardLog('warn', ['⚠', ...a]); },
    err:  (...a) => { console.error(TAG, TAG_CSS, '✕', ...a); forwardLog('error', ['✕', ...a]); }
};
const elapsed = (t0) => (Date.now() - t0) + ' мс';

let mainWindow = null;

// ══════════════════════════════════════════════════════
//  VOICE CONFIG  (ключ живёт только в main-процессе)
// ══════════════════════════════════════════════════════

const VOICE_DEFAULTS = {
    baseUrl: 'https://api.xkiro.com/v1',
    apiKey: '',
    chatModel: 'qwen/qwen3.5-flash:free',
    asrModel: 'qwen/qwen3-omni-flash:free',
    asrTranscribeModel: 'whisper-1',
    // Провайдер распознавания речи.
    // xkiro — исторический путь, НЕ РАБОТАЕТ: шлюз выбрасывает аудио.
    asrProvider: 'xkiro',        // xkiro | openai | dashscope
    asrBaseUrl: '',
    asrApiKey: '',
    asrLanguage: 'ru',
    ttsModel: 'xkiro-voice',
    ttsVoice: 'female-voice-russian',
    wakeWord: 'киво',
    hotkey: 'Control+Alt+Space',
    enabled: false,
    ttsEnabled: true,
    vadThreshold: 0.012,
    // ── разговорный режим ──
    chatMode: true,              // отвечать на вопросы, а не только выполнять команды
    contextTurns: 6,             // сколько реплик диалога помнить
    // ── активация ──
    activationMode: 'wake',      // 'wake' — по слову-активатору | 'always' — слушать всё
    followUpSec: 5,              // сколько секунд слушать без слова-активатора после ответа
    duckMusic: true,             // приглушать музыку, пока записывается фраза
    language: 'ru'
};

function voiceFile() {
    return path.join(app.getPath('userData'), 'kivo-voice.json');
}

function readVoiceConfig() {
    try {
        const raw = fs.readFileSync(voiceFile(), 'utf8');
        return Object.assign({}, VOICE_DEFAULTS, JSON.parse(raw));
    } catch (e) {
        return Object.assign({}, VOICE_DEFAULTS);
    }
}

function writeVoiceConfig(patch) {
    const next = Object.assign(readVoiceConfig(), patch || {});
    const changed = Object.keys(patch || {});
    if (changed.length) {
        mlog.step('сохраняю настройки:', changed.map(k =>
            k === 'apiKey' ? 'apiKey=••••' + String(patch[k] || '').slice(-4) : k + '=' + JSON.stringify(patch[k])
        ).join(', '));
    }
    try {
        fs.mkdirSync(path.dirname(voiceFile()), { recursive: true });
        fs.writeFileSync(voiceFile(), JSON.stringify(next, null, 2), 'utf8');
    } catch (e) {
        console.error('[voice] config write failed:', e.message);
    }
    return next;
}

// renderer никогда не должен видеть сам ключ
function publicVoiceConfig() {
    const c = readVoiceConfig();
    return {
        baseUrl: c.baseUrl,
        chatModel: c.chatModel,
        asrModel: c.asrModel,
        asrProvider: c.asrProvider,
        asrBaseUrl: c.asrBaseUrl,
        asrLanguage: c.asrLanguage,
        hasAsrKey: !!c.asrApiKey,
        asrKeyTail: c.asrApiKey ? c.asrApiKey.slice(-4) : '',
        ttsModel: c.ttsModel,
        ttsVoice: c.ttsVoice,
        wakeWord: c.wakeWord,
        hotkey: c.hotkey,
        enabled: !!c.enabled,
        ttsEnabled: !!c.ttsEnabled,
        chatMode: c.chatMode !== false,
        contextTurns: c.contextTurns,
        activationMode: c.activationMode,
        followUpSec: c.followUpSec,
        duckMusic: c.duckMusic !== false,
        vadThreshold: c.vadThreshold,
        language: c.language,
        hasKey: !!c.apiKey,
        keyTail: c.apiKey ? c.apiKey.slice(-4) : ''
    };
}

// ══════════════════════════════════════════════════════
//  HTTP helpers
// ══════════════════════════════════════════════════════

function apiBase() {
    return String(readVoiceConfig().baseUrl || VOICE_DEFAULTS.baseUrl).replace(/\/+$/, '');
}

async function apiFetchAt(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 60000);
    try {
        const res = await fetch(url, {
            method: options.method || 'POST',
            headers: options.headers || {},
            body: options.body,
            signal: controller.signal
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            const err = new Error('HTTP ' + res.status + (detail ? ': ' + detail.slice(0, 300) : ''));
            err.code = 'HTTP_' + res.status;
            throw err;
        }
        return res;
    } finally {
        clearTimeout(timer);
    }
}

async function apiFetch(pathname, options = {}) {
    const cfg = readVoiceConfig();
    if (!cfg.apiKey) {
        const err = new Error('Не задан API-ключ xKiro');
        err.code = 'NO_KEY';
        throw err;
    }

    const controller = new AbortController();
    const timeout = options.timeout || 60000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const res = await fetch(apiBase() + pathname, {
            method: options.method || 'POST',
            headers: Object.assign(
                { Authorization: 'Bearer ' + cfg.apiKey },
                options.headers || {}
            ),
            body: options.body,
            signal: controller.signal
        });

        if (!res.ok) {
            let detail = '';
            try {
                const text = await res.text();
                try {
                    const json = JSON.parse(text);
                    detail = (json.error && (json.error.message || json.error)) || json.message || text;
                } catch (_) {
                    detail = text;
                }
            } catch (_) {}
            const err = new Error('HTTP ' + res.status + (detail ? ': ' + String(detail).slice(0, 300) : ''));
            err.code = 'HTTP_' + res.status;
            err.status = res.status;
            throw err;
        }
        return res;
    } finally {
        clearTimeout(timer);
    }
}

function base64ToBuffer(b64) {
    const clean = String(b64).replace(/^data:[^;]+;base64,/, '');
    return Buffer.from(clean, 'base64');
}

// ══════════════════════════════════════════════════════
//  ASR — xKiro официально STT не документирует,
//  поэтому пробуем несколько путей и запоминаем рабочий
// ══════════════════════════════════════════════════════

let asrStrategy = null; // 'transcriptions' | 'chat_input_audio' | 'chat_audio_url'

async function asrViaTranscriptions(buffer, mime) {
    const cfg = readVoiceConfig();
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime || 'audio/wav' }), 'speech.wav');
    form.append('model', cfg.asrTranscribeModel || 'whisper-1');
    if (cfg.language) form.append('language', cfg.language);

    const res = await apiFetch('/audio/transcriptions', { method: 'POST', body: form, timeout: 60000 });
    const data = await res.json();
    const text = (data && (data.text || (data.results && data.results[0] && data.results[0].text))) || '';
    if (!text) throw new Error('пустой ответ');
    return String(text).trim();
}

async function asrViaChat(base64, variant) {
    const cfg = readVoiceConfig();
    const instruction = cfg.language === 'ru'
        ? 'Распознай речь из аудио дословно. Верни только текст, без пояснений и кавычек.'
        : 'Transcribe the audio verbatim. Return only the text, no commentary or quotes.';

    const audioPart = variant === 'chat_audio_url'
        ? { type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,' + base64 } }
        : { type: 'input_audio', input_audio: { data: base64, format: 'wav' } };

    const body = JSON.stringify({
        model: cfg.asrModel,
        messages: [{
            role: 'user',
            content: [{ type: 'text', text: instruction }, audioPart]
        }],
        temperature: 0,
        max_tokens: 400
    });

    const res = await apiFetch('/chat/completions', {
        headers: { 'Content-Type': 'application/json' },
        body,
        timeout: 60000
    });
    const data = await res.json();
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    let text = msg ? (typeof msg.content === 'string' ? msg.content : '') : '';
    text = String(text).trim().replace(/^["'«»]+|["'«»]+$/g, '').trim();
    if (!text) throw new Error('пустой ответ');
    return text;
}

// ── OpenAI-совместимый STT: Groq, OpenAI, локальный whisper-server ──
async function transcribeOpenAI(base64, cfg) {
    const base = String(cfg.asrBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const key = cfg.asrApiKey || cfg.apiKey;
    if (!key) {
        const err = new Error('Не задан ключ STT');
        err.code = 'NO_KEY';
        throw err;
    }

    const buffer = base64ToBuffer(base64);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', cfg.asrModel || 'whisper-1');
    if (cfg.asrLanguage) form.append('language', cfg.asrLanguage);
    form.append('response_format', 'json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
        const res = await fetch(base + '/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + key },
            body: form,
            signal: controller.signal
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            const err = new Error('HTTP ' + res.status + (detail ? ': ' + detail.slice(0, 300) : ''));
            err.code = 'HTTP_' + res.status;
            throw err;
        }
        const data = await res.json();
        const text = (data && (data.text || (data.results && data.results[0] && data.results[0].text))) || '';
        if (!String(text).trim()) throw new Error('пустой ответ');
        return String(text).trim();
    } finally {
        clearTimeout(timer);
    }
}

// ── DashScope: qwen3-asr-flash через /chat/completions ──
async function transcribeDashScope(base64, cfg) {
    const base = String(cfg.asrBaseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
    const key = cfg.asrApiKey || cfg.apiKey;
    if (!key) {
        const err = new Error('Не задан ключ STT');
        err.code = 'NO_KEY';
        throw err;
    }

    const body = {
        model: cfg.asrModel || 'qwen3-asr-flash',
        messages: [{
            role: 'user',
            content: [{
                type: 'input_audio',
                input_audio: { data: 'data:audio/wav;base64,' + base64 }
            }]
        }],
        stream: false
    };

    const res = await apiFetchAt(base + '/chat/completions', {
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
        timeout: 60000
    });
    const data = await res.json();
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    let content = msg ? msg.content : '';
    if (Array.isArray(content)) content = content.map(p => p.text || p.transcript || '').join(' ');
    const text = String(content || '').trim();
    if (!text) throw new Error('пустой ответ');
    return text;
}

async function transcribe(base64) {
    const cfg = readVoiceConfig();
    const provider = cfg.asrProvider || 'xkiro';

    if (provider === 'openai' || provider === 'dashscope') {
        const t0 = Date.now();
        mlog.step(`распознавание · провайдер ${provider} · модель ${cfg.asrModel} · ${(base64.length / 1024).toFixed(1)} КБ`);
        try {
            const text = provider === 'openai'
                ? await transcribeOpenAI(base64, cfg)
                : await transcribeDashScope(base64, cfg);
            mlog.ok(`ASR [${provider}] ok за ${elapsed(t0)} → «${String(text).slice(0, 80)}»`);
            return { ok: true, text, strategy: provider, provider, tried: [] };
        } catch (e) {
            mlog.err(`ASR [${provider}] не вышло за ${elapsed(t0)}: ${e.message}`);
            return { ok: false, error: e.message, provider, tried: [{ strategy: provider, error: e.message }] };
        }
    }

    const buffer = base64ToBuffer(base64);
    const order = asrStrategy
        ? [asrStrategy].concat(['transcriptions', 'chat_input_audio', 'chat_audio_url'].filter(s => s !== asrStrategy))
        : ['transcriptions', 'chat_input_audio', 'chat_audio_url'];

    const tried = [];
    mlog.step(`распознавание · ${(base64.length / 1024).toFixed(1)} КБ base64 · модель ${readVoiceConfig().asrModel}`);
    mlog.step('порядок стратегий:', order.join(' → '));

    for (const strategy of order) {
        const t0 = Date.now();
        try {
            let text;
            if (strategy === 'transcriptions') text = await asrViaTranscriptions(buffer, 'audio/wav');
            else text = await asrViaChat(base64, strategy);

            if (asrStrategy !== strategy) mlog.step('рабочая стратегия ASR:', strategy);
            asrStrategy = strategy;
            mlog.ok(`ASR [${strategy}] ok за ${elapsed(t0)} → «${String(text).slice(0, 80)}»`);
            return { ok: true, text, strategy, tried };
        } catch (e) {
            tried.push({ strategy, error: e.message });
            mlog.warn(`ASR [${strategy}] не вышло за ${elapsed(t0)}: ${e.message}`);
            // неверный ключ — дальше пробовать бессмысленно
            if (e.code === 'NO_KEY' || e.code === 'HTTP_401' || e.code === 'HTTP_403') {
                mlog.err('ключ не принят — остальные стратегии не пробую');
                break;
            }
        }
    }
    mlog.err('все стратегии xKiro провалились — xKiro не поддерживает распознавание речи');
    mlog.warn('выберите провайдера STT в настройках: шестерёнка «Киво» → «Распознавание речи»');
    return { ok: false, error: tried.length ? tried[tried.length - 1].error : 'unknown', provider: 'xkiro', tried };
}

// ══════════════════════════════════════════════════════
//  IPC
// ══════════════════════════════════════════════════════

ipcMain.handle('normalize-audio-file', async (_, filePath) => {
    console.log('normalize:', filePath);
    return { ok: true };
});

ipcMain.handle('voice:get-config', () => publicVoiceConfig());

ipcMain.handle('voice:set-config', (_, patch) => {
    const clean = Object.assign({}, patch || {});
    delete clean.hasKey;
    delete clean.keyTail;
    delete clean.hasAsrKey;
    delete clean.asrKeyTail;
    const next = writeVoiceConfig(clean);
    if (Object.prototype.hasOwnProperty.call(clean, 'hotkey')) registerHotkey(next.hotkey);
    asrStrategy = null;
    return publicVoiceConfig();
});

ipcMain.handle('voice:chat', async (_, payload) => {
    const cfg = readVoiceConfig();
    const body = Object.assign(
        { model: payload.model || cfg.chatModel, temperature: 0.2 },
        payload.body || {}
    );
    const t0 = Date.now();
    mlog.step(`чат · ${body.model} · сообщений: ${(body.messages || []).length}`);
    const res = await apiFetch('/chat/completions', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: payload.timeout || 30000
    });
    const data = await res.json();
    const usage = data && data.usage;
    mlog.ok(`чат ответил за ${elapsed(t0)}` + (usage ? ` · токены: ${usage.prompt_tokens}+${usage.completion_tokens}` : ''));
    return data;
});

ipcMain.handle('voice:tts', async (_, payload) => {
    const cfg = readVoiceConfig();
    const body = {
        model: payload.model || cfg.ttsModel,
        input: String(payload.text || '').slice(0, 600),
        voice: payload.voice || cfg.ttsVoice,
        response_format: 'mp3'
    };
    if (payload.speed) body.speed = payload.speed;

    const t0 = Date.now();
    mlog.step(`озвучка · ${body.voice} · ${body.input.length} симв.`);
    const res = await apiFetch('/audio/speech', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 45000
    });
    const buf = Buffer.from(await res.arrayBuffer());
    mlog.ok(`озвучка получена за ${elapsed(t0)} · ${(buf.length / 1024).toFixed(0)} КБ`);
    return { ok: true, mime: 'audio/mpeg', audio: buf.toString('base64') };
});

ipcMain.handle('voice:asr', async (_, payload) => {
    try {
        return await transcribe(payload.data);
    } catch (e) {
        mlog.err('ASR упал:', e.message);
        return { ok: false, error: e.message, tried: [] };
    }
});

ipcMain.handle('voice:voices', async () => {
    try {
        const res = await fetch(apiBase() + '/audio/voices?language=ru', { method: 'GET' });
        if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
        const data = await res.json();
        return { ok: true, voices: data.voices || [] };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('voice:ping', async () => {
    try {
        const res = await fetch(apiBase() + '/models', { method: 'GET' });
        return { ok: res.ok, status: res.status };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ══════════════════════════════════════════════════════
//  WINDOW + HOTKEY
// ══════════════════════════════════════════════════════

function registerHotkey(accelerator) {
    globalShortcut.unregisterAll();
    const acc = accelerator || readVoiceConfig().hotkey;
    if (!acc) return false;
    try {
        const ok = globalShortcut.register(acc, () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('voice:hotkey');
            }
        });
        if (ok) mlog.ok('горячая клавиша зарегистрирована:', acc);
        else mlog.warn('горячая клавиша занята другой программой:', acc);
        return ok;
    } catch (e) {
        mlog.err('не удалось зарегистрировать горячую клавишу:', acc, e.message);
        return false;
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            webSecurity: false,
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // микрофон должен работать, когда окно свёрнуто / игра в фокусе
            backgroundThrottling: false
        },
        icon: path.join(__dirname, 'assets/icon_542x542.png'),
        title: 'KivoPlayer'
    });

    // ── Разрешения ──────────────────────────────────────
    // Микрофон нужен голосовому помощнику.
    // ВАЖНО: нельзя отвечать false на всё, кроме media — из-за этого ломается
    // File System Access API: handle.requestPermission() начинает возвращать
    // 'denied', и «Загрузить папку» / «Открыть папку снова» молча не работают.
    // Поэтому по умолчанию разрешаем (как Electron без обработчика),
    // а явно запрещаем только то, что плееру точно не нужно.
    const DENIED_PERMISSIONS = new Set([
        'openExternal',
        'display-capture',
        'midiSysex',
        'geolocation'
    ]);

    const isPermissionAllowed = (permission) => !DENIED_PERMISSIONS.has(permission);

    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
        callback(isPermissionAllowed(permission));
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
        return isPermissionAllowed(permission);
    });

    mainWindow.loadFile('index-test.html');
    mainWindow.maximize();

    mainWindow.webContents.on('did-finish-load', () => {
        const cfg = readVoiceConfig();
        mlog.step('окно загружено · конфиг:', {
            ключ: cfg.apiKey ? '••••' + cfg.apiKey.slice(-4) : 'не задан',
            чат: cfg.chatModel,
            asr: cfg.asrModel,
            голос: cfg.ttsVoice,
            слово: cfg.wakeWord,
            включён: cfg.enabled
        });
        mlog.step('файл настроек:', voiceFile());
        registerHotkey(cfg.hotkey);
    });
}

app.whenReady().then(createWindow);

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
