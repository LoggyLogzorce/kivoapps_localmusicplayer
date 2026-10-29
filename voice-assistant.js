// ══════════════════════════════════════════════════════
//  KIVO VOICE — голосовой помощник «постоянного слушания»
//  Микрофон → VAD → ASR (xKiro) → интент → действие → TTS
//  Работает и когда окно не в фокусе (globalShortcut в main).
// ══════════════════════════════════════════════════════
(function () {
    'use strict';

    const api = window.voiceAPI;
    if (!api) {
        console.warn('[voice] voiceAPI недоступен — помощник выключен');
        return;
    }

    // ── Настройки VAD / тайминги ─────────────────────────
    const FRAME = 1024;                 // сэмплов на кадр
    const SR = 16000;                   // частота дискретизации
    const FRAME_MS = (FRAME / SR) * 1000;
    const SILENCE_MS = 620;             // сколько тишины завершает фразу
    const MIN_SPEECH_MS = 340;          // короче — шум
    const MAX_SPEECH_MS = 14000;
    const PREROLL_FRAMES = 4;           // ~250 мс до начала речи
    const ARM_MS = 9000;                // окно после горячей клавиши
    const CONTEXT_TTL_MS = 5 * 60 * 1000;   // столько тишины — и контекст забывается
    const CONTEXT_CHARS = 700;          // обрезаем одну реплику в истории

    const WAKE_VARIANTS = ['киво', 'кива', 'кево', 'кибо', 'кивa', 'kivo', 'ки во', 'кивоу'];

    const V = {
        cfg: null,
        enabled: false,
        ready: false,

        stream: null,
        ctx: null,
        proc: null,
        sink: null,

        speaking: false,      // идёт запись фразы
        hot: 0,
        silence: 0,
        segSamples: 0,
        speechFrames: 0,      // кадры выше порога — только они считаются «речью»
        segment: [],
        preroll: [],
        noise: 0.006,

        busy: false,
        ttsAudio: null,
        prevVolume: 1,
        ducked: false,        // музыка приглушена после слова-активатора
        duckPrev: null,       // уровень, к которому вернёмся (для логов)
        duckTimer: null,      // когда снять приглушение (конец окна follow-up)
        userVolume: null,     // громкость, выбранная пользователем — источник правды
        followUpUntil: 0,
        asrTimes: [],         // временные метки запросов — защита от лавины
        cooldownUntil: 0,
        armedUntil: 0,
        lastHeardAt: 0,
        lastLevel: 0,         // последний RMS
        peak: 0,              // пик с прошлого heartbeat
        frames: 0,            // сколько кадров пришло с микрофона
        lastBeat: 0,          // время последнего heartbeat
        lastTranscript: '',
        lastStrategy: '',
        cycles: 0,            // сколько фраз обработано
        commands: 0,          // сколько из них стали командами
        chats: 0,             // сколько стали разговором
        errors: 0,

        history: [],          // [{role:'user'|'assistant', content}] — контекст диалога
        historyAt: 0,         // когда была последняя реплика
        lastKind: '',         // 'action' | 'chat' — чем закончился прошлый цикл

        asrHook: null,        // перехват результата ASR (режим «Тест микрофона»)
        hud: null,            // круглая кнопка
        chat: null,           // окно чата
        chatBody: null,
        chatOpen: false,
        peekText: null,       // текст в вытянутой полоске
        bars: null,           // полоски-индикатор уровня
        peekUntil: 0,         // до какого времени полоска остаётся раскрытой
        captionTimer: null,
        stateEl: null,
        state: 'off'
    };

    const $ = (id) => document.getElementById(id);
    const audioEl = () => $('audio');

    // ══════════════════════════════════════════════════
    //  ЛОГИ
    //  Каждый шаг помощника пишется в консоль с префиксом [Киво].
    //  KivoVoice.setDebug(true)  — покадровая телеметрия VAD
    //  KivoVoice.diagnostics()   — полный снимок состояния
    // ══════════════════════════════════════════════════
    let DEBUG = false;
    try { DEBUG = localStorage.getItem('kivo.voice.debug') === '1'; } catch (_) {}

    const TAG = '%c[Киво]';
    const TAG_CSS = 'color:#1ed760;font-weight:700';
    const TAG_DIM = 'color:#8a8a8a;font-weight:700';

    const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    const ms = (t0) => Math.round(nowMs() - t0) + ' мс';

    const L = {
        step: (msg, ...a) => console.log(TAG, TAG_CSS, msg, ...a),
        ok:   (msg, ...a) => console.log(TAG, TAG_CSS, '✓ ' + msg, ...a),
        warn: (msg, ...a) => console.warn(TAG, TAG_CSS, '⚠ ' + msg, ...a),
        err:  (msg, ...a) => console.error(TAG, TAG_CSS, '✕ ' + msg, ...a),
        dbg:  (msg, ...a) => { if (DEBUG) console.log(TAG, TAG_DIM, '· ' + msg, ...a); }
    };

    // логи main-процесса — в ту же консоль, синим
    if (api.onLog) {
        api.onLog(({ level, text }) => {
            const css = 'color:#4dabf7;font-weight:700';
            if (level === 'error') console.error('%c[Киво:main]', css, text);
            else if (level === 'warn') console.warn('%c[Киво:main]', css, text);
            else console.log('%c[Киво:main]', css, text);
        });
    }

    // ══════════════════════════════════════════════════
    //  СТИЛИ
    // ══════════════════════════════════════════════════
    function injectStyles() {
        if ($('kivo-voice-style')) return;
        const st = document.createElement('style');
        st.id = 'kivo-voice-style';
        st.textContent = `
        /* ── круглая кнопка справа внизу ── */
        /* ── кнопка справа внизу, которая «вытягивается» в полоску ── */
        #kivo-voice-peek {
            position: fixed;
            right: 24px;
            bottom: 24px;
            z-index: 9200;
            display: flex;
            align-items: center;
            height: 54px;
            /* ширина задаётся явно: свёрнуто — ровно круг, развёрнуто — полоска.
               Содержимое позиционируется абсолютно и не может сдвинуть кнопку.
               Точную ширину под текст считает peekWidth() — CSS — только запас. */
            width: 54px;
            border-radius: 999px;
            border: 1px solid rgba(255,255,255,.12);
            background: rgba(24,24,24,.92);
            backdrop-filter: blur(14px) saturate(1.3);
            box-shadow: 0 10px 30px rgba(0,0,0,.5);
            color: #e8e8e8;
            overflow: hidden;
            cursor: pointer;
            user-select: none;
            opacity: .94;
            transition: width .36s cubic-bezier(.22,1,.36,1), background .25s ease,
                        border-color .25s ease, box-shadow .25s ease, opacity .3s ease,
                        transform .26s cubic-bezier(.22,1,.36,1);
            font: 500 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        }
        #kivo-voice-peek:hover { transform: translateY(-2px); opacity: 1; }
        #kivo-voice-peek.is-peek { width: min(368px, calc(100vw - 48px)); }   /* запас, если JS не посчитал */
        #kivo-voice-peek.is-live { border-color: rgba(30,215,96,.45); }
        #kivo-voice-peek.is-hearing { border-color: rgba(30,215,96,.85); }
        #kivo-voice-peek.is-thinking { border-color: rgba(255,209,102,.65); }
        #kivo-voice-peek.is-speaking { border-color: rgba(77,171,247,.8); }
        #kivo-voice-peek.is-error { border-color: rgba(255,77,109,.75); }
        #kivo-voice-peek.is-off { opacity: .55; }
        #kivo-voice-peek.is-open { background: #1ed760; color: #06120a; border-color: #1ed760; }

        #kivo-voice-fab {
            position: relative;
            flex: 0 0 54px;
            width: 54px; height: 54px;
            margin-left: auto;      /* всегда прижата к правому краю — круг не «съезжает» */
            border: none;
            background: transparent;
            color: inherit;
            cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            padding: 0;
        }
        #kivo-voice-fab svg { width: 23px; height: 23px; display: block; }

        /* содержимое вытянутой полоски — вне потока, чтобы не влиять на кнопку */
        .kv-peek-body {
            position: absolute;
            left: 0;
            right: 54px;            /* заканчивается ровно там, где начинается кнопка */
            top: 0;
            bottom: 0;
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
            padding: 0 4px 0 17px;
            white-space: nowrap;
            overflow: hidden;
            opacity: 0;
            transform: translateX(10px);
            transition: opacity .2s ease .05s, transform .28s cubic-bezier(.22,1,.36,1) .05s;
        }
        #kivo-voice-peek.is-peek .kv-peek-body { opacity: 1; transform: none; }

        .kv-bars { display: flex; align-items: center; gap: 2.5px; height: 17px; flex: 0 0 auto; }
        #kivo-voice-peek:not(.peek-listen) .kv-bars { display: none; }
        .kv-bars i {
            display: block;
            width: 2.5px; height: 100%;
            border-radius: 2px;
            background: #1ed760;
            transform: scaleY(.18);
            transform-origin: center;
            transition: transform .08s linear, background .2s ease;
        }
        #kivo-voice-peek.is-thinking .kv-bars i { background: #ffd166; }
        #kivo-voice-peek.is-speaking .kv-bars i { background: #4dabf7; }

        .kv-peek-text {
            min-width: 0;
            max-width: 268px;
            overflow: hidden;
            text-overflow: ellipsis;
            color: #d8d8d8;
            animation: kvFade .24s ease;
        }
        #kivo-voice-peek.is-peek .kv-peek-text:empty { display: none; }

        .kv-fab-ring {
            position: absolute; inset: 0;
            border-radius: 50%;
            border: 2px solid transparent;
            pointer-events: none;
        }
        #kivo-voice-peek.is-live .kv-fab-ring { border-color: rgba(30,215,96,.35); animation: kvBeatRing 2.6s ease-in-out infinite alternate; }
        #kivo-voice-peek.is-hearing .kv-fab-ring { border-color: rgba(30,215,96,.85); animation: kvBeatRing .55s ease-in-out infinite alternate; }
        #kivo-voice-peek.is-thinking .kv-fab-ring { border-color: rgba(255,209,102,.7); animation: kvBeatRing .45s ease-in-out infinite alternate; }
        #kivo-voice-peek.is-speaking .kv-fab-ring { border-color: rgba(77,171,247,.8); animation: kvBeatRing .6s ease-in-out infinite alternate; }
        #kivo-voice-peek.is-error .kv-fab-ring { border-color: rgba(255,77,109,.8); }

        @keyframes kvBeatRing { from { transform: scale(.9); opacity: .55; } to { transform: scale(1.12); opacity: 1; } }
        @keyframes kvFade { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

        /* ── окно чата ── */
        #kivo-voice-chat {
            position: fixed;
            right: 24px;
            bottom: 92px;
            z-index: 9190;
            width: min(392px, calc(100vw - 40px));
            height: min(540px, calc(100vh - 130px));
            display: none;
            flex-direction: column;
            background: #171717;
            border: 1px solid rgba(255,255,255,.09);
            border-radius: 18px;
            box-shadow: 0 26px 70px rgba(0,0,0,.66);
            overflow: hidden;
            color: #e6e6e6;
            font: 400 13.5px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
            transform-origin: bottom right;
            animation: kvChatIn .26s cubic-bezier(.22,1,.36,1);
        }
        #kivo-voice-chat.open { display: flex; }
        @keyframes kvChatIn { from { opacity: 0; transform: translateY(12px) scale(.97); } to { opacity: 1; transform: none; } }

        .kv-chat-head {
            display: flex; align-items: center; gap: 8px;
            padding: 11px 12px 11px 14px;
            border-bottom: 1px solid rgba(255,255,255,.07);
            background: #1d1d1d;
            flex: 0 0 auto;
        }
        .kv-chat-dot {
            width: 8px; height: 8px; border-radius: 50%;
            background: #6b6b6b; flex: 0 0 auto;
            transition: background .25s ease;
        }
        #kivo-voice-chat.is-live .kv-chat-dot { background: #1ed760; }
        #kivo-voice-chat.is-hearing .kv-chat-dot { background: #1ed760; animation: kvBeat .5s ease-in-out infinite alternate; }
        #kivo-voice-chat.is-thinking .kv-chat-dot { background: #ffd166; animation: kvBeat .42s ease-in-out infinite alternate; }
        #kivo-voice-chat.is-speaking .kv-chat-dot { background: #4dabf7; animation: kvBeat .6s ease-in-out infinite alternate; }
        #kivo-voice-chat.is-error .kv-chat-dot { background: #ff4d6d; }
        #kivo-voice-chat.is-off .kv-chat-dot { background: #5a5a5a; }
        @keyframes kvBeat { from { transform: scale(.75); } to { transform: scale(1.25); } }

        .kv-chat-title { font-weight: 700; color: #fff; letter-spacing: -.1px; }
        .kv-chat-status {
            color: #7d7d7d; font-size: 11.5px;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            flex: 1 1 auto; min-width: 0;
        }
        .kv-chat-btn {
            width: 26px; height: 26px; flex: 0 0 auto;
            border: none; border-radius: 8px;
            background: transparent; color: #8f8f8f;
            font-size: 13px; line-height: 1;
            cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            transition: background .18s ease, color .18s ease;
        }
        .kv-chat-btn:hover { background: rgba(255,255,255,.1); color: #fff; }

        .kv-chat-body {
            flex: 1 1 auto;
            overflow-y: auto;
            padding: 14px 14px 8px;
            display: flex; flex-direction: column; gap: 9px;
            scrollbar-width: thin;
            scrollbar-color: #3a3a3a transparent;
        }
        .kv-chat-body::-webkit-scrollbar { width: 7px; }
        .kv-chat-body::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 4px; }
        .kv-chat-body::-webkit-scrollbar-track { background: transparent; }

        .kv-msg {
            max-width: 84%;
            padding: 9px 12px;
            border-radius: 14px;
            font-size: 13.5px;
            line-height: 1.48;
            white-space: pre-wrap;
            word-break: break-word;
            animation: kvMsgIn .22s cubic-bezier(.22,1,.36,1);
        }
        @keyframes kvMsgIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        .kv-msg.user {
            align-self: flex-end;
            background: #1ed760; color: #06120a;
            border-bottom-right-radius: 5px;
            font-weight: 500;
        }
        .kv-msg.bot {
            align-self: flex-start;
            background: #262626; color: #ececec;
            border-bottom-left-radius: 5px;
        }
        .kv-msg.action {
            align-self: flex-start;
            background: transparent;
            color: #6f6f6f;
            font-size: 11.5px;
            padding: 1px 4px;
            max-width: 100%;
        }
        .kv-msg.action::before { content: '▸ '; color: #1ed760; }
        .kv-msg.sys {
            align-self: center;
            background: transparent;
            color: #6a6a6a;
            font-size: 11.5px;
            text-align: center;
            padding: 2px 6px;
        }
        .kv-msg.typing { display: flex; gap: 4px; align-items: center; }
        .kv-msg.typing i {
            width: 6px; height: 6px; border-radius: 50%;
            background: #7a7a7a; display: block;
            animation: kvTyping 1s ease-in-out infinite;
        }
        .kv-msg.typing i:nth-child(2) { animation-delay: .16s; }
        .kv-msg.typing i:nth-child(3) { animation-delay: .32s; }
        @keyframes kvTyping { 0%,60%,100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }

        .kv-chat-foot {
            flex: 0 0 auto;
            display: flex; align-items: center; gap: 7px;
            padding: 10px 11px 11px;
            border-top: 1px solid rgba(255,255,255,.07);
            background: #1d1d1d;
        }
        #kv-chat-input {
            flex: 1 1 auto; min-width: 0;
            padding: 9px 12px;
            background: #262626;
            border: 1px solid #363636;
            border-radius: 999px;
            color: #fff; font-size: 13.5px;
            outline: none;
            transition: border-color .18s ease, background .18s ease;
        }
        #kv-chat-input:focus { border-color: #1ed760; background: #2b2b2b; }
        #kv-chat-input::placeholder { color: #6a6a6a; }
        .kv-chat-round {
            width: 36px; height: 36px; flex: 0 0 auto;
            border: none; border-radius: 50%;
            background: #262626; color: #b9b9b9;
            font-size: 15px; line-height: 1;
            cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            transition: background .18s ease, color .18s ease, transform .18s ease;
        }
        .kv-chat-round:hover { background: #333; color: #fff; }
        .kv-chat-round:active { transform: scale(.93); }
        .kv-chat-round.send { background: #1ed760; color: #06120a; }
        .kv-chat-round.send:hover { background: #24e96a; color: #06120a; }
        .kv-chat-round.mic.on { background: #1ed760; color: #06120a; }
        .kv-chat-round.mic.off { background: #2e2e2e; color: #7a7a7a; }

        /* ── модалка настроек ── */
        #kivo-voice-modal {
            position: fixed; inset: 0; z-index: 10050;
            display: none; align-items: center; justify-content: center;
            background: rgba(0,0,0,.72);
            backdrop-filter: blur(6px);
            animation: kvFade .2s ease;
        }
        #kivo-voice-modal.open { display: flex; }
        .kv-panel {
            width: min(600px, 92vw);
            max-height: 88vh;
            overflow-y: auto;
            background: #1c1c1c;
            border: 1px solid rgba(255,255,255,.08);
            border-radius: 16px;
            padding: 26px 28px 22px;
            box-shadow: 0 24px 70px rgba(0,0,0,.62);
            color: #e6e6e6;
            font: 400 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
            animation: kvPanelIn .32s cubic-bezier(.22,1,.36,1);
        }
        @keyframes kvPanelIn { from { opacity: 0; transform: translateY(14px) scale(.97); } to { opacity: 1; transform: none; } }
        .kv-panel h2 { margin: 0 0 4px; font-size: 19px; color: #fff; letter-spacing: -.2px; }
        .kv-sub { color: #8b8b8b; font-size: 12.5px; margin-bottom: 20px; }
        .kv-field { margin-bottom: 14px; }
        .kv-field label { display: block; color: #a5a5a5; font-size: 12.5px; margin-bottom: 5px; }
        .kv-field input[type=text],
        .kv-field input[type=password],
        .kv-field input[type=number],
        .kv-field select {
            width: 100%; box-sizing: border-box;
            padding: 9px 11px;
            background: #262626;
            border: 1px solid #363636;
            border-radius: 8px;
            color: #fff;
            font-size: 13.5px;
            outline: none;
            transition: border-color .18s ease, background .18s ease;
        }
        .kv-field input:focus, .kv-field select:focus { border-color: #1ed760; background: #2b2b2b; }
        .kv-row { display: flex; gap: 12px; }
        .kv-row > * { flex: 1; min-width: 0; }
        .kv-check { display: flex; align-items: center; gap: 9px; color: #cfcfcf; font-size: 13.5px; cursor: pointer; margin-bottom: 11px; }
        .kv-check input { width: 16px; height: 16px; accent-color: #1ed760; cursor: pointer; }
        .kv-hint { color: #777; font-size: 11.5px; margin-top: 5px; line-height: 1.45; }
        .kv-range { width: 100%; accent-color: #1ed760; }
        .kv-sec {
            display: flex; align-items: center; gap: 10px;
            margin: 20px 0 13px;
            color: #6d6d6d; font-size: 10.5px; font-weight: 700;
            letter-spacing: .1em; text-transform: uppercase;
        }
        .kv-sec::after { content: ''; flex: 1; height: 1px; background: #303030; }
        .kv-sec:first-of-type { margin-top: 16px; }
        .kv-note {
            margin: 0 0 14px; padding: 9px 12px;
            border-radius: 8px; font-size: 11.5px; line-height: 1.5;
            border-left: 3px solid #4a4a4a; background: #242424; color: #909090;
        }
        .kv-note.warn { border-left-color: #ff6b81; background: rgba(255,107,129,.08); color: #ffa8b4; }
        .kv-note.ok   { border-left-color: #1ed760; background: rgba(30,215,96,.07); color: #86dfa8; }
        .kv-note b { color: inherit; font-weight: 700; }
        .kv-note code {
            font-family: ui-monospace, "SF Mono", Consolas, monospace;
            font-size: 11px; background: rgba(255,255,255,.07);
            padding: 1px 4px; border-radius: 4px;
        }
        .kv-actions { display: flex; gap: 10px; justify-content: flex-end; align-items: center; margin-top: 22px; }
        .kv-btn {
            padding: 9px 18px; border-radius: 999px; border: 1px solid #3a3a3a;
            background: transparent; color: #b5b5b5; font-size: 13.5px; cursor: pointer;
            transition: all .2s ease;
        }
        .kv-btn:hover { color: #fff; border-color: #5a5a5a; }
        .kv-btn.primary { background: #1ed760; border-color: #1ed760; color: #06120a; font-weight: 700; }
        .kv-btn.primary:hover { filter: brightness(1.08); transform: translateY(-1px); }
        .kv-btn.test { margin-right: auto; }
        .kv-status { font-size: 12px; color: #8a8a8a; min-height: 16px; }
        .kv-status.ok { color: #1ed760; }
        .kv-status.bad { color: #ff6b81; }

        @media (prefers-reduced-motion: reduce) {
            #kivo-voice-peek, #kivo-voice-fab, #kivo-voice-chat, .kv-fab-ring, .kv-chat-dot,
            .kv-msg, .kv-panel, .kv-peek-body, .kv-bars i {
                animation: none !important;
                transition: none !important;
            }
        }
        `;
        document.head.appendChild(st);
    }

    // ══════════════════════════════════════════════════
    //  HUD: кнопка справа внизу + окно чата
    // ══════════════════════════════════════════════════
    const MIC_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="2" width="6" height="11" rx="3"></rect>
        <path d="M5 10v1a7 7 0 0 0 14 0v-1"></path>
        <line x1="12" y1="18" x2="12" y2="22"></line>
        <line x1="8" y1="22" x2="16" y2="22"></line>
    </svg>`;

    function buildHud() {
        if (V.hud) return;

        // ── кнопка, которая вытягивается в полоску ──
        const fab = document.createElement('div');
        fab.id = 'kivo-voice-peek';
        fab.title = 'Киво — открыть чат';
        fab.innerHTML = `
            <div class="kv-peek-body">
                <span class="kv-bars"><i></i><i></i><i></i><i></i></span>
                <span class="kv-peek-text"></span>
            </div>
            <button id="kivo-voice-fab" title="Киво">${MIC_ICON}<span class="kv-fab-ring"></span></button>`;
        document.body.appendChild(fab);

        // ── окно чата ──
        const chat = document.createElement('div');
        chat.id = 'kivo-voice-chat';
        chat.innerHTML = `
            <div class="kv-chat-head">
                <span class="kv-chat-dot"></span>
                <span class="kv-chat-title">Киво</span>
                <span class="kv-chat-status"></span>
                <button class="kv-chat-btn" id="kv-chat-forget" title="Забыть контекст">⟲</button>
                <button class="kv-chat-btn" id="kv-chat-gear" title="Настройки">⚙</button>
                <button class="kv-chat-btn" id="kv-chat-close" title="Закрыть">✕</button>
            </div>
            <div class="kv-chat-body" id="kv-chat-body"></div>
            <div class="kv-chat-foot">
                <input id="kv-chat-input" type="text" placeholder="Напишите или скажите «${(V.cfg && V.cfg.wakeWord) || 'Киво'}…»" autocomplete="off">
                <button class="kv-chat-round mic off" id="kv-chat-mic" title="Микрофон">${MIC_ICON}</button>
                <button class="kv-chat-round send" id="kv-chat-send" title="Отправить">→</button>
            </div>`;
        document.body.appendChild(chat);

        V.hud = fab;
        V.chat = chat;
        V.chatBody = chat.querySelector('#kv-chat-body');
        V.stateEl = chat.querySelector('.kv-chat-status');
        V.peekText = fab.querySelector('.kv-peek-text');
        V.bars = [...fab.querySelectorAll('.kv-bars i')];

        fab.addEventListener('click', () => toggleChat());
        chat.querySelector('#kv-chat-close').addEventListener('click', () => setChatOpen(false));
        chat.querySelector('#kv-chat-gear').addEventListener('click', () => openSettings());
        chat.querySelector('#kv-chat-forget').addEventListener('click', () => {
            const n = resetContext();
            addMessage('sys', n ? `контекст очищен (${n} реплик)` : 'контекст и так пуст');
        });

        const micBtn = chat.querySelector('#kv-chat-mic');
        micBtn.addEventListener('click', async () => {
            if (V.enabled) disable();
            else await enable();
            syncMicButton();
        });

        const input = chat.querySelector('#kv-chat-input');
        const send = () => {
            const text = input.value.trim();
            if (!text) return;
            input.value = '';
            submitText(text);
        };
        chat.querySelector('#kv-chat-send').addEventListener('click', send);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            if (e.key === 'Escape') setChatOpen(false);
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && V.chatOpen) setChatOpen(false);
        });

        syncMicButton();
        setState(V.enabled ? 'idle' : 'off');
    }

    function syncMicButton() {
        if (!V.chat) return;
        const b = V.chat.querySelector('#kv-chat-mic');
        if (!b) return;
        b.classList.toggle('on', !!V.enabled);
        b.classList.toggle('off', !V.enabled);
        b.title = V.enabled ? 'Микрофон включён — выключить' : 'Микрофон выключен — включить';
    }

    function setChatOpen(on) {
        if (!V.chat) return;
        V.chatOpen = !!on;
        V.chat.classList.toggle('open', V.chatOpen);
        V.hud.classList.toggle('is-open', V.chatOpen);

        if (V.chatOpen) {
            // окно открыто — слушаем без слова-активатора, как обычный разговор
            V.armedUntil = 0;
            peekHide();     // полоска больше не нужна — всё видно в чате

            // подсказка при первом открытии пустого чата
            if (V.chatBody && !V.chatBody.children.length) {
                const wake = (V.cfg && V.cfg.wakeWord) || 'Киво';
                const always = V.cfg && V.cfg.activationMode === 'always';
                addMessage('sys', always
                    ? 'Микрофон слушает всё — говорите или пишите.'
                    : `Скажите «${wake}, …» или просто напишите здесь. Пока чат открыт, слово-активатор не нужен.`);
            }

            setTimeout(() => {
                const i = V.chat && V.chat.querySelector('#kv-chat-input');
                if (i) i.focus();
                scrollChat();
            }, 60);
            L.step('чат открыт — можно говорить без слова-активатора');
        } else {
            L.dbg('чат закрыт');
        }
    }

    function toggleChat() {
        setChatOpen(!V.chatOpen);
    }

    function addMessage(role, text) {
        if (!V.chatBody || !text) return;
        const el = document.createElement('div');
        el.className = 'kv-msg ' + role;
        el.textContent = text;
        V.chatBody.appendChild(el);
        while (V.chatBody.children.length > 200) V.chatBody.removeChild(V.chatBody.firstChild);
        scrollChat();
        return el;
    }

    function scrollChat() {
        if (!V.chatBody) return;
        V.chatBody.scrollTop = V.chatBody.scrollHeight;
    }

    function showTyping() {
        if (!V.chatBody) return null;
        const el = document.createElement('div');
        el.className = 'kv-msg bot typing';
        el.innerHTML = '<i></i><i></i><i></i>';
        V.chatBody.appendChild(el);
        scrollChat();
        return el;
    }

    const STATE_TEXT = {
        off: 'выключен',
        idle: 'слушаю слово-активатор',
        armed: 'слушаю…',
        hearing: 'слышу…',
        thinking: 'думаю…',
        speaking: 'говорю…',
        error: 'ошибка'
    };

    function setState(state, caption) {
        V.state = state;
        const map = {
            idle: 'is-live', armed: 'is-live', hearing: 'is-hearing',
            thinking: 'is-thinking', speaking: 'is-speaking',
            error: 'is-error', off: 'is-off'
        };
        const cls = map[state] || 'is-live';

        if (V.hud) {
            V.hud.classList.remove('is-live', 'is-hearing', 'is-thinking', 'is-speaking', 'is-error', 'is-off');
            V.hud.classList.add(cls);
        }
        if (V.chat) {
            V.chat.classList.remove('is-live', 'is-hearing', 'is-thinking', 'is-speaking', 'is-error', 'is-off');
            V.chat.classList.add(cls);
        }
        if (V.stateEl) V.stateEl.textContent = caption !== undefined && caption
            ? caption
            : (STATE_TEXT[state] || '');
        if (caption) L.dbg(`состояние: ${state} · ${caption}`);
    }

    // короткая подпись в шапке чата (транскрипт, служебные сообщения)
    function showCaption(text) {
        if (!V.stateEl) return;
        if (V.captionTimer) clearTimeout(V.captionTimer);
        V.stateEl.textContent = text || (STATE_TEXT[V.state] || '');
        if (!text) return;
        V.captionTimer = setTimeout(() => {
            if (V.stateEl && V.stateEl.textContent === text) {
                V.stateEl.textContent = STATE_TEXT[V.state] || '';
            }
        }, 5200);
    }

    // ══════════════════════════════════════════════════
    //  ВЫТЯГИВАЮЩАЯСЯ ПОЛОСКА (когда чат закрыт)
    //  listen → полоски пляшут по уровню микрофона
    //  think  → «распознаю…» / «думаю…»
    //  text   → распознанная фраза или действие
    //  speak  → ответ помощника
    // ══════════════════════════════════════════════════
    const PEEK_HOLD_MS = 5600;      // сколько держим финальный текст
    let peekTimer = null;

    // ── ширина полоски по содержимому ──
    // Раньше развёрнутая полоска всегда была 368 px, даже когда показывать было
    // нечего (фаза «слушаю») — торчала длинная пустая плашка. Теперь ширину
    // считаем под текст: пусто → компактная, длинная фраза → до максимума.
    const PEEK_BORDERS = 2, PEEK_FAB = 54, PEEK_PAD_L = 17, PEEK_PAD_R = 4;
    const PEEK_GAP = 10, PEEK_BARS = 18, PEEK_TEXT_MAX = 268, PEEK_MAX = 368;
    const PEEK_MIN = 58;

    let peekMeasurer = null;

    function measurePeekText(text) {
        if (!text) return 0;
        if (!peekMeasurer) {
            peekMeasurer = document.createElement('span');
            peekMeasurer.style.cssText =
                'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;' +
                'font:500 13px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
            document.body.appendChild(peekMeasurer);
        }
        peekMeasurer.textContent = text;
        return peekMeasurer.getBoundingClientRect().width;
    }

    function peekWidth(text, mode) {
        const hasText = !!text;
        const hasBars = mode === 'listen';

        let w = PEEK_BORDERS + PEEK_FAB + PEEK_PAD_R;
        if (hasText || hasBars) w += PEEK_PAD_L;
        if (hasBars) w += PEEK_BARS;
        if (hasText) w += Math.min(measurePeekText(text), PEEK_TEXT_MAX);
        if (hasText && hasBars) w += PEEK_GAP;

        // на узком окне полоска не должна вылезать за экран
        const viewport = Math.max(120, (window.innerWidth || 0) - 48);
        return Math.round(Math.max(PEEK_MIN, Math.min(w, PEEK_MAX, viewport)));
    }

    function peekShow(mode, text, holdMs) {
        if (!V.hud || V.chatOpen) return;

        V.hud.classList.add('is-peek');
        V.hud.classList.remove('peek-listen', 'peek-think', 'peek-text', 'peek-speak');
        V.hud.classList.add('peek-' + mode);

        if (V.peekText) V.peekText.textContent = text || '';
        V.hud.style.width = peekWidth(text || '', mode) + 'px';
        if (mode !== 'listen') resetBars();

        if (peekTimer) clearTimeout(peekTimer);
        peekTimer = null;

        // «listen» держим до конца записи, у остальных — таймер
        if (mode !== 'listen') {
            const hold = holdMs || PEEK_HOLD_MS;
            peekTimer = setTimeout(peekHide, hold);
        }
        V.peekUntil = Date.now() + (holdMs || PEEK_HOLD_MS);
    }

    function peekHide() {
        if (peekTimer) clearTimeout(peekTimer);
        peekTimer = null;
        resetBars();
        if (V.hud) {
            V.hud.classList.remove('is-peek', 'peek-listen', 'peek-think', 'peek-text', 'peek-speak');
            V.hud.style.width = '';        // возвращаемся к ширине из CSS (круг)
        }
        if (V.peekText) V.peekText.textContent = '';
    }

    // Полоски обновляем прямо из кадров микрофона — каждый кадр ~64 мс.
    // requestAnimationFrame в фоновом окне троттлится, а кадры идут всегда.
    let barPhase = 0;

    function updateBars(level) {
        if (!V.bars || !V.bars.length || !V.hud) return;
        if (!V.hud.classList.contains('peek-listen')) return;

        const lvl = Math.min(1, Math.max(0, (level || 0) / 0.05));
        barPhase += 0.7;

        for (let i = 0; i < V.bars.length; i++) {
            const wave = 0.5 + 0.5 * Math.sin(barPhase + i * 1.9);
            const h = Math.max(0.16, Math.min(1, lvl * (0.5 + 0.5 * wave) + 0.12));
            V.bars[i].style.transform = 'scaleY(' + h.toFixed(2) + ')';
        }
    }

    function resetBars() {
        if (!V.bars) return;
        V.bars.forEach(b => { b.style.transform = 'scaleY(.18)'; });
    }

    // ══════════════════════════════════════════════════
    //  МИКРОФОН + VAD
    // ══════════════════════════════════════════════════
    async function startMic() {
        if (V.stream) return true;
        L.step('запрашиваю доступ к микрофону…');
        try {
            V.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,   // критично: музыка играет из колонок
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
        } catch (e) {
            V.errors++;
            L.err('микрофон недоступен:', e.name + ' — ' + e.message);
            L.warn('проверьте: Windows → Параметры → Конфиденциальность → Микрофон → разрешить приложениям');
            setState('error', 'нет доступа к микрофону');
            V.enabled = false;
            return false;
        }

        const track = V.stream.getAudioTracks()[0];
        const st = (track && track.getSettings) ? track.getSettings() : {};
        L.ok('микрофон открыт:', {
            устройство: (track && track.label) || 'без имени',
            частота: st.sampleRate || '?',
            каналов: st.channelCount || '?',
            эхоподавление: st.echoCancellation !== false,
            шумоподавление: st.noiseSuppression !== false
        });

        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            V.ctx = new Ctx({ sampleRate: SR });
            if (V.ctx.state === 'suspended') await V.ctx.resume();

            const src = V.ctx.createMediaStreamSource(V.stream);
            V.proc = V.ctx.createScriptProcessor(FRAME, 1, 1);
            V.sink = V.ctx.createGain();
            V.sink.gain.value = 0;          // без эха в колонки

            src.connect(V.proc);
            V.proc.connect(V.sink);
            V.sink.connect(V.ctx.destination);

            V.proc.onaudioprocess = onAudio;
            V.ready = true;
            L.ok(`аудиограф собран · ${V.ctx.sampleRate} Гц · кадр ${FRAME} сэмплов (~${Math.round(FRAME_MS)} мс)`);
            L.step(`порог VAD ${Number(V.cfg && V.cfg.vadThreshold) || 0.012} (адаптивно не ниже шума×2.6)`);
            return true;
        } catch (e) {
            V.errors++;
            L.err('не удалось собрать аудиограф:', e.message);
            setState('error', 'ошибка аудио');
            return false;
        }
    }

    function stopMic() {
        try { if (V.proc) { V.proc.onaudioprocess = null; V.proc.disconnect(); } } catch (_) {}
        try { if (V.sink) V.sink.disconnect(); } catch (_) {}
        try { if (V.ctx) V.ctx.close(); } catch (_) {}
        try { if (V.stream) V.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
        V.proc = null; V.sink = null; V.ctx = null; V.stream = null;
        V.ready = false;
        V.speaking = false;
        V.segment = [];
        V.preroll = [];
        duckOff();          // если микрофон закрыли посреди фразы — возвращаем громкость
        L.step('микрофон закрыт');
    }

    function rms(frame) {
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        return Math.sqrt(sum / frame.length);
    }

    function onAudio(e) {
        if (!V.enabled || !V.ready) return;
        const frame = e.inputBuffer.getChannelData(0);
        const level = rms(frame);

        V.frames++;
        V.lastLevel = level;
        if (level > V.peak) V.peak = level;

        // полоски в вытянутой кнопке дышат прямо по кадрам микрофона
        updateBars(level);

        // пока говорим сами — микрофон не слушаем (страховка поверх AEC)
        if (V.ttsAudio) {
            V.noise = V.noise * 0.98 + level * 0.02;
            return;
        }

        const threshold = Math.max(
            Number(V.cfg && V.cfg.vadThreshold) || 0.012,
            V.noise * 2.6
        );

        // ── heartbeat: раз в 30 с подтверждаем, что микрофон живой ──
        const tNow = nowMs();
        if (!V.lastBeat || tNow - V.lastBeat > 30000) {
            const first = !V.lastBeat;
            V.lastBeat = tNow;
            L.step(`🎚 микрофон ${first ? 'даёт данные' : 'активен'} · кадров: ${V.frames} · RMS ${level.toFixed(4)} · пик ${V.peak.toFixed(3)} · порог ${threshold.toFixed(4)} · ${V.state}`);
            V.peak = 0;
            if (V.ctx && V.ctx.state !== 'running') {
                L.warn('аудиоконтекст в состоянии «' + V.ctx.state + '» — возобновляю');
                V.ctx.resume().catch(() => {});
            }
        }

        L.dbg(`кадр · RMS ${level.toFixed(4)} · порог ${threshold.toFixed(4)} · шум ${V.noise.toFixed(4)} · ${V.speaking ? 'запись' : 'ожидание'}`);

        if (!V.speaking) {
            V.noise = V.noise * 0.965 + level * 0.035;
            V.preroll.push(new Float32Array(frame));
            if (V.preroll.length > PREROLL_FRAMES) V.preroll.shift();

            if (level > threshold) {
                V.hot++;
                if (V.hot >= 2) beginSegment(level, threshold);
            } else {
                V.hot = 0;
            }
            return;
        }

        V.segment.push(new Float32Array(frame));
        V.segSamples += frame.length;

        if (level < threshold * 0.82) {
            V.silence++;
        } else {
            V.silence = 0;
            V.speechFrames++;
        }

        const silentMs = V.silence * FRAME_MS;
        const totalMs = (V.segSamples / SR) * 1000;

        if (silentMs >= SILENCE_MS || totalMs >= MAX_SPEECH_MS) endSegment();
    }

    // ── обращаются ли сейчас к помощнику ──
    // Слово-активатор узнаётся только после распознавания, поэтому до него
    // полоска молчит: иначе она дёргалась на любое слово в комнате.
    function isAddressed() {
        if (V.chatOpen) return true;
        if (V.cfg && V.cfg.activationMode === 'always') return true;
        const t = Date.now();
        return t < V.followUpUntil || t < V.armedUntil;
    }

    // ── приглушение музыки ──
    // Включается ТОЛЬКО когда помощник понял, что к нему обращаются: слово-активатор
    // подтверждено распознаванием, открыт чат, нажата горячая клавиша или идёт окно
    // продолжения диалога. На случайный звук в комнате музыка не реагирует.
    // Держится, пока открыто окно follow-up — тогда следующая команда
    // записывается уже при тихой музыке и лучше распознаётся.
    function duckOn() {
        if (V.ducked) return;
        if (V.cfg && V.cfg.duckMusic === false) return;
        const a = audioEl();
        if (!a || !a.volume) return;
        if (V.userVolume == null) V.userVolume = a.volume;
        V.duckPrev = V.userVolume;          // уровень, к которому вернёмся
        V.ducked = true;
        applyVolume();
        L.dbg(`музыка приглушена: ${Math.round(V.userVolume * 100)}% → ${Math.round(a.volume * 100)}%`);
    }

    function duckOff() {
        if (V.duckTimer) { clearTimeout(V.duckTimer); V.duckTimer = null; }
        if (!V.ducked) return;
        V.ducked = false;
        V.duckPrev = null;
        applyVolume();
        const a = audioEl();
        L.dbg(`громкость музыки возвращена: ${Math.round((a ? a.volume : 0) * 100)}%`);
    }

    // держим приглушение до указанного момента (обычно — до конца окна follow-up)
    function duckUntil(whenMs) {
        if (V.duckTimer) { clearTimeout(V.duckTimer); V.duckTimer = null; }
        const left = (whenMs || 0) - Date.now();
        if (left <= 0) { duckOff(); return; }
        duckOn();
        V.duckTimer = setTimeout(() => {
            V.duckTimer = null;
            duckOff();
        }, left);
        L.dbg(`музыка приглушена ещё ${Math.round(left / 100) / 10} с`);
    }

    // уровень, который должен быть у музыки прямо сейчас (с учётом приглушения).
    // Нужен озвучке: она возвращает не «сырое» значение, а актуальное.
    function musicVolumeLevel() {
        if (V.ducked && V.userVolume != null) return Math.max(0.02, V.userVolume * DUCK_RATIO);
        return V.userVolume != null ? V.userVolume : V.prevVolume;
    }

    function beginSegment(level, threshold) {
        if (V.busy) { V.hot = 0; L.dbg('занят — новую фразу не начинаю'); return; }
        if (Date.now() < V.cooldownUntil) { V.hot = 0; return; }
        L.step(`🎤 речь началась · уровень ${(level || V.lastLevel).toFixed(4)} > порога ${(threshold || 0).toFixed(4)}`);
        V.speaking = true;
        V.hot = 0;
        V.silence = 0;
        V.speechFrames = 2;              // два кадра, которые открыли сегмент
        V.segment = V.preroll.slice();
        V.segSamples = V.segment.reduce((n, f) => n + f.length, 0);
        V.preroll = [];

        // пока слова-активатора не слышно — не показываем, что «слушаем»
        // (и музыку не трогаем: см. duckUntil в handleUtterance)
        if (isAddressed()) {
            setState('hearing');
            peekShow('listen', '');
        }
    }

    function endSegment() {
        V.speaking = false;
        V.silence = 0;

        const chunks = V.segment;
        V.segment = [];
        const voicedMs = V.speechFrames * FRAME_MS;
        V.speechFrames = 0;
        V.segSamples = 0;

        // считаем только реально озвученные кадры — pre-roll не в зачёт
        if (voicedMs < MIN_SPEECH_MS) {
            L.dbg(`слишком короткая фраза (${Math.round(voicedMs)} мс < ${MIN_SPEECH_MS}) — пропускаю`);
            if (!V.busy) setState('idle');
            return;
        }

        // склейка кадров
        const merged = new Float32Array(chunks.reduce((n, f) => n + f.length, 0));
        let off = 0;
        for (const f of chunks) { merged.set(f, off); off += f.length; }

        const wav = encodeWav(merged, SR);
        L.step(`⏹ фраза ${Math.round((merged.length / SR) * 1000)} мс (речь ${Math.round(voicedMs)} мс) · ${(wav.length / 1024).toFixed(1)} КБ`);
        handleUtterance(wav);
    }

    // ── WAV 16-bit mono ─────────────────────────────────
    function encodeWav(samples, sampleRate) {
        const len = samples.length;
        const buffer = new ArrayBuffer(44 + len * 2);
        const view = new DataView(buffer);
        const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };

        str(0, 'RIFF');
        view.setUint32(4, 36 + len * 2, true);
        str(8, 'WAVE');
        str(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        str(36, 'data');
        view.setUint32(40, len * 2, true);

        let o = 44;
        for (let i = 0; i < len; i++) {
            const s = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
            o += 2;
        }
        return new Uint8Array(buffer);
    }

    function toBase64(u8) {
        let out = '';
        const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) {
            out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        }
        return btoa(out);
    }

    // ══════════════════════════════════════════════════
    //  РАСПОЗНАВАНИЕ + РЕАКЦИЯ
    // ══════════════════════════════════════════════════
    // не больше 40 распознаваний в минуту — иначе шумная комната жжёт квоту
    const ASR_PER_MINUTE = 40;

    async function handleUtterance(wav) {
        if (V.busy) {
            L.dbg('ещё обрабатываю предыдущую фразу — эту отбрасываю');
            return;
        }

        const now = Date.now();
        V.asrTimes = V.asrTimes.filter(t => now - t < 60000);
        if (V.asrTimes.length >= ASR_PER_MINUTE) {
            V.cooldownUntil = now + 30000;
            V.asrTimes = [];
            L.warn(`слишком много распознаваний (${ASR_PER_MINUTE} за минуту) — пауза 30 сек`);
            setState('error', 'пауза 30 сек — слишком много запросов');
            return;
        }
        V.asrTimes.push(now);

        V.busy = true;
        V.cycles++;

        // до слова-активатора не показываем «распознаю…» — иначе полоска
        // оживает на любую фразу в комнате
        const addressed = isAddressed();
        if (addressed) {
            setState('thinking', 'распознаю…');
            peekShow('think', 'распознаю…');
        }

        const tStart = nowMs();
        const kb = (wav.length / 1024).toFixed(1);

        try {
            L.step(`⤴ отправляю на распознавание · ${kb} КБ · модель ${(V.cfg && V.cfg.asrModel) || '?'}`);
            const tAsr = nowMs();
            const res = await api.asr({ data: toBase64(wav), mime: 'audio/wav' });
            const asrMs = ms(tAsr);

            if (!res || !res.ok) {
                V.errors++;
                L.err(`распознавание не удалось за ${asrMs}: ${(res && res.error) || 'сбой'}`);
                if (res && res.tried && res.tried.length) {
                    L.err('перебрал стратегии →', res.tried.map(x => `${x.strategy}: ${x.error}`).join(' | '));
                }
                setState('error', 'ASR: ' + String((res && res.error) || 'сбой').slice(0, 60));
                if (addressed) peekShow('text', 'не расслышал', 2800);
                return;
            }

            // режим диагностики: показываем сырой текст, ничего не выполняя
            if (V.asrHook) {
                L.step(`[тест микрофона] распознано за ${asrMs} [${res.strategy}]: «${res.text}»`);
                const handled = V.asrHook(res);
                if (handled !== false) return;
            }

            const raw = (res.text || '').trim();
            V.lastTranscript = raw;
            V.lastStrategy = res.strategy;

            if (!raw) {
                V.errors++;
                L.warn(`распознано за ${asrMs}, но текст пустой — пропускаю`);
                setState('idle');
                return;
            }

            L.ok(`распознано за ${asrMs} [${res.strategy}]: «${raw}»`);

            // окна считаем заново: распознавание могло занять несколько секунд
            const tNow = Date.now();
            const wake = (V.cfg && V.cfg.wakeWord) || 'киво';
            const mode = (V.cfg && V.cfg.activationMode) || 'wake';

            // окно «продолжение диалога» — несколько секунд после прошлой реплики
            const followUp = tNow < V.followUpUntil;
            // открытый чат и горячая клавиша работают без слова-активатора
            const armed = tNow < V.armedUntil || V.chatOpen;
            const always = mode === 'always';
            const stripped = stripWake(raw);

            if (!always && !armed && !followUp && stripped === null) {
                L.step(`💬 «${raw}» — нет слова-активатора, игнорирую`);
                L.dbg(`   сработает как «${wake}, …», по горячей клавише ${(V.cfg && V.cfg.hotkey) || 'Ctrl+Alt+Space'} или при открытом чате`);
                peekHide();
                setState('idle');
                return;
            }

            L.dbg('режим: ' + (always ? 'всегда слушаю' : armed ? (V.chatOpen ? 'чат открыт' : 'горячая клавиша')
                : followUp ? 'продолжение диалога' : 'слово-активатор'));

            const text = (stripped !== null ? stripped : raw).trim();
            if (!text) {
                L.step(`услышал только «${wake}» — жду команду`);
                peekShow('text', 'слушаю…', 2200);
                V.followUpUntil = Date.now() + followUpMs();
                setState('idle', 'слушаю…');
                return;
            }

            // к нам обратились — приглушаем музыку до конца окна follow-up,
            // чтобы следующая команда записалась при тихих колонках
            duckUntil(V.followUpUntil);

            await runText(text, 'voice');
            L.ok(`цикл завершён за ${ms(tStart)}`);
        } catch (e) {
            V.errors++;
            L.err('сбой обработки фразы:', (e && e.message) || e);
            if (e && e.stack) L.dbg(e.stack);
            setState('error', String((e && e.message) || e).slice(0, 50));
        } finally {
            V.busy = false;
            if (V.state === 'thinking') setState(V.enabled ? 'idle' : 'off');
            // держим/снимаем приглушение по актуальному окну продолжения диалога
            duckUntil(V.followUpUntil);
        }
    }

    // сколько секунд слушать без слова-активатора после ответа
    function followUpMs() {
        const s = Number(V.cfg && V.cfg.followUpSec);
        return Math.max(0, Math.min(30, isNaN(s) ? 5 : s)) * 1000;
    }

    // ══════════════════════════════════════════════════
    //  ЕДИНЫЙ КОНВЕЙЕР: голос и текст из чата
    // ══════════════════════════════════════════════════
    async function runText(text, source) {
        const tStart = nowMs();
        addMessage('user', text);
        showCaption('«' + text.slice(0, 42) + '»');
        setState('thinking', 'думаю…');
        peekShow('think', '«' + text.slice(0, 70) + '»');

        const tIntent = nowMs();
        const thinking = showTyping();
        let intent;
        try {
            intent = await parseIntent(text);
        } finally {
            if (thinking) thinking.remove();
        }
        const intentMs = ms(tIntent);

        // ── обычный разговор ──
        if (intent.kind === 'chat') {
            V.chats++;
            V.lastKind = 'chat';
            pushHistory('user', text);
            pushHistory('assistant', intent.reply);

            L.step(`💬 разговор «${text}» · ответ за ${intentMs}`);
            L.ok(`ответ: «${intent.reply}»`);

            addMessage('bot', intent.reply);
            showCaption('отвечаю…');
            peekShow('speak', intent.reply);

            await speak(intent.reply);

            V.followUpUntil = Date.now() + followUpMs();
            V.armedUntil = 0;
            return { kind: 'chat' };
        }

        // ── ничего не понял ──
        if (intent.kind === 'none' || intent.action === 'none') {
            V.lastKind = 'none';
            L.step(`🤷 «${text}» — ни команды, ни ответа (${intent.local ? 'локально' : 'LLM'} ${intentMs})`);
            if (!intent.local) {
                L.dbg(V.cfg && V.cfg.chatMode === false
                    ? 'разговорный режим выключен — включите «Общаться на свободные темы» в настройках'
                    : 'модель промолчала — вероятно, фраза плохо распознана');
            }
            addMessage('sys', 'не понял — попробуйте иначе');
            peekShow('text', 'не понял', 2600);
            V.followUpUntil = Date.now() + followUpMs();
            return { kind: 'none' };
        }

        // ── команда ──
        V.commands++;
        V.lastKind = 'action';
        pushHistory('user', text);

        L.step(`▶ команда «${text}» → ${intent.action}` +
               (intent.value != null ? ` («${intent.value}»)` : '') +
               ` · ${intent.local ? 'локально' : 'LLM'} ${intentMs}`);

        const done = await execute(intent, text);

        const shown = done || intent.action;
        addMessage('action', shown);
        peekShow('text', '▸ ' + shown);
        pushHistory('assistant', intent.reply || ('выполнено: ' + intent.action));

        V.followUpUntil = Date.now() + followUpMs();
        V.armedUntil = 0;

        L.ok(`команда выполнена за ${ms(tStart)} · окно ${Math.round(followUpMs() / 1000)} с`);
        return { kind: 'action' };
    }

    // сообщение, набранное в чате
    async function submitText(text) {
        const clean = String(text || '').trim();
        if (!clean) return;
        if (V.busy) {
            addMessage('sys', 'ещё занят предыдущей фразой');
            return;
        }
        // из чата слово-активатор не нужно — если его случайно сказали, убираем
        const stripped = stripWake(clean);
        const body = (stripped !== null && stripped ? stripped : clean).trim();

        V.busy = true;
        try {
            L.step(`⌨ из чата: «${body}»`);
            await runText(body, 'chat');
        } catch (e) {
            V.errors++;
            L.err('сбой обработки сообщения из чата:', (e && e.message) || e);
            addMessage('sys', 'ошибка: ' + String((e && e.message) || e).slice(0, 80));
        } finally {
            V.busy = false;
            if (V.state === 'thinking') setState(V.enabled ? 'idle' : 'off');
        }
    }

    // ── слово-активатор ────────────────────────────────
    function normText(s) {
        return String(s || '')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // вернёт остаток фразы после слова-активатора, либо null
    function stripWake(text) {
        const n = normText(text);
        if (!n) return null;
        const variants = new Set(WAKE_VARIANTS);
        if (V.cfg && V.cfg.wakeWord) variants.add(normText(V.cfg.wakeWord));

        for (const v of variants) {
            if (!v) continue;
            const idx = n.indexOf(v);
            if (idx === -1) continue;
            if (idx > 14) continue;                        // активатор должен быть в начале
            const rest = n.slice(idx + v.length).trim();
            return rest;                                   // может быть пустым — это ок («Киво!»)
        }
        return null;
    }

    // ══════════════════════════════════════════════════
    //  ИНТЕНТ
    // ══════════════════════════════════════════════════
    const ACTIONS = [
        'next', 'prev', 'play', 'pause', 'toggle',
        'volume_up', 'volume_down', 'volume_set', 'mute', 'unmute',
        'seek_forward', 'seek_back',
        'wave_on', 'wave_off', 'wave_toggle',
        'queue_open', 'queue_close', 'queue_toggle',
        'lyrics_on', 'lyrics_off', 'lyrics_toggle',
        'like', 'dislike', 'now_playing', 'search_play', 'play_music', 'play_other',
        'play_genre', 'list_genres',
        'stop_voice', 'none'
    ];

    // ── контекст плеера: чтобы «а кто это поёт?» и «погромче» имели смысл ──
    function playerContext() {
        const a = audioEl();
        const track = nowPlayingText() || 'ничего не играет';
        const playing = a ? (a.paused ? 'на паузе' : 'играет') : '—';
        // показываем пользовательскую громкость, а не приглушённую
        const vol = Math.round(userVolume() * 100);
        const now = new Date();
        const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const date = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
        const genre = currentGenreText();

        return [
            `трек: ${track} (${playing})`,
            genre ? `жанр: ${genre}` : '',
            `громкость: ${vol}%`,
            `режим волны: ${isWave() ? 'включён' : 'выключен'}`,
            `сейчас: ${date}, ${time}`
        ].filter(Boolean).join(' · ');
    }

    // ── история диалога ──
    const historyLimit = () => {
        const turns = Number((V.cfg && V.cfg.contextTurns) || 6);
        return Math.max(0, Math.min(20, turns)) * 2;      // реплики = сообщения / 2
    };

    function pushHistory(role, content) {
        const text = String(content || '').trim();
        if (!text) return;
        V.history.push({ role, content: text.slice(0, CONTEXT_CHARS) });
        V.historyAt = Date.now();
        const limit = historyLimit();
        while (limit && V.history.length > limit) V.history.shift();
        if (!limit) V.history = [];
    }

    function historyForLLM() {
        if (!V.history.length) return [];
        if (Date.now() - V.historyAt > CONTEXT_TTL_MS) {
            L.dbg('контекст устарел — начинаю разговор с чистого листа');
            V.history = [];
            return [];
        }
        // лимит применяем и на чтении: если в настройках уменьшили глубину,
        // это должно действовать сразу, а не после следующей реплики
        const limit = historyLimit();
        const slice = limit ? V.history.slice(-limit) : [];
        if (slice.length !== V.history.length) {
            L.dbg(`контекст обрезан до ${slice.length} реплик (лимит ${limit})`);
        }
        return slice;
    }

    function resetContext() {
        const n = V.history.length;
        V.history = [];
        V.historyAt = 0;
        L.step(`контекст сброшен (было ${n} реплик)`);
        return n;
    }

    function systemPrompt() {
        const wake = (V.cfg && V.cfg.wakeWord) || 'киво';
        const chatty = !V.cfg || V.cfg.chatMode !== false;

        return `Ты — голосовой помощник музыкального плеера KivoPlayer.
К тебе обращаются по имени «${wake}» — это слово-активатор в начале фразы.
Отвечай по-русски, живо и по-человечески, как живой собеседник, а не как справочная.

На вход приходит распознанная речь (возможны ошибки ASR — догадывайся по смыслу).
Реши, что это: команда плееру или обычный разговор/вопрос.

Ответ — СТРОГО валидный JSON без markdown и пояснений:
{"action":"...","value":null,"reply":"..."}

action — одно из: ${ACTIONS.join(', ')}.
  • Ставь действие только если пользователь явно просит что-то сделать с плеером.
  • Во всех остальных случаях (вопрос, болтовня, просьба что-то рассказать) — "none".
value — для search_play/play_music/play_other строка (исполнитель или название),
        для play_genre строка (жанр),
        для volume_set число 0..1, для seek_forward/seek_back число секунд.

Включать музыку:
  • search_play / play_music — value: исполнитель или название песни, как назвал пользователь.
    Не нужно угадывать точное название — плеер сам найдёт в медиатеке.
  • play_genre — когда просят ЖАНР, а не конкретного исполнителя: «рок», «джаз»,
    «что-нибудь роковое», «включи из металла». value — жанр словами пользователя.
  • play_other — когда просят ДРУГУЮ песню: «другую», «ещё одну», «не эту», «что-то другое».
    value — исполнитель, если его назвали; если нет (просто «включи другую») — null,
    тогда берётся тот, кто играет сейчас.
  • list_genres — когда спрашивают, какие жанры есть в медиатеке.

Медиатека:
${libSummary()}

Если пользователь называет исполнителя — по возможности пиши его так же, как в списке выше.

reply — то, что ты произнесёшь голосом. Это ОЗВУЧКА, а не текст на экране:
  • никаких эмодзи, markdown, списков, ссылок, скобок;
  • команда → короткое подтверждение (до 6 слов) или "" если и так понятно;
  • ${chatty ? 'разговор → нормальный ответ на 1–3 предложения, до 40 слов' : 'разговор → всегда "" (свободное общение выключено)'}.
  • не выдумывай факты. Если не знаешь трек, исполнителя, год, текст — так и скажи.
  • числа и единицы пиши словами, как удобно произносить.

Контекст прямо сейчас: ${playerContext()}

Помни предыдущие реплики. «ещё», «другой», «погромче», «а кто это», «почему» относятся к тому,
что обсуждалось выше. Если пользователь ссылается на прошлое («тот трек», «как ты сказал»),
используй историю. Не переспрашивай то, что уже понятно из контекста.

Примеры:
"следующий" → {"action":"next","value":null,"reply":""}
"сделай тише" → {"action":"volume_down","value":null,"reply":""}
"включи кино" → {"action":"play_music","value":"кино","reply":""}
"включи песню полины гагариной" → {"action":"play_music","value":"Полина Гагарина","reply":""}
"включи другую песню полины гагариной" → {"action":"play_other","value":"Полина Гагарина","reply":""}
"а есть что-то другое у него" → {"action":"play_other","value":null,"reply":""}
"включи рок" → {"action":"play_genre","value":"рок","reply":""}
"поставь что-нибудь джазовое" → {"action":"play_genre","value":"джаз","reply":""}
"какие жанры у меня есть" → {"action":"list_genres","value":null,"reply":""}
"а кто поёт эту песню" → {"action":"none","value":null,"reply":"По данным плеера это исполнитель, который указан в треке. Если тегов нет, точнее не скажу."}
"как думаешь, что включить под дождь" → {"action":"none","value":null,"reply":"Под дождь хорошо заходит что-то спокойное — джаз или акустика. Хочешь, включу?"}
"спасибо" → {"action":"none","value":null,"reply":"Всегда пожалуйста."}`;
    }

    // быстрые локальные правила — не тратят запрос и отвечают мгновенно.
    // ВАЖНО: \b в JS не работает для кириллицы (\w — только ASCII),
    // поэтому конец слова проверяем через (?=\s|$), а основы слов — через [а-яё]*.
    const LOCAL_RULES = [
        { re: /^следующ[а-яё]*(?=\s|$)/, action: 'next' },
        { re: /^(дальше|next)(?=\s|$)/, action: 'next' },
        { re: /^предыдущ[а-яё]*(?=\s|$)/, action: 'prev' },
        { re: /^(назад|prev|верни)(?=\s|$)/, action: 'prev' },
        { re: /^(пауза|паузу|останови|стоп|пауз)(?=\s|$)/, action: 'pause' },
        { re: /^(продолжи|продолжай|играй|плей|play)(?=\s|$)/, action: 'play' },
        { re: /^(тише|убавь|сделай тише|потише)(?=\s|$)/, action: 'volume_down' },
        { re: /^(громче|прибавь|сделай громче|погромче)(?=\s|$)/, action: 'volume_up' },
        { re: /^(выключи звук|без звука|мьют|mute)(?=\s|$)/, action: 'mute' },
        { re: /^(включи звук|верни звук|unmute)(?=\s|$)/, action: 'unmute' },
        { re: /^(волна|волну|режим волны|включи волну)(?=\s|$)/, action: 'wave_toggle' },
        { re: /^очеред[а-яё]*(?=\s|$)/, action: 'queue_toggle' },
        { re: /^истори[а-яё]*(?=\s|$)/, action: 'queue_toggle' },
        { re: /^что дальше(?=\s|$)/, action: 'queue_toggle' },
        { re: /^(текст|слова|лирикс|lyrics)(?=\s|$)/, action: 'lyrics_toggle' },
        { re: /^(нравится|лайк|like|в избранное)(?=\s|$)/, action: 'like' },
        { re: /^(не нравится|дизлайк|dislike)(?=\s|$)/, action: 'dislike' },
        { re: /^(что играет|что за трек|кто поет|что сейчас)(?=\s|$)/, action: 'now_playing' },
        // «какой жанр играет» → ответ через now_playing (он добавит жанр),
        // «какие жанры есть» → список жанров медиатеки
        { re: /^(?:какой|что за)\s+(?:сейчас\s+)?жанр/, action: 'now_playing' },
        { re: /^(?:какие|что за|перечисли|список|все)\s+(?:у меня\s+)?жанр/, action: 'list_genres' },
        { re: /^жанр[а-яё]*(?=\s|$)/, action: 'list_genres' },
        { re: /^(хватит|замолчи|выключись|отключись)(?=\s|$)/, action: 'stop_voice' },
        // «включи другую песню [кого]» — не требует LLM, отвечаем мгновенно
        { re: /^(?:включи|поставь|давай|а)?\s*(?:мне\s+)?(?:другую|другой|другое|еще одну|ещё одну|не эту)\s*(?:песню|трек|композицию|вещь)?\s*(.*)$/, action: 'play_other', arg: 1 },
        // «поставь X» — но НЕ когда просят «что-нибудь ещё/другое»: там нужен выбор трека,
        // а не поиск по фразе целиком (иначе включится первый попавшийся, часто текущий)
        { re: /^(найди|поставь|включи трек|включи песню|включи группу|хочу послушать)\s+((?!(?:.*(?:еще|ещё|друг|иное|новое|новую|новый|не эту))).{2,})$/, action: 'search_play', arg: 2 }
    ];

    // «включи рок», «поставь что-нибудь джазовое», «включи рок-музыку».
    // Реагируем только если в фразе НЕТ ничего, кроме жанра:
    // «включи рок-группу кино» — это про Кино, пусть решает LLM.
    function localGenreIntent(text) {
        if (!library()) return null;
        const G = window.KivoGenres;
        if (!G) return null;

        const n = normText(text);
        // \b для кириллицы не работает — конец слова проверяем явно
        if (!/^(включи|поставь|давай|хочу|послушать|мне)(?=\s|$)/.test(n)) return null;

        const parsed = G.consume(text);
        const g = resolveGenre(text);
        if (!g) return null;

        // после жанра не должно остаться ничего значимого, иначе это фраза
        // про исполнителя или песню: «включи рок-группу кино» — это Кино.
        // Свободные жанры («синтвейв») справочник не знает, поэтому их слова
        // сравниваем с названием самого жанра.
        const gWords = tokenize(g.label).concat(tokenize(g.id));
        const rest = meaningfulRest(parsed.rest).filter(w => {
            const parts = String(w).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
            return !parts.length || !parts.every(p => gWords.some(gw => stemMatch(p, gw)));
        });
        if (rest.length) return null;

        L.dbg(`жанр по фразе: «${text}» → ${g.label}`);
        return { action: 'play_genre', value: g.id, reply: '', local: true };
    }

    function localIntent(text) {
        const genre = localGenreIntent(text);
        if (genre) return genre;

        const n = normText(text);
        for (const rule of LOCAL_RULES) {
            const m = n.match(rule.re);
            if (!m) continue;
            return {
                action: rule.action,
                value: rule.arg ? m[rule.arg] : null,
                reply: '',
                local: true
            };
        }
        return null;
    }

    // Возвращает { action, value, reply, kind, local }.
    // kind: 'action' — команда плееру, 'chat' — обычный ответ, 'none' — молчим.
    async function parseIntent(text) {
        const quick = localIntent(text);
        if (quick) {
            L.dbg('интент: локальное правило → ' + quick.action);
            return Object.assign({ kind: 'action' }, quick);
        }

        const chatty = !V.cfg || V.cfg.chatMode !== false;
        const history = historyForLLM();
        L.dbg(`интент: спрашиваю ${(V.cfg && V.cfg.chatModel) || 'LLM'} · ` +
              `в контексте ${history.length} репл. · разговор ${chatty ? 'вкл' : 'выкл'}`);

        try {
            const data = await api.chat({
                body: {
                    messages: [
                        { role: 'system', content: systemPrompt() },
                        ...history,
                        { role: 'user', content: text }
                    ],
                    response_format: { type: 'json_object' },
                    max_tokens: 320
                },
                timeout: 25000
            });

            const msg = data && data.choices && data.choices[0] && data.choices[0].message;
            let content = msg ? msg.content : '';
            if (Array.isArray(content)) content = content.map(p => p.text || '').join('');
            content = String(content || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

            L.dbg('LLM ответил:', content);

            const parsed = JSON.parse(content);
            const action = ACTIONS.includes(parsed.action) ? parsed.action : 'none';
            if (action !== parsed.action) L.warn('LLM вернул неизвестное действие:', parsed.action);

            const reply = typeof parsed.reply === 'string' ? cleanSpeech(parsed.reply) : '';
            const kind = action !== 'none' ? 'action' : (reply && chatty ? 'chat' : 'none');

            return {
                action,
                value: parsed.value != null ? parsed.value : null,
                reply,
                kind,
                local: false
            };
        } catch (e) {
            const fallback = fuzzyIntent(text);
            L.warn(`LLM не ответил (${e.message}) → грубый разбор по словам: ${fallback}`);
            return {
                action: fallback,
                value: null,
                reply: '',
                kind: fallback !== 'none' ? 'action' : 'none',
                local: true
            };
        }
    }

    // ответ идёт в TTS — вычищаем то, что нельзя произнести
    function cleanSpeech(s) {
        return String(s || '')
            .replace(/[*_`#>|]+/g, ' ')                       // markdown
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')          // ссылки
            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')  // эмодзи
            .replace(/\s+/g, ' ')
            .trim();
    }

    function fuzzyIntent(text) {
        const n = normText(text);
        if (/следующ|дальше|next/.test(n)) return 'next';
        if (/предыдущ|назад|prev/.test(n)) return 'prev';
        if (/пауз|стоп|останов/.test(n)) return 'pause';
        if (/громче|прибав/.test(n)) return 'volume_up';
        if (/тише|убав/.test(n)) return 'volume_down';
        if (/волн/.test(n)) return 'wave_toggle';
        if (/очеред|истори/.test(n)) return 'queue_toggle';
        if (/текст|слова/.test(n)) return 'lyrics_toggle';
        if (/что играет|что за трек/.test(n)) return 'now_playing';
        if (/друг(ую|ой|ое)\s+(песн|трек|композ)/.test(n)) return 'play_other';
        return 'none';
    }

    // ══════════════════════════════════════════════════
    //  ГРОМКОСТЬ: пользовательский уровень — источник правды
    //  При приглушении играет userVolume × 0.25, но команды «громче/тише/
    //  громкость 40» всегда работают с userVolume. Иначе возврат громкости
    //  после диалога затирал бы только что сказанную команду.
    // ══════════════════════════════════════════════════
    const DUCK_RATIO = 0.25;

    function applyVolume() {
        const a = audioEl();
        if (!a) return;
        if (V.userVolume == null) V.userVolume = a.volume;
        const target = V.ducked
            ? Math.max(0.02, V.userVolume * DUCK_RATIO)
            : V.userVolume;
        if (Math.abs(a.volume - target) > 0.001) a.volume = target;
        a.muted = V.userVolume <= 0;
    }

    // следим за внешними изменениями громкости, но не за своими же:
    // во время приглушения и во время озвучки уровень временный
    function watchVolume() {
        const a = audioEl();
        if (!a || a.__kivoVolumeWatch) return;
        a.__kivoVolumeWatch = true;
        a.addEventListener('volumechange', () => {
            if (!V.ducked && !V.ttsAudio) V.userVolume = a.volume;
        });
    }

    function setVolume(v) {
        const a = audioEl();
        if (!a) return;
        V.userVolume = Math.max(0, Math.min(1, Number(v) || 0));
        applyVolume();
    }

    // пользовательский уровень громкости (не приглушённый)
    function userVolume() {
        if (V.userVolume == null) {
            const a = audioEl();
            V.userVolume = a ? a.volume : 1;
        }
        return V.userVolume;
    }

    //  ИСПОЛНЕНИЕ
    // ══════════════════════════════════════════════════

    function goPrev() {
        const a = audioEl();
        if (a && a.currentTime > 5) { a.currentTime = 0; return; }
        if (typeof waveMode !== 'undefined' && waveMode && typeof RecoEngine !== 'undefined') {
            const prev = RecoEngine.goBack();
            if (prev && typeof playTrack === 'function') return playTrack(prev, { fromHistory: true });
        }
        const btn = $('btn-prev');
        if (btn) btn.click();
    }

    function isWave() {
        return typeof waveMode !== 'undefined' && !!waveMode;
    }

    function setWave(on) {
        if (isWave() === !!on) return;      // уже в нужном состоянии
        const btn = $('wave-btn');
        if (btn) btn.click();
    }

    function setQueueView(on) {
        if (typeof setWaveViewOpen !== 'function') return;
        if (!isWave()) {
            if (!on) return;
            const wb = $('wave-btn');
            if (wb) wb.click();
            setTimeout(() => setQueueView(true), 700);
            return;
        }
        setWaveViewOpen(!!on);
    }

    function setLyrics(on) {
        const onNow = typeof lyricsMode !== 'undefined' && !!lyricsMode;
        if (onNow === !!on) return;
        const btn = $('lyrics-button');
        if (btn) btn.click();
    }

    // ══════════════════════════════════════════════════
    //  МЕДИАТЕКА
    //  Плеер отдаёт доступ к своей библиотеке через window.KivoLibrary
    //  (см. index-test.html). Помощник не просто «ищет и берёт первое»,
    //  а сам выбирает трек: помнит, что играет, кого просили и что уже звучало.
    // ══════════════════════════════════════════════════
    function library() {
        const L = window.KivoLibrary;
        return (L && typeof L.count === 'function') ? L : null;
    }

    // кэш списка исполнителей — он не меняется, пока не поменяется библиотека
    let libArtistsCache = { at: 0, count: -1, list: null };

    function libArtists(lib) {
        const n = lib.count();
        if (libArtistsCache.list && libArtistsCache.count === n &&
            Date.now() - libArtistsCache.at < 15000) {
            return libArtistsCache.list;
        }
        libArtistsCache = { at: Date.now(), count: n, list: lib.artists() };
        return libArtistsCache.list;
    }

    // кэш жанров: во время фонового чтения тегов он быстро устаревает,
    // поэтому TTL короче, чем у исполнителей
    let libGenresCache = { at: 0, count: -1, list: null };

    function libGenres(lib) {
        const n = lib.count();
        if (libGenresCache.list && libGenresCache.count === n &&
            Date.now() - libGenresCache.at < 5000) {
            return libGenresCache.list;
        }
        libGenresCache = { at: Date.now(), count: n, list: (lib.genres ? lib.genres() : []) };
        return libGenresCache.list;
    }

    // слова, которые не помогают опознать исполнителя
    const NOISE_TOKENS = new Set([
        'включи', 'поставь', 'давай', 'хочу', 'можно', 'пожалуйста', 'мне', 'нам',
        'песню', 'песня', 'песни', 'песен', 'трек', 'треки', 'композицию', 'композиция',
        'вещь', 'группу', 'группа', 'исполнителя', 'исполнитель', 'музыку', 'музыка',
        'что', 'нибудь', 'послушать', 'послушаем', 'еще', 'ещё', 'эту', 'этот', 'это',
        'его', 'ее', 'её', 'их', 'тот', 'та', 'the', 'какой', 'какую', 'какое',
        // жанры
        'жанр', 'жанра', 'жанре', 'жанру', 'жанром', 'жанров', 'жанры', 'энд', 'and'
    ]);

    function tokenize(s) {
        return String(s || '').toLowerCase().replace(/ё/g, 'е')
            .split(/[^\p{L}\p{N}]+/u)
            .filter(t => t.length > 1);
    }

    // «полины» ~ «полина», «гагариной» ~ «гагарина» — сравниваем основы слов.
    // Русские окончания меняются в конце, поэтому первых символов достаточно.
    function stemMatch(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        const n = Math.min(a.length, b.length, 5);
        if (n < 3) return false;
        return a.slice(0, n) === b.slice(0, n);
    }

    function contentTokens(text) {
        return tokenize(text).filter(t => !NOISE_TOKENS.has(t) && t.length > 2);
    }

    // ищем исполнителя в медиатеке по тому, как его назвали голосом
    function resolveArtist(query) {
        const lib = library();
        if (!lib || !lib.count()) return null;

        const q = contentTokens(query);
        if (!q.length) return null;

        let best = null;
        let bestScore = 0;

        for (const a of libArtists(lib)) {
            const aTokens = tokenize(a.name);
            if (!aTokens.length) continue;

            let hit = 0;
            for (const at of aTokens) {
                if (q.some(qt => stemMatch(qt, at))) hit++;
            }
            if (!hit) continue;

            // покрытие считается по короткой стороне: «гагариной» тоже должно попадать
            const score = hit / Math.min(aTokens.length, q.length);
            if (score > bestScore + 0.001 ||
                (Math.abs(score - bestScore) < 0.001 && best && a.count > best.count)) {
                best = a;
                bestScore = score;
            }
        }

        return bestScore >= 0.6 ? best : null;
    }

    // ── жанры ──────────────────────────────────────────────
    // Разбор фразы: сначала справочник синонимов («роковое» → рок),
    // потом реальные жанры библиотеки — в тегах бывает что угодно,
    // вплоть до «Trip-Hop», которого в справочнике нет.
    function resolveGenre(query) {
        const lib = library();
        if (!lib || !lib.count()) return null;

        const tokens = contentTokens(query);
        if (!tokens.length) return null;

        const G = window.KivoGenres;
        if (G) {
            const ids = G.consume(tokens.join(' ')).ids;
            if (ids.length) {
                // если в библиотеке есть — берём первый, который реально существует
                const alive = ids.filter(id => (lib.byGenre ? lib.byGenre(id).length : 0));
                const pick = alive[0] || ids[0];
                return { id: pick, label: G.label(pick), from: 'dict' };
            }
        }

        // свободный жанр из тегов: «трип-хоп», «synthwave», «easy listening»
        let best = null;
        let bestScore = 0;
        for (const g of libGenres(lib)) {
            const gTokens = tokenize(g.label);
            if (!gTokens.length) continue;

            let hit = 0;
            for (const gt of gTokens) {
                if (tokens.some(t => stemMatch(t, gt))) hit++;
            }
            if (!hit) continue;

            const score = hit / Math.min(gTokens.length, tokens.length);
            if (score > bestScore + 0.001) {
                best = g;
                bestScore = score;
            }
        }
        return bestScore >= 0.6 ? { id: best.id, label: best.label, from: 'library' } : null;
    }

    // что осталось от фразы после жанра: «рок-группа кино» — это не «включи рок»
    function meaningfulRest(restWords) {
        return (restWords || []).filter(w => {
            const parts = String(w).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
            return parts.some(p => p.length > 2 && !NOISE_TOKENS.has(p));
        });
    }

    // что осталось от запроса после имени исполнителя (вдруг там название песни)
    function restTokens(query, artistName) {
        const aTokens = tokenize(artistName);
        return contentTokens(query).filter(t => !aTokens.some(at => stemMatch(t, at)));
    }

    function titleMatches(info, tokens) {
        if (!tokens.length) return false;
        const tTokens = tokenize(info.title);
        return tokens.every(t => tTokens.some(tt => stemMatch(t, tt)));
    }

    function trackLabel(info) {
        const artist = (info.artists || []).join(', ');
        return artist ? `«${info.title}» — ${artist}` : `«${info.title}»`;
    }

    // выбрать трек и показать его же в боковом списке
    function playInfo(info, filterName) {
        const lib = library();
        if (!lib || !info) return { ok: false, why: 'Не нашёл такой трек.' };
        try {
            lib.filterBy(filterName || (info.artists || [])[0] || info.title);
        } catch (_) { /* список — необязательная часть */ }
        const ok = lib.play(info.index);
        return ok
            ? { ok: true, track: info, reply: 'Включаю ' + trackLabel(info) }
            : { ok: false, why: 'Не смог включить этот трек.' };
    }

    // «включи Полину Гагарину» / «включи группу крови»
    function playMusic(query) {
        const lib = library();
        const q = String(query || '').trim();
        if (!q) return { ok: false, why: 'Что включить?' };

        if (!lib || !lib.count()) {
            // страховка на случай плеера без моста медиатеки
            if (typeof executeSearch === 'function' && typeof playTrack === 'function') {
                const input = $('search-input');
                if (input) input.value = q;
                executeSearch(q);
                const list = (typeof filteredTracks !== 'undefined') ? filteredTracks : [];
                if (list.length) {
                    playTrack(list[0]);
                    return { ok: true, reply: 'Включаю' };
                }
            }
            return { ok: false, why: 'Медиатека пуста — откройте папку с музыкой.' };
        }

        L.dbg(`медиатека: ${lib.count()} треков, ищу «${q}»`);

        const artist = resolveArtist(q);
        if (artist) {
            const own = lib.byArtist(artist.name);
            L.dbg(`опознал исполнителя: ${artist.name} (${own.length} треков)`);

            // в запросе могло остаться название песни
            const rest = restTokens(q, artist.name);
            if (rest.length) {
                const byTitle = own.filter(t => titleMatches(t, rest));
                if (byTitle.length) return playInfo(byTitle[0], artist.name);
            }
            if (own.length) return playInfo(own[0], artist.name);
        }

        const hits = lib.find(q);
        L.dbg(`поиск по библиотеке: ${hits.length} совпадений`);
        if (hits.length) return playInfo(hits[0], null);

        return { ok: false, why: `Не нашёл «${q}»` };
    }

    // «включи другую песню Полины Гагариной» — не повторяя то, что играет
    function playOther(artistQuery) {
        const lib = library();
        if (!lib || !lib.count()) return { ok: false, why: 'Медиатека пуста — откройте папку с музыкой.' };

        const cur = lib.current();
        const q = String(artistQuery || '').trim();

        let artist = q ? resolveArtist(q) : null;
        // исполнителя не назвали — берём того, кто играет сейчас
        if (!artist && cur && cur.artists && cur.artists.length) {
            artist = resolveArtist(cur.artists.join(' '));
            if (artist) L.dbg(`исполнитель не назван — беру текущего: ${artist.name}`);
        }
        if (!artist) {
            // может, это жанр: «включи ещё рок»
            const g = resolveGenre(q);
            if (g) {
                L.dbg(`«другую» про жанр: ${g.label}`);
                return playByGenre(g.id);
            }
            return { ok: false, why: 'Не понял, чью песню включить.' };
        }

        const own = lib.byArtist(artist.name);
        if (!own.length) return { ok: false, why: `У ${artist.name} ничего нет в медиатеке.` };

        const curIdx = cur ? cur.index : -1;
        const recent = new Set(lib.recent(20).map(t => t.index));

        // «только не эту»: если в value попало название песни, её не берём
        const avoid = new Set();
        if (q) {
            const qTokens = contentTokens(q);
            const asTrack = lib.find(q)[0];
            if (asTrack && qTokens.length && titleMatches(asTrack, qTokens)) avoid.add(asTrack.index);
        }

        let pool = own.filter(t => t.index !== curIdx && !avoid.has(t.index) && !recent.has(t.index));
        if (!pool.length) pool = own.filter(t => t.index !== curIdx && !avoid.has(t.index));
        if (!pool.length) pool = own.filter(t => t.index !== curIdx);
        if (!pool.length) {
            return { ok: false, why: `У ${artist.name} только одна песня — она и играет.` };
        }

        // следующая по порядку после текущей: без случайных повторов
        const at = own.findIndex(t => t.index === curIdx);
        const ordered = at >= 0 ? own.slice(at + 1).concat(own.slice(0, at)) : own;
        const pick = ordered.find(t => pool.some(p => p.index === t.index)) || pool[0];

        L.dbg(`другая песня ${artist.name}: «${pick.title}» (сейчас «${cur ? cur.title : '—'}»)`);
        return playInfo(pick, artist.name);
    }

    // «включи рок» — берём трек этого жанра, не повторяя текущий и недавние
    function playByGenre(genreQuery) {
        const lib = library();
        if (!lib || !lib.count()) return { ok: false, why: 'Медиатека пуста — откройте папку с музыкой.' };

        const g = resolveGenre(genreQuery);
        if (!g) return { ok: false, why: `Не понял, какой это жанр: «${genreQuery}»` };

        const all = lib.byGenre ? lib.byGenre(g.id) : [];
        if (!all.length) return { ok: false, why: `В медиатеке нет жанра «${g.label}».` };

        const cur = lib.current();
        const curIdx = cur ? cur.index : -1;
        const recent = new Set(lib.recent(20).map(t => t.index));

        let pool = all.filter(t => t.index !== curIdx && !recent.has(t.index));
        if (!pool.length) pool = all.filter(t => t.index !== curIdx);
        if (!pool.length) pool = all;

        const pick = pool[0];
        L.dbg(`жанр ${g.label}: ${all.length} треков, включаю «${pick.title}»`);

        // боковой список — в этот жанр
        try { if (lib.filterByGenre) lib.filterByGenre(g.id); } catch (_) { /* список необязателен */ }

        const ok = lib.play(pick.index);
        if (!ok) return { ok: false, why: 'Не смог включить этот трек.' };

        const G = window.KivoGenres;
        const name = G ? G.sayable(g.id) : g.label;
        const artist = (pick.artists || []).join(', ');
        const reply = artist
            ? `Включаю ${name}: «${pick.title}» — ${artist}`
            : `Включаю ${name}: «${pick.title}»`;

        return { ok: true, track: pick, reply };
    }

    // «какой жанр играет» — для контекста и ответа
    function currentGenreText() {
        const lib = library();
        const cur = lib && lib.current ? lib.current() : null;
        const g = cur && cur.genres && cur.genres[0];
        if (!g) return '';
        return window.KivoGenres ? window.KivoGenres.label(g) : g;
    }

    // короткая сводка жанров для промпта
    function genreSummary() {
        const lib = library();
        if (!lib || !lib.count()) return '—';
        const list = libGenres(lib);
        if (!list.length) return 'жанры не определены (нет тегов и папок по жанрам)';
        return list.slice(0, 10).map(g => `${g.label} — ${g.count}`).join(', ');
    }

    // то же, но как фраза для озвучки
    function genresText(limit = 8) {
        const lib = library();
        if (!lib || !lib.count()) return 'Медиатека пуста — откройте папку с музыкой.';
        const list = libGenres(lib);
        if (!list.length) {
            return 'Жанры не определены: в файлах нет тега жанра, и папки не разложены по жанрам.';
        }
        const names = list.slice(0, limit).map(g => g.label.toLowerCase());
        return 'Есть ' + names.join(', ') + (list.length > limit ? ' и другие' : '') + '.';
    }

    // краткая сводка библиотеки для промпта
    function libSummary() {
        const lib = library();
        if (!lib || !lib.count()) return 'Медиатека пуста (папка с музыкой не открыта).';

        const artists = libArtists(lib);
        const top = artists.slice(0, 12).map(a => `${a.name} (${a.count})`).join(', ');
        const recent = lib.recent(5).map(t => {
            const a = (t.artists || []).join(', ');
            return a ? `${a} — ${t.title}` : t.title;
        }).join('; ');
        const cur = lib.current();

        return [
            `всего ${lib.count()} треков, ${artists.length} исполнителей`,
            cur ? `играет: ${(cur.artists || []).join(', ')} — ${cur.title}` : 'ничего не играет',
            recent ? `недавно: ${recent}` : '',
            top ? `чаще всего: ${top}` : '',
            `жанры: ${genreSummary()}`
        ].filter(Boolean).join('\n');
    }

    function searchAndPlay(query) {
        return playMusic(query).ok;
    }

    function nowPlayingText() {
        const t = $('current-track-title');
        const a = $('current-track-artists');
        if (!t) return '';
        const title = t.textContent || '';
        const artist = a ? (a.textContent || '').trim() : '';
        return artist ? (artist + ' — ' + title) : title;
    }

    async function execute(intent, heardText) {
        const a = audioEl();
        let reply = intent.reply || '';

        if (intent.action === 'none') {
            L.step('не команда плееру — ничего не делаю');
            return '';
        }
        L.dbg('выполняю: ' + intent.action + (intent.value != null ? ' / ' + intent.value : ''));

        switch (intent.action) {
            case 'next':
                if (typeof playNext === 'function') playNext();
                reply = reply || 'Дальше';
                break;

            case 'prev':
                goPrev();
                reply = reply || 'Назад';
                break;

            case 'play':
                if (a && a.paused) a.play().catch(() => {});
                reply = reply || '';
                break;

            case 'pause':
                if (a && !a.paused) a.pause();
                break;

            case 'toggle': {
                const btn = $('btn-toggle');
                if (btn) btn.click();
                break;
            }

            // громкость всегда крутим от пользовательского уровня: во время
            // приглушения a.volume — это четверть от него, и команда улетела бы мимо
            case 'volume_up':
                setVolume(userVolume() + 0.1);
                reply = reply || ('Громкость ' + Math.round(userVolume() * 100) + '%');
                break;

            case 'volume_down':
                setVolume(userVolume() - 0.1);
                reply = reply || ('Громкость ' + Math.round(userVolume() * 100) + '%');
                break;

            case 'volume_set': {
                const v = Number(intent.value);
                if (!isNaN(v)) setVolume(v > 1 ? v / 100 : v);
                reply = reply || ('Громкость ' + Math.round(userVolume() * 100) + '%');
                break;
            }

            case 'mute':
                V.prevVolume = userVolume() || 1;
                setVolume(0);
                break;

            case 'unmute':
                setVolume(V.prevVolume || 0.7);
                break;

            case 'seek_forward':
                if (a) a.currentTime = Math.min(a.duration || 1e9, a.currentTime + (Number(intent.value) || 15));
                break;

            case 'seek_back':
                if (a) a.currentTime = Math.max(0, a.currentTime - (Number(intent.value) || 15));
                break;

            case 'wave_on':
                setWave(true);
                reply = reply || 'Волна включена';
                break;

            case 'wave_off':
                setWave(false);
                break;

            case 'wave_toggle':
                setWave(!isWave());
                reply = reply || (isWave() ? 'Волна включена' : 'Волна выключена');
                break;

            case 'queue_open':
                setQueueView(true);
                break;

            case 'queue_close':
                setQueueView(false);
                break;

            case 'queue_toggle':
                if (!isWave()) {
                    setQueueView(true);
                    reply = reply || 'Включаю волну';
                } else {
                    setQueueView(!(typeof waveViewOpen !== 'undefined' && waveViewOpen));
                }
                break;

            case 'lyrics_on':
                setLyrics(true);
                break;

            case 'lyrics_off':
                setLyrics(false);
                break;

            case 'lyrics_toggle':
                setLyrics(!(typeof lyricsMode !== 'undefined' && lyricsMode));
                break;

            case 'like': {
                const b = $('btn-favorite');
                if (b && b.style.display !== 'none') b.click();
                else reply = 'Волна выключена';
                break;
            }

            case 'dislike': {
                const b = $('btn-dislike');
                if (b && b.style.display !== 'none') b.click();
                else reply = 'Волна выключена';
                break;
            }

            case 'now_playing': {
                reply = nowPlayingText() || 'Ничего не играет';
                const cg = currentGenreText();
                if (cg) reply += '. Жанр: ' + cg;
                break;
            }

            case 'search_play':
            case 'play_music': {
                const q = String(intent.value || '').trim();
                if (!q) { reply = 'Что включить?'; break; }
                const res = playMusic(q);
                reply = res.ok ? res.reply : res.why;
                break;
            }

            case 'play_other': {
                const res = playOther(intent.value);
                reply = res.ok ? res.reply : res.why;
                break;
            }

            case 'play_genre': {
                const res = playByGenre(intent.value);
                reply = res.ok ? res.reply : res.why;
                break;
            }

            case 'list_genres':
                reply = genresText();
                break;

            case 'stop_voice':
                reply = 'Выключаюсь';
                L.step('выключаюсь по команде');
                await speak(reply);
                disable();
                return reply;

            case 'none':
            default:
                // не команда — просто молчим
                return '';
        }

        L.ok('действие выполнено: ' + intent.action);
        if (reply) await speak(reply);
        return reply;
    }

    // ══════════════════════════════════════════════════
    //  ОЗВУЧКА
    // ══════════════════════════════════════════════════
    async function speak(text) {
        if (!text) return;
        if (!V.cfg || !V.cfg.ttsEnabled) {
            L.dbg('озвучка выключена — молчу: «' + text + '»');
            return;
        }
        stopSpeech();

        try {
            setState('speaking', text.slice(0, 46));
            L.step(`🔊 озвучиваю: «${text}»`);
            const tTts = nowMs();
            const res = await api.tts({ text });
            if (!res || !res.ok) {
                V.errors++;
                L.err('озвучка не удалась:', (res && res.error) || 'сбой');
                setState('idle');
                return;
            }
            L.ok('озвучка получена за ' + ms(tTts));

            const bytes = Uint8Array.from(atob(res.audio), c => c.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], { type: res.mime || 'audio/mpeg' }));
            const player = new Audio(url);

            const a = audioEl();
            // если музыка уже приглушена (окно follow-up), озвучка должна
            // запомнить настоящую громкость, а не приглушённую
            V.prevVolume = userVolume();
            if (a) a.volume = Math.max(0, V.prevVolume * 0.22);   // приглушаем музыку

            V.ttsAudio = player;

            const restore = () => {
                L.dbg('озвучка закончилась · громкость музыки восстановлена');
                if (a) a.volume = musicVolumeLevel();
                URL.revokeObjectURL(url);
                if (V.ttsAudio === player) V.ttsAudio = null;
                if (V.enabled) setState('idle');
            };
            player.onended = restore;
            player.onerror = restore;

            await player.play().catch(restore);
        } catch (e) {
            V.errors++;
            L.err('озвучка упала:', e.message);
            if (V.enabled) setState('idle');
        }
    }

    function stopSpeech() {
        if (!V.ttsAudio) return;
        L.dbg('останавливаю озвучку');
        try { V.ttsAudio.pause(); } catch (_) {}
        V.ttsAudio.onended = null;
        V.ttsAudio.onerror = null;
        V.ttsAudio = null;
        const a = audioEl();
        if (a) a.volume = musicVolumeLevel();
        if (V.enabled) setState('idle');
    }

    // ══════════════════════════════════════════════════
    //  ВКЛ / ВЫКЛ
    // ══════════════════════════════════════════════════
    async function enable() {
        L.step('включаю помощника…');

        if (!V.cfg || !V.cfg.hasKey) {
            L.err('API-ключ не задан — включать нечего');
            openSettings();
            setState('error', 'нужен API-ключ');
            return;
        }

        const ok = await startMic();
        if (!ok) {
            L.err('не удалось включить: микрофон не открылся');
            return;
        }

        V.enabled = true;
        setState('idle');
        syncMicButton();
        if (!V.cfg.enabled) {
            api.setConfig({ enabled: true }).catch(() => {});
            V.cfg.enabled = true;
        }

        L.ok('помощник включён — микрофон слушает');
        L.step(V.cfg.activationMode === 'always'
            ? 'режим «всегда слушаю» — команды можно говорить без слова-активатора'
            : `скажите «${(V.cfg && V.cfg.wakeWord) || 'киво'}, следующий» либо нажмите ${(V.cfg && V.cfg.hotkey) || 'Ctrl+Alt+Space'}`);
    }

    function disable() {
        const was = V.enabled;
        V.enabled = false;
        V.asrHook = null;
        duckOff();
        stopSpeech();
        stopMic();
        peekHide();
        setState('off');
        syncMicButton();
        if (!V.cfg || V.cfg.enabled) {
            api.setConfig({ enabled: false }).catch(() => {});
            if (V.cfg) V.cfg.enabled = false;
        }
        if (was) L.step('помощник выключен');
    }

    function toggle() {
        if (V.enabled) disable();
        else enable();
    }

    // ══════════════════════════════════════════════════
    //  ГОРЯЧАЯ КЛАВИША (работает без фокуса на окне)
    // ══════════════════════════════════════════════════
    function onHotkey() {
        if (V.ttsAudio) {
            L.step('⌨ горячая клавиша — останавливаю озвучку');
            stopSpeech();
            return;
        }

        L.step('⌨ горячая клавиша — следующая фраза будет командой');

        if (!V.enabled) {
            L.step('помощник был выключен — включаю по хоткею');
            enable().then(() => {
                V.armedUntil = Date.now() + ARM_MS;
                setState('armed', 'слушаю…');
            });
            return;
        }

        V.armedUntil = Date.now() + ARM_MS;
        V.followUpUntil = 0;
        setState('armed', 'слушаю…');
    }

    if (api.onHotkey) api.onHotkey(onHotkey);

    // резерв, если глобальный хоткей занят другой программой
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.altKey && e.code === 'Space') {
            e.preventDefault();
            onHotkey();
        }
    });

    // ══════════════════════════════════════════════════
    //  НАСТРОЙКИ
    // ══════════════════════════════════════════════════
    const CHAT_MODELS = [
        'qwen/qwen3.5-flash:free',
        'qwen/qwen3.7-flash:free',
        'qwen/qwen3-max:free',
        'qwen/qwen-plus-2025-07-28:free',
        'openai/gpt-5.6-sol'
    ];
    const ASR_MODELS = [
        'qwen/qwen3-omni-flash:free',
        'qwen/qwen3.5-omni-flash:free',
        'qwen/qwen3.8-omni-flash:free',
        'qwen/qwen3.5-omni-plus:free'
    ];

    // ── провайдеры распознавания речи ──
    // xKiro не умеет STT: шлюз выбрасывает аудио, модель отвечает отказом.
    const ASR_PROVIDERS = {
        openai: {
            label: 'OpenAI-совместимый (Groq / OpenAI / локальный whisper)',
            base: 'https://api.groq.com/openai/v1',
            baseHint: 'Groq — <code>https://api.groq.com/openai/v1</code> (есть бесплатный лимит).<br>' +
                      'OpenAI — <code>https://api.openai.com/v1</code>. Локальный сервер — свой адрес.',
            models: ['whisper-large-v3', 'whisper-large-v3-turbo', 'whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'],
            lang: true,
            note: null
        },
        dashscope: {
            label: 'Alibaba DashScope (qwen3-asr-flash)',
            base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            baseHint: 'Ключ вида <code>sk-...</code> из консоли DashScope (Model Studio).',
            models: ['qwen3-asr-flash', 'paraformer-realtime-v2', 'paraformer-v2'],
            lang: false,
            note: null
        },
        xkiro: {
            label: 'xKiro — не поддерживает распознавание речи',
            base: '',
            baseHint: '',
            models: ASR_MODELS,
            lang: true,
            note: '<b>xKiro не умеет распознавать речь.</b> Его шлюз выбрасывает аудио из запроса, поэтому ' +
                  'в ответ приходит «Я не могу обрабатывать аудиофайлы в этом запросе». ' +
                  'Выберите провайдера выше — ключ xKiro останется для команд и озвучки.'
        }
    };

    // значения по умолчанию для конкретного провайдера
    const asrPreset = (provider) => ASR_PROVIDERS[provider] || ASR_PROVIDERS.openai;

    function refreshAsrBlock() {
        const provider = $('kv-asr-provider').value;
        const P = asrPreset(provider);
        const remote = provider !== 'xkiro';

        $('kv-asr-remote').style.display = remote ? '' : 'none';
        $('kv-asr-provider-hint').innerHTML = P.baseHint || '';

        // модели под провайдера
        $('kv-asr-models').innerHTML = P.models.map(m => `<option value="${m}">`).join('');
        const cur = $('kv-asr-model').value.trim();
        if (!cur || !P.models.includes(cur)) $('kv-asr-model').value = P.models[0];

        // базовый URL
        const baseEl = $('kv-asr-base');
        baseEl.placeholder = P.base || 'https://api.example.com/v1';
        if (remote && !baseEl.value.trim()) baseEl.value = P.base;

        // язык
        $('kv-asr-lang').parentElement.style.display = P.lang ? '' : 'none';

        // пояснение сверху
        const warn = $('kv-asr-warn');
        if (P.note) {
            warn.className = 'kv-note warn';
            warn.innerHTML = P.note;
            warn.style.display = '';
        } else {
            warn.className = 'kv-note ok';
            warn.innerHTML = 'Ключ STT отдельный от xKiro — так распознавание не зависит от шлюза xKiro. ' +
                             'Если оставить поле пустым, будет использован ключ xKiro (сработает только если он подходит).';
            warn.style.display = '';
        }
    }

    function refreshActivationBlock() {
        const mode = $('kv-activation').value;
        const hint = $('kv-activation-hint');
        const wakeField = $('kv-wake').parentElement;

        if (mode === 'always') {
            hint.innerHTML = 'Микрофон отвечает на любую фразу — слово-активатор не нужно. ' +
                             'Удобно в тихой комнате, но больше ложных срабатываний и запросов к распознаванию.';
            wakeField.style.opacity = '.4';
            $('kv-wake').disabled = true;
        } else {
            hint.innerHTML = 'Микрофон слышит всегда, но реагирует только на «слово, …». ' +
                             'После ответа несколько секунд слушает без слова-активатора — чтобы можно было договорить. ' +
                             'Открытый чат тоже слушает без слова.';
            wakeField.style.opacity = '';
            $('kv-wake').disabled = false;
        }
    }

    function buildSettings() {
        if ($('kivo-voice-modal')) return;

        const modal = document.createElement('div');
        modal.id = 'kivo-voice-modal';
        modal.innerHTML = `
        <div class="kv-panel">
            <h2>Голосовой помощник «Киво»</h2>
            <div class="kv-sub">Откройте чат кнопкой справа внизу. Скажите слово-активатор — или просто
                пишите в чат: контекст общий.</div>

            <div class="kv-check">
                <input type="checkbox" id="kv-enabled">
                <span>Включить помощника</span>
            </div>
            <div class="kv-check">
                <input type="checkbox" id="kv-tts">
                <span>Озвучивать ответы (xKiro TTS)</span>
            </div>

            <div class="kv-sec">Распознавание речи</div>

            <div class="kv-field">
                <label>Провайдер STT</label>
                <select id="kv-asr-provider">
                    <option value="openai">OpenAI-совместимый (Groq / OpenAI / локальный whisper)</option>
                    <option value="dashscope">Alibaba DashScope (qwen3-asr-flash)</option>
                    <option value="xkiro">xKiro — не поддерживает STT</option>
                </select>
                <div class="kv-hint" id="kv-asr-provider-hint"></div>
            </div>

            <div id="kv-asr-remote">
                <div class="kv-field">
                    <label>Base URL</label>
                    <input type="text" id="kv-asr-base" spellcheck="false" autocomplete="off">
                </div>
                <div class="kv-field">
                    <label>API-ключ STT</label>
                    <input type="password" id="kv-asr-key" spellcheck="false" autocomplete="off">
                </div>
            </div>

            <div class="kv-row">
                <div class="kv-field">
                    <label>Модель распознавания</label>
                    <input type="text" id="kv-asr-model" list="kv-asr-models" spellcheck="false" autocomplete="off">
                    <datalist id="kv-asr-models"></datalist>
                </div>
                <div class="kv-field">
                    <label>Язык речи</label>
                    <input type="text" id="kv-asr-lang" placeholder="ru" spellcheck="false" autocomplete="off">
                </div>
            </div>

            <div class="kv-note" id="kv-asr-warn"></div>

            <div class="kv-sec">Команды и озвучка</div>

            <div class="kv-field">
                <label>API-ключ xKiro</label>
                <input type="password" id="kv-key" placeholder="xkr-..." spellcheck="false" autocomplete="off">
                <div class="kv-hint">Нужен для понимания команд и озвучки. Хранится в main-процессе и в рендерер не передаётся.</div>
            </div>

            <div class="kv-row">
                <div class="kv-field">
                    <label>Модель для команд</label>
                    <input type="text" id="kv-chat-model" list="kv-chat-models" spellcheck="false" autocomplete="off">
                    <datalist id="kv-chat-models">${CHAT_MODELS.map(m => `<option value="${m}">`).join('')}</datalist>
                </div>
                <div class="kv-field">
                    <label>Голос</label>
                    <input type="text" id="kv-voice" list="kv-voices" placeholder="female-voice-russian" spellcheck="false" autocomplete="off">
                    <datalist id="kv-voices"></datalist>
                </div>
            </div>

            <div class="kv-sec">Общение</div>

            <div class="kv-check">
                <input type="checkbox" id="kv-chat">
                <span>Общаться на свободные темы, а не только выполнять команды</span>
            </div>

            <div class="kv-row">
                <div class="kv-field">
                    <label>Помнить обменов (вопрос + ответ)</label>
                    <input type="number" id="kv-context" min="0" max="20" step="1">
                    <div class="kv-hint">0 — не помнить контекст. Кнопка ⟲ в шапке чата очищает его вручную.</div>
                </div>
                <div class="kv-field">
                    <label>Слушать после ответа</label>
                    <input type="number" id="kv-followup" min="0" max="30" step="1">
                    <div class="kv-hint">Секунд, в течение которых можно говорить без слова-активатора.</div>
                </div>
            </div>

            <div class="kv-sec">Активация</div>

            <div class="kv-field">
                <label>Когда реагировать</label>
                <select id="kv-activation">
                    <option value="wake">По слову-активатору</option>
                    <option value="always">Всегда слушать (без слова-активатора)</option>
                </select>
                <div class="kv-hint" id="kv-activation-hint"></div>
            </div>

            <div class="kv-row">
                <div class="kv-field">
                    <label>Слово-активатор</label>
                    <input type="text" id="kv-wake" placeholder="киво" spellcheck="false" autocomplete="off">
                </div>
                <div class="kv-field">
                    <label>Горячая клавиша</label>
                    <input type="text" id="kv-hotkey" placeholder="Control+Alt+Space" spellcheck="false" autocomplete="off">
                    <div class="kv-hint">Формат Electron: Control+Alt+Space, CommandOrControl+Shift+K.</div>
                </div>
            </div>

            <div class="kv-field">
                <label>Чувствительность микрофона<span id="kv-sens-val" style="color:#1ed760;margin-left:7px;font-variant-numeric:tabular-nums"></span></label>
                <input type="range" class="kv-range" id="kv-sens" min="4" max="50" step="1">
                <div class="kv-hint">Выше — ловит тихую речь, но и больше ложных срабатываний.</div>
            </div>

            <div class="kv-check">
                <input type="checkbox" id="kv-duck">
                <span>Приглушать музыку после слова-активатора — так лучше слышно команду</span>
            </div>

            <div class="kv-status" id="kv-status"></div>

            <div class="kv-actions">
                <button class="kv-btn test" id="kv-mic-test">Тест микрофона</button>
                <button class="kv-btn test" id="kv-test">Проверить связь</button>
                <button class="kv-btn" id="kv-cancel">Отмена</button>
                <button class="kv-btn primary" id="kv-save">Сохранить</button>
            </div>
        </div>`;
        document.body.appendChild(modal);

        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('open');
        });
        $('kv-cancel').addEventListener('click', () => modal.classList.remove('open'));
        $('kv-sens').addEventListener('input', () => {
            $('kv-sens-val').textContent = (Number($('kv-sens').value) / 1000).toFixed(3);
        });

        // смена провайдера STT — подставляем адрес, модели и предупреждение
        $('kv-asr-provider').addEventListener('change', () => {
            const P = asrPreset($('kv-asr-provider').value);
            $('kv-asr-base').value = P.base || '';
            $('kv-asr-model').value = P.models[0];
            refreshAsrBlock();
        });

        $('kv-activation').addEventListener('change', refreshActivationBlock);

        $('kv-save').addEventListener('click', async () => {
            const provider = $('kv-asr-provider').value;
            const asrKey = $('kv-asr-key').value.trim();

            const patch = {
                apiKey: $('kv-key').value.trim() || undefined,
                chatModel: $('kv-chat-model').value.trim() || undefined,
                asrProvider: provider,
                asrModel: $('kv-asr-model').value.trim() || undefined,
                asrBaseUrl: provider === 'xkiro' ? '' : $('kv-asr-base').value.trim(),
                asrLanguage: $('kv-asr-lang').value.trim(),
                ttsVoice: $('kv-voice').value.trim() || undefined,
                wakeWord: $('kv-wake').value.trim() || undefined,
                hotkey: $('kv-hotkey').value.trim() || undefined,
                vadThreshold: Number($('kv-sens').value) / 1000,
                ttsEnabled: $('kv-tts').checked,
                chatMode: $('kv-chat').checked,
                contextTurns: Math.max(0, Math.min(20, Number($('kv-context').value) || 0)),
                activationMode: $('kv-activation').value,
                followUpSec: Math.max(0, Math.min(30, Number($('kv-followup').value) || 0)),
                duckMusic: $('kv-duck').checked,
                enabled: $('kv-enabled').checked
            };
            // пустое поле ключа STT = не менять сохранённый
            if (asrKey) patch.asrApiKey = asrKey;
            Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);

            V.cfg = await api.setConfig(patch);
            modal.classList.remove('open');

            L.step(`настройки сохранены · STT: ${provider} · модель ${V.cfg.asrModel}` +
                   (provider === 'xkiro' ? ' (⚠ xKiro не умеет распознавать речь)' : ''));

            const wantOn = $('kv-enabled').checked;
            if (wantOn && !V.enabled) await enable();
            else if (!wantOn && V.enabled) disable();
            else if (V.enabled) { stopMic(); await startMic(); }   // применить новую чувствительность

            showCaption('настройки сохранены');
        });

        $('kv-mic-test').addEventListener('click', async () => {
            const st = $('kv-status');
            st.className = 'kv-status';

            const provider = $('kv-asr-provider').value;
            const typedKey = $('kv-key').value.trim();
            const typedAsrKey = $('kv-asr-key').value.trim();

            // временно сохраняем введённые ключи, чтобы тест шёл с ними
            if (typedKey) V.cfg = await api.setConfig({ apiKey: typedKey });
            if (typedAsrKey) V.cfg = await api.setConfig({ asrApiKey: typedAsrKey });

            if (provider === 'xkiro') {
                st.className = 'kv-status bad';
                st.textContent = 'xKiro не умеет распознавать речь — выберите другого провайдера выше';
                return;
            }
            if (!V.cfg || !(V.cfg.hasAsrKey || V.cfg.hasKey)) {
                st.className = 'kv-status bad';
                st.textContent = 'укажите API-ключ STT';
                return;
            }

            if (!V.enabled) await enable();
            if (!V.enabled) {
                st.className = 'kv-status bad';
                st.textContent = 'микрофон недоступен';
                return;
            }

            st.textContent = `говорите: «${(V.cfg.wakeWord || 'киво')}, следующий»… · провайдер ${provider}`;
            let done = false;

            V.asrHook = (res) => {
                done = true;
                V.asrHook = null;
                if (res && res.ok) {
                    st.className = 'kv-status ok';
                    st.textContent = 'услышал: «' + res.text + '»  ·  ' + (res.provider || res.strategy);
                } else {
                    st.className = 'kv-status bad';
                    const tried = (res && res.tried || []).map(t => t.strategy).join(' → ');
                    st.textContent = 'распознавание не сработало: ' + ((res && res.error) || '?') +
                                     (tried ? '  [' + tried + ']' : '');
                }
                return true;
            };

            setTimeout(() => {
                if (done) return;
                V.asrHook = null;
                st.className = 'kv-status bad';
                st.textContent = 'ничего не услышал — проверьте микрофон и чувствительность';
            }, 12000);
        });

        $('kv-test').addEventListener('click', async () => {
            const st = $('kv-status');
            st.className = 'kv-status';
            st.textContent = 'проверяю…';

            // если ключ ввели только что — сохраняем временно
            const typedKey = $('kv-key').value.trim();
            if (typedKey) V.cfg = await api.setConfig({ apiKey: typedKey });
            const typedAsrKey = $('kv-asr-key').value.trim();
            if (typedAsrKey) V.cfg = await api.setConfig({ asrApiKey: typedAsrKey });

            const provider = $('kv-asr-provider').value;
            const parts = [];

            const ping = await api.ping();
            parts.push(ping.ok
                ? 'xKiro ✓'
                : 'xKiro ✕ ' + (ping.error || ('HTTP ' + ping.status)));

            if (provider === 'xkiro') {
                parts.push('STT: не поддерживается');
            } else {
                const base = $('kv-asr-base').value.trim() || asrPreset(provider).base;
                parts.push('STT: ' + provider + ' → ' + base);
            }

            st.className = (ping.ok && provider !== 'xkiro') ? 'kv-status ok' : 'kv-status bad';
            st.textContent = parts.join('  ·  ');
        });
    }

    async function openSettings() {
        buildSettings();
        const modal = $('kivo-voice-modal');

        // всегда показываем актуальный конфиг из main, а не кэш рендерера
        try { V.cfg = await api.getConfig(); } catch (_) {}
        const cfg = V.cfg || {};

        $('kv-enabled').checked = !!V.enabled;
        $('kv-tts').checked = cfg.ttsEnabled !== false;
        $('kv-key').value = '';
        $('kv-key').placeholder = cfg.hasKey ? ('сохранён ••••' + cfg.keyTail) : 'xkr-...';
        $('kv-chat').checked = cfg.chatMode !== false;
        $('kv-context').value = String(cfg.contextTurns != null ? cfg.contextTurns : 6);
        $('kv-activation').value = cfg.activationMode === 'always' ? 'always' : 'wake';
        $('kv-followup').value = String(cfg.followUpSec != null ? cfg.followUpSec : 5);
        $('kv-duck').checked = cfg.duckMusic !== false;
        refreshActivationBlock();
        $('kv-chat-model').value = cfg.chatModel || CHAT_MODELS[0];
        $('kv-voice').value = cfg.ttsVoice || 'female-voice-russian';
        $('kv-wake').value = cfg.wakeWord || 'киво';
        $('kv-hotkey').value = cfg.hotkey || 'Control+Alt+Space';

        // ── блок распознавания речи ──
        const provider = ASR_PROVIDERS[cfg.asrProvider] ? cfg.asrProvider : 'openai';
        const P = asrPreset(provider);
        $('kv-asr-provider').value = provider;
        $('kv-asr-model').value = '';
        $('kv-asr-base').value = '';
        refreshAsrBlock();                                    // подставит дефолты провайдера
        if (cfg.asrModel) $('kv-asr-model').value = cfg.asrModel;
        if (cfg.asrBaseUrl) $('kv-asr-base').value = cfg.asrBaseUrl;
        $('kv-asr-lang').value = cfg.asrLanguage || 'ru';
        $('kv-asr-key').value = '';
        $('kv-asr-key').placeholder = cfg.hasAsrKey
            ? ('сохранён ••••' + cfg.asrKeyTail)
            : (provider === 'openai' ? 'gsk_... / sk-...' : 'sk-...');

        const sens = Math.round((Number(cfg.vadThreshold) || 0.012) * 1000);
        $('kv-sens').value = String(sens);
        $('kv-sens-val').textContent = (sens / 1000).toFixed(3);

        $('kv-status').className = 'kv-status';
        if (provider === 'xkiro') {
            $('kv-status').className = 'kv-status bad';
            $('kv-status').textContent = 'распознавание не работает: xKiro не умеет STT — выберите провайдера';
        } else if (!cfg.hasAsrKey && !cfg.hasKey) {
            $('kv-status').textContent = 'ключ STT ещё не задан';
        } else {
            $('kv-status').textContent = '';
        }

        modal.classList.add('open');

        // подтягиваем список голосов
        try {
            const res = await api.voices();
            if (res && res.ok && res.voices && res.voices.length) {
                const dl = $('kv-voices');
                dl.innerHTML = res.voices
                    .slice(0, 60)
                    .map(v => `<option value="${v.id}">${v.name || ''}</option>`)
                    .join('');
            }
        } catch (_) {}
    }

    // ══════════════════════════════════════════════════
    //  СТАРТ
    // ══════════════════════════════════════════════════
    async function boot() {
        injectStyles();
        buildHud();
        watchVolume();          // следим за громкостью, чтобы приглушение не сбило её
        L.step('запуск помощника…');

        try {
            V.cfg = await api.getConfig();
        } catch (e) {
            L.err('не удалось прочитать конфиг из main-процесса:', (e && e.message) || e);
            L.warn('похоже, запущена старая версия main.js — перезапустите плеер');
            return;
        }

        L.step('конфиг:', {
            ключ: V.cfg.hasKey ? 'есть (••••' + V.cfg.keyTail + ')' : 'НЕ ЗАДАН',
            'провайдер STT': V.cfg.asrProvider + (V.cfg.asrProvider === 'xkiro' ? ' ⚠ (не умеет распознавать речь)' : ''),
            'адрес STT': V.cfg.asrBaseUrl || '(по умолчанию)',
            'ключ STT': V.cfg.hasAsrKey ? 'есть (••••' + V.cfg.asrKeyTail + ')' : 'свой не задан',
            'модель команд': V.cfg.chatModel,
            'модель ASR': V.cfg.asrModel,
            'язык ASR': V.cfg.asrLanguage,
            голос: V.cfg.ttsVoice,
            'слово-активатор': V.cfg.wakeWord,
            'горячая клавиша': V.cfg.hotkey,
            'порог VAD': V.cfg.vadThreshold,
            озвучка: V.cfg.ttsEnabled ? 'вкл' : 'выкл',
            активация: V.cfg.activationMode === 'always' ? 'всегда слушаю' : ('по слову «' + V.cfg.wakeWord + '»'),
            'окно после ответа': (V.cfg.followUpSec != null ? V.cfg.followUpSec : 5) + ' с',
            'разговорный режим': V.cfg.chatMode === false ? 'выкл' : 'вкл',
            'контекст': (V.cfg.contextTurns != null ? V.cfg.contextTurns : 6) + ' реплик',
            'был включён': V.cfg.enabled ? 'да' : 'нет'
        });

        // плейсхолдер в чате — с настоящим словом-активатором
        const chatInput = $('kv-chat-input');
        if (chatInput) {
            chatInput.placeholder = V.cfg.activationMode === 'always'
                ? 'Напишите сообщение или просто говорите'
                : `Напишите или скажите «${V.cfg.wakeWord || 'Киво'}…»`;
        }
        syncMicButton();
        setState(V.enabled ? 'idle' : 'off');

        if (V.cfg.asrProvider === 'xkiro') {
            L.warn('xKiro не поддерживает распознавание речи — ASR будет отвечать отказом.');
            L.warn('откройте шестерёнку в шапке чата → «Распознавание речи» и выберите провайдера (Groq / OpenAI / DashScope).');
        }

        if (!V.cfg.hasKey) {
            L.warn('API-ключ не задан — помощник не сможет ни слушать, ни отвечать');
            L.warn('откройте шестерёнку в шапке чата «Киво» (справа внизу) и вставьте ключ xKiro');
        }

        if (V.cfg.enabled && V.cfg.hasKey) {
            L.step('автозапуск: включаю микрофон…');
            await enable();
        } else {
            setState('off');
            if (!V.cfg.hasKey) {
                V.hud.title = 'Киво — откройте чат и укажите API-ключ';
            }
        }

        L.step('подсказки: KivoVoice.diagnostics() — статус, KivoVoice.setDebug(true) — покадровая телеметрия');
    }

    // ══════════════════════════════════════════════════
    //  ДИАГНОСТИКА
    // ══════════════════════════════════════════════════
    function setDebug(on) {
        DEBUG = !!on;
        try { localStorage.setItem('kivo.voice.debug', DEBUG ? '1' : '0'); } catch (_) {}
        L.step('подробный лог ' + (DEBUG ? 'ВКЛ' : 'выкл'));
        return DEBUG;
    }

    function diagnostics() {
        const cfg = V.cfg || {};
        const left = (t) => (t > Date.now() ? Math.round((t - Date.now()) / 1000) + ' с' : '—');
        const report = {
            'включён': V.enabled,
            'состояние': V.state,
            'микрофон': V.ready ? 'готов' : 'нет',
            'аудиоконтекст': V.ctx ? V.ctx.state : '—',
            'частота': V.ctx ? V.ctx.sampleRate + ' Гц' : '—',
            'кадров получено': V.frames,
            'уровень RMS': Number(V.lastLevel.toFixed(4)),
            'шумовой пол': Number(V.noise.toFixed(4)),
            'порог VAD': Number(cfg.vadThreshold || 0),
            'занят обработкой': V.busy,
            'фраз обработано': V.cycles,
            'команд выполнено': V.commands,
            'разговоров': V.chats,
            'контекст диалога': V.history.length ? (V.history.length + ' реплик') : 'пуст',
            'контекст свежий': V.historyAt ? Math.round((Date.now() - V.historyAt) / 1000) + ' с назад' : '—',
            'разговорный режим': cfg.chatMode === false ? 'выкл' : 'вкл',
            'ошибок': V.errors,
            'распознаваний за минуту': V.asrTimes.length,
            'пауза до': V.cooldownUntil > Date.now() ? new Date(V.cooldownUntil).toLocaleTimeString('ru-RU') : '—',
            'окно follow-up': left(V.followUpUntil),
            'окно хоткея': left(V.armedUntil),
            'активация': cfg.activationMode === 'always' ? 'всегда слушаю' : 'по слову',
            'чат открыт': V.chatOpen,
            'сообщений в чате': V.chatBody ? V.chatBody.children.length : 0,
            'ключ': cfg.hasKey ? 'есть' : 'НЕТ',
            'модель команд': cfg.chatModel || '—',
            'модель ASR': cfg.asrModel || '—',
            'рабочая стратегия ASR': V.lastStrategy || 'ещё не определена',
            'последняя фраза': V.lastTranscript || '—'
        };
        L.step('диагностика:');
        console.table(report);
        return report;
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(boot, 400);
    } else {
        window.addEventListener('DOMContentLoaded', () => setTimeout(boot, 400));
    }

    // для отладки из консоли
    window.KivoVoice = {
        enable, disable, toggle, openSettings,
        diagnostics, setDebug,
        resetContext,
        openChat: () => setChatOpen(true),
        closeChat: () => setChatOpen(false),
        toggleChat,
        send: submitText,
        history: () => V.history.slice(),
        messages: () => (V.chatBody ? [...V.chatBody.children].map(n => ({ role: n.className.replace('kv-msg ', ''), text: n.textContent })) : []),
        ask: async (text) => {
            const intent = await parseIntent(text);
            return { intent, context: playerContext() };
        },
        state: V,
        _internals: {
            stripWake, localIntent, parseIntent, execute, encodeWav, normText,
            speak, setVolume, searchAndPlay, onAudio, startMic, stopMic, enable, disable,
            playerContext, systemPrompt, pushHistory, historyForLLM, cleanSpeech,
            handleUtterance, runText, submitText, addMessage, followUpMs, setChatOpen,
            library, libSummary, resolveArtist, playMusic, playOther, trackLabel,
            libGenres, resolveGenre, playByGenre, genresText, genreSummary, currentGenreText,
            peekShow, peekHide, peekWidth, isAddressed, duckOn, duckOff
        }
    };
})();
