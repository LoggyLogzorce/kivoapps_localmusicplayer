// ══════════════════════════════════════════════════════
//  WAVE MODE
// ══════════════════════════════════════════════════════
const waveBtn = document.getElementById('wave-btn');
let waveMode = false;

// полноэкранный вид «Очередь и история» — открывается кнопкой, по умолчанию закрыт
let waveViewOpen = false;
let lyricsBeforeQueueView = false;   // вернуть режим текста после закрытия панели

const queueBtn = document.getElementById('queue-btn');
const queueBadge = document.getElementById('queue-badge');
const waveViewClose = document.getElementById('wave-view-close');

let waveViewTimers = [];

function clearWaveViewTimers() {
    waveViewTimers.forEach(clearTimeout);
    waveViewTimers = [];
}

function setWaveViewOpen(open) {
    if (open && !waveMode) return;          // очередь и история живут только в волне
    if (open === waveViewOpen) return;      // уже в нужном состоянии

    const body = document.body;
    clearWaveViewTimers();

    waveViewOpen = open;
    if (queueBtn) queueBtn.classList.toggle('active', open);

    if (open) {
        body.classList.remove('wave-view-closing', 'wave-view-settling');
        body.classList.add('wave-view-open', 'wave-view-opening');
        waveViewTimers.push(setTimeout(() => body.classList.remove('wave-view-opening'), 760));

        // панель занимает пол-экрана — режим текста на время прячем
        lyricsBeforeQueueView = (typeof lyricsMode !== 'undefined') && lyricsMode;
        if (lyricsBeforeQueueView) {
            lyricsMode = false;
            body.classList.remove('lyrics-mode');
        }
        renderWavePanel();
    } else {
        // сначала даём панели уехать, и только потом возвращаем раскладку
        body.classList.remove('wave-view-opening');
        body.classList.add('wave-view-closing');

        waveViewTimers.push(setTimeout(() => {
            body.classList.remove('wave-view-open', 'wave-view-closing');
            body.classList.add('wave-view-settling');
            waveViewTimers.push(setTimeout(() => body.classList.remove('wave-view-settling'), 420));

            if (lyricsBeforeQueueView) {
                lyricsBeforeQueueView = false;
                lyricsMode = true;
                currentFPS = 30;
                body.classList.add('lyrics-mode');
                setTimeout(() => {
                    if (typeof scrollToCurrentLyric === 'function') scrollToCurrentLyric();
                }, 550);
            }
            if (typeof renderPlaylist === 'function') {
                renderPlaylist();           // сайдбар вернулся — пересчёт виртуализации
            }
        }, 230));
    }
}

if (queueBtn) queueBtn.addEventListener('click', () => setWaveViewOpen(!waveViewOpen));
if (waveViewClose) waveViewClose.addEventListener('click', () => setWaveViewOpen(false));

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && waveViewOpen) setWaveViewOpen(false);
});

waveBtn.addEventListener('click', async () => {
    waveMode = !waveMode;
    waveBtn.classList.toggle('active', waveMode);
    document.body.classList.toggle('wave-mode', waveMode);

    // ── Анимация ──
    playWaveFx(waveBtn, !waveMode);   // при выключении свип едет в обратную сторону

    // ── Лёгкий "kick" по визуализатору ──
    if (waveMode && typeof visualizerEnergy !== 'undefined') {
        visualizerEnergy = Math.min(1, visualizerEnergy + 0.6);
    }

    // ── Показ/скрытие кнопок голосования (с задержкой под анимацию) ──
    if (waveMode) {
        setTimeout(() => {
            btnFavorite.style.display = 'flex';
            btnDislike.style.display  = 'flex';
            btnFavorite.classList.add('reveal');
            btnDislike.classList.add('reveal');
        }, 180);
    } else {
        btnFavorite.classList.remove('reveal');
        btnDislike.classList.remove('reveal');
        // даём кнопкам плавно уйти, и только потом убираем из раскладки
        setTimeout(() => {
            if (!waveMode) {
                btnFavorite.style.display = 'none';
                btnDislike.style.display  = 'none';
            }
        }, 380);
    }

    // ── Логика движка ──
    if (waveMode) {
        // полноэкранный вид не совместим с режимом текста
        if (typeof lyricsMode !== 'undefined' && lyricsMode) {
            lyricsMode = false;
            document.body.classList.remove('lyrics-mode');
        }
        await RecoEngine.init();
        const cur = currentTrackGlobalIndex !== -1 ? tracks[currentTrackGlobalIndex] : null;
        RecoEngine.start(cur);
        RecoEngine.preloadAll();
        renderWavePanel();
    } else {
        RecoEngine.stopPreload();
        RecoEngine.queue = [];
        voteState = 0;
        renderVote();
        if (waveViewOpen) setWaveViewOpen(false);
    }
});

// ══════════════════════════════════════════════════════
//  RECOMMENDATION ENGINE (Wave mode)
// ══════════════════════════════════════════════════════
const QUEUE_SIZE = 5;              // сколько треков держим "впереди"
const FEATURES_VERSION = 1;
const RECO_HISTORY = 12;           // сколько последних треков не повторять
const RECO_COOLDOWN_MS = 2 * 60 * 60 * 1000;    // 2 часа
const POOL_SIZE = 15;
const HISTORY_MAX = 100;           // сколько треков помним в истории
const HISTORY_UI_MAX = 40;         // сколько строк истории рисуем

// живёт, пока открыта вкладка
const sessionPlayed = new Set();

const RecoEngine = {
    db: null,
    stats: new Map(),           // key -> { playCount, totalListened, avgCompletion, vote, skipCount, lastPlayed }
    features: new Map(),        // key -> { bpm, energy, zcr, dynamics, duration, v }
    queue: [],                  // ТОЛЬКО предстоящие треки (<= QUEUE_SIZE)
    history: [],                // прослушанное, в порядке воспроизведения
    historyIndex: -1,           // позиция текущего трека в history
    current: null,              // текущий файл
    featuresPending: new Set(),
    _preloading: false,

    key(file) {
        return `${file.name}|${file.size}`;
    },

    isSame(a, b) {
        return !!a && !!b && this.key(a) === this.key(b);
    },

    isPlayable(file) {
        return !!file && tracks.indexOf(file) !== -1;
    },

    async init() {
        if (this.db) return;
        this.db = await openDB();
        await this._loadAll();
    },

    _loadAll() {
        return new Promise((resolve) => {
            const tx = this.db.transaction(RECO_STORE, 'readonly');
            const req = tx.objectStore(RECO_STORE).openCursor();
            req.onsuccess = (e) => {
                const cur = e.target.result;
                if (!cur) return resolve();
                const v = cur.value || {};
                if (v.features) this.features.set(cur.key, v.features);
                if (v.stats)    this.stats.set(cur.key, v.stats);
                cur.continue();
            };
            req.onerror = () => resolve();
        });
    },

    _persist(key) {
        if (!this.db) return;
        const payload = {
            features: this.features.get(key) || null,
            stats:    this.stats.get(key)    || null,
        };
        try {
            const tx = this.db.transaction(RECO_STORE, 'readwrite');
            tx.objectStore(RECO_STORE).put(payload, key);
        } catch (e) { /* ignore */ }
    },

    defaultStats() {
        return { playCount: 0, totalListened: 0, avgCompletion: 0, vote: 0, skipCount: 0, lastPlayed: 0 };
    },

    // ─── Feature extraction (кэш + отложенно) ──────────
    async ensureFeatures(file) {
        const k = this.key(file);
        if (this.features.has(k)) return this.features.get(k);
        if (this.featuresPending.has(k)) return null;
        this.featuresPending.add(k);
        try {
            const feat = await extractAudioFeatures(file);
            if (feat) {
                this.features.set(k, feat);
                this._persist(k);
                return feat;
            }
        } catch (e) {
            console.warn('[Reco] extract failed:', file.name, e);
        } finally {
            this.featuresPending.delete(k);
        }
        return null;
    },

    async preloadAll() {
        this._preloading = true;
        for (const track of tracks) {
            if (!this._preloading) break;
            if (this.features.has(this.key(track))) continue;
            await this.ensureFeatures(track);
            await new Promise(r => setTimeout(r, 30));   // дать UI подышать
        }
        this._preloading = false;
    },
    stopPreload() { this._preloading = false; },

    // ─── Similarity / Preference ────────────────────────
    similarity(a, b) {
        if (!a || !b) return 0.5;
        const dBpm    = Math.abs((a.bpm || 0) - (b.bpm || 0)) / 60;
        const dEnergy = Math.abs(a.energy - b.energy) / 0.25;
        const dZcr    = Math.abs(a.zcr - b.zcr) / 0.12;
        const dDyn    = Math.abs(a.dynamics - b.dynamics) / 0.08;
        const dist = Math.sqrt(dBpm ** 2 + dEnergy ** 2 + dZcr ** 2 + dDyn ** 2) / 2;
        return Math.max(0, 1 - dist);
    },

    preferenceScore(stat) {
        if (!stat) return 0;
        let p = 0;
        p += stat.vote === 1 ? 0.8 : 0;
        p -= stat.vote === -1 ? 1.5 : 0;
        p += Math.min(stat.playCount * 0.08, 0.4);
        if (stat.avgCompletion > 0) p += (stat.avgCompletion - 0.5) * 0.6;
        p -= Math.min(stat.skipCount * 0.25, 0.8);
        return Math.max(-1.5, Math.min(1.5, p));
    },

    // ═══════════════════════════════════════════════════
    //  QUEUE (append-only)
    // ═══════════════════════════════════════════════════

    // Собираем пул кандидатов с заданной строгостью фильтров
    _collectCandidates(seedFile, opts) {
        const seedFeat = seedFile ? this.features.get(this.key(seedFile)) : null;
        const now = Date.now();
        const queueKeys = new Set(this.queue.map(t => this.key(t)));
        const curKey = seedFile ? this.key(seedFile) : null;
        const playingKey = this.current ? this.key(this.current) : null;
        const recent = opts.recent > 0
            ? new Set(this.history.slice(-opts.recent).map(t => this.key(t)))
            : new Set();

        const out = [];
        for (const track of tracks) {
            const k = this.key(track);
            if (k === curKey) continue;              // не сам сид
            if (k === playingKey) continue;          // не то, что играет прямо сейчас
            if (queueKeys.has(k)) continue;          // уже стоит в очереди
            if (recent.has(k)) continue;             // только что играл

            const stat = this.stats.get(k);
            if (!opts.disliked && stat && stat.vote === -1) continue;
            if (opts.cooldown && stat && stat.lastPlayed
                && (now - stat.lastPlayed) < RECO_COOLDOWN_MS) continue;

            const sim = this.similarity(seedFeat, this.features.get(k));
            const pref = this.preferenceScore(stat);
            const novelty = stat ? Math.max(0, 1 - stat.playCount * 0.15) : 1;
            // уже игравшее в этой сессии — не запрет, но пониженный приоритет
            const freshness = sessionPlayed.has(k) ? 0.6 : 1;

            const score = (0.55 * sim + 0.30 * pref + 0.15 * novelty) * freshness;
            out.push({ track, score });
        }
        return out;
    },

    _pickCandidate(seedFile) {
        // Пробуем всё строже → мягче, чтобы не останавливаться на маленьких библиотеках
        const attempts = [
            { cooldown: true,  recent: RECO_HISTORY,        disliked: false },
            { cooldown: false, recent: Math.min(4, RECO_HISTORY), disliked: false },
            { cooldown: false, recent: 0,                   disliked: false },
            { cooldown: false, recent: 0,                   disliked: true  },
        ];

        for (const opts of attempts) {
            const pool = this._collectCandidates(seedFile, opts);
            if (!pool.length) continue;

            pool.sort((a, b) => b.score - a.score);
            const top = pool.slice(0, POOL_SIZE);
            const weights = top.map(c => Math.max(0.05, c.score + 0.5));
            return top[weightedPick(weights)].track;
        }
        return null;
    },

    // Добираем очередь ДО пяти треков, не трогая уже стоящие в ней
    refillQueue(seedFile) {
        if (!tracks.length) { this.emit(); return; }
        let seed = seedFile || this.current || null;
        let guard = 0;

        while (this.queue.length < QUEUE_SIZE && guard++ < QUEUE_SIZE * 4) {
            const pick = this._pickCandidate(seed);
            if (!pick) break;
            this.queue.push(pick);
            seed = pick;            // следующий трек подбираем от предыдущего — плавный переход
        }
        this.emit();
    },

    popNext() {
        if (this.queue.length === 0) this.refillQueue(this.current);

        let next = this.queue.shift() || null;

        // совсем край: библиотека крошечная / всё под фильтрами
        if (!next && tracks.length) {
            const exclude = new Set(this.queue.map(t => this.key(t)));
            if (this.current) exclude.add(this.key(this.current));
            let pool = tracks.filter(t => !exclude.has(this.key(t)));
            if (!pool.length) {
                sessionPlayed.clear();
                pool = this.current ? tracks.filter(t => t !== this.current) : tracks.slice();
            }
            if (pool.length) next = pool[Math.floor(Math.random() * pool.length)];
        }

        this.emit();
        return next;
    },

    // ═══════════════════════════════════════════════════
    //  HISTORY
    // ═══════════════════════════════════════════════════
    _pushHistory(file) {
        // если пользователь вернулся назад и выбрал новый трек — "будущее" отрезаем
        if (this.historyIndex >= 0 && this.historyIndex < this.history.length - 1) {
            this.history.length = this.historyIndex + 1;
        }
        const last = this.history[this.history.length - 1];
        if (!this.isSame(last, file)) {
            this.history.push(file);
            if (this.history.length > HISTORY_MAX) this.history.shift();
        }
        this.historyIndex = this.history.length - 1;
    },

    canGoBack()    { return this.historyIndex > 0; },
    canGoForward() { return this.historyIndex >= 0 && this.historyIndex < this.history.length - 1; },

    goBack() {
        for (let i = this.historyIndex - 1; i >= 0; i--) {
            if (this.isPlayable(this.history[i])) {
                this.historyIndex = i;
                this.current = this.history[i];
                this.emit();
                return this.history[i];
            }
        }
        return null;
    },

    goForward() {
        for (let i = this.historyIndex + 1; i < this.history.length; i++) {
            if (this.isPlayable(this.history[i])) {
                this.historyIndex = i;
                this.current = this.history[i];
                this.emit();
                return this.history[i];
            }
        }
        return null;
    },

    jumpToHistory(index) {
        if (index < 0 || index >= this.history.length) return null;
        const file = this.history[index];
        if (!this.isPlayable(file)) return null;
        this.historyIndex = index;
        this.current = file;
        this.emit();
        return file;
    },

    // ═══════════════════════════════════════════════════
    //  EVENTS
    // ═══════════════════════════════════════════════════

    // Старт волны (включение режима / смена библиотеки)
    start(seedFile) {
        this.queue = [];
        if (seedFile) {
            this.current = seedFile;
            sessionPlayed.add(this.key(seedFile));
            if (!this.isSame(this.history[this.historyIndex], seedFile)) {
                this._pushHistory(seedFile);
            }
        }
        this.refillQueue(seedFile || this.current);
        this.emit();
    },

    reset() {
        this.queue = [];
        this.history = [];
        this.historyIndex = -1;
        this.current = null;
        sessionPlayed.clear();
        this.emit();
    },

    onTrackStarted(file, opts = {}) {
        if (!file) return;
        const k = this.key(file);
        this.current = file;
        sessionPlayed.add(k);

        if (!opts.fromHistory) {
            this._pushHistory(file);
        }

        // трек уже стоял в очереди (клик по списку) — убираем, чтобы не задвоился
        const qi = this.queue.findIndex(t => this.key(t) === k);
        if (qi !== -1) this.queue.splice(qi, 1);

        // главное: очередь не пересобирается, только добивается до QUEUE_SIZE
        this.refillQueue(file);

        // Пре-фетч фич для следующих
        this.ensureFeatures(file);
        for (const next of this.queue.slice(0, 3)) this.ensureFeatures(next);
    },

    onTrackStopped(file, listenedTime, naturalEnd) {
        if (!file) return;
        const k = this.key(file);
        const stat = this.stats.get(k) || this.defaultStats();

        const dur = (isFinite(audio.duration) && audio.duration > 0)
            ? audio.duration
            : (this.features.get(k)?.duration || 1);

        const completion = Math.min(listenedTime / dur, 1.0);

        stat.playCount++;
        stat.totalListened += listenedTime;
        stat.avgCompletion = stat.avgCompletion === 0
            ? completion
            : stat.avgCompletion * 0.7 + completion * 0.3;

        if (!naturalEnd && completion < 0.3) stat.skipCount++;
        stat.lastPlayed = Date.now();

        this.stats.set(k, stat);
        this._persist(k);
    },

    onVote(file, vote) {
        const k = this.key(file);
        const stat = this.stats.get(k) || this.defaultStats();
        stat.vote = vote;
        this.stats.set(k, stat);
        this._persist(k);

        // дизлайк — выкидываем из очереди, если вдруг там оказался; добор без пересборки
        if (vote === -1) {
            this.queue = this.queue.filter(t => this.key(t) !== k);
            if (this.queue.length < QUEUE_SIZE) this.refillQueue(this.current);
        }
        this.emit();
    },

    emit() {
        if (typeof renderWavePanel === 'function') renderWavePanel();
    },
};

// ─── Веса для рулетки ────────────────────────────────
function weightedPick(weights) {
    let sum = 0;
    for (const w of weights) sum += w;
    let r = Math.random() * sum;
    for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r <= 0) return i;
    }
    return weights.length - 1;
}

// ══════════════════════════════════════════════════════
//  WAVE FULLSCREEN UI (очередь + история)
// ══════════════════════════════════════════════════════
function makeWaveRow({ index, file, state = '', onClick }) {
    const row = document.createElement('div');
    row.className = 'wv-row' + (state ? ' is-' + state : '');

    const num = document.createElement('span');
    num.className = 'wv-num';
    num.textContent = String(index).padStart(2, '0');

    const body = document.createElement('div');
    body.className = 'wv-body';

    const title = document.createElement('div');
    title.className = 'wv-title';
    title.textContent = file.parsedTitle || file.name;

    const artist = document.createElement('div');
    artist.className = 'wv-artist';
    artist.textContent = (file.parsedArtists || []).join(', ');

    // жанр — рядом с исполнителем, как в боковом списке
    const genreId = (file.genres || [])[0];
    if (genreId && window.KivoGenres) {
        if (artist.textContent) artist.appendChild(document.createTextNode(' · '));
        const g = document.createElement('span');
        g.className = 'wv-genre';
        g.textContent = window.KivoGenres.label(genreId);
        artist.appendChild(g);
    }

    body.append(title, artist);
    row.append(num, body);

    if (state === 'current') {
        const tag = document.createElement('span');
        tag.className = 'wv-tag';
        tag.textContent = 'сейчас';
        row.appendChild(tag);
    }

    row.title = artist.textContent
        ? `${title.textContent} — ${artist.textContent}`
        : title.textContent;
    row.addEventListener('click', onClick);
    return row;
}

function makeWaveEmpty(text) {
    const el = document.createElement('div');
    el.className = 'wv-empty';
    el.textContent = text;
    return el;
}

function renderWavePanel() {
    if (queueBadge) queueBadge.textContent = String(RecoEngine.queue.length);
    if (!waveMode || !waveViewOpen) return;

    const qList  = document.getElementById('wave-queue-list');
    const hList  = document.getElementById('wave-history-list');
    const qCount = document.getElementById('wave-queue-count');
    const hCount = document.getElementById('wave-history-count');
    const sub    = document.getElementById('wave-view-sub');
    if (!qList || !hList) return;

    qCount.textContent = String(RecoEngine.queue.length);
    hCount.textContent = String(RecoEngine.history.length);
    if (sub) {
        sub.textContent = `${RecoEngine.queue.length} впереди · ${RecoEngine.history.length} в истории`;
    }

    // ── Далее (очередь) ──
    const entering = document.body.classList.contains('wave-view-opening');
    let enterIdx = 0;
    const withDelay = (row) => {
        if (entering) row.style.animationDelay = Math.min(enterIdx++ * 24, 260) + 'ms';
        return row;
    };

    qList.innerHTML = '';
    if (!RecoEngine.queue.length) {
        qList.appendChild(makeWaveEmpty('Очередь пуста — нажми «следующий», чтобы собрать'));
    } else {
        RecoEngine.queue.forEach((file, i) => {
            qList.appendChild(withDelay(makeWaveRow({
                index: i + 1,
                file,
                state: 'next',
                onClick: () => playFromQueue(i),
            })));
        });
    }

    // ── Играли (история, свежие сверху) ──
    hList.innerHTML = '';
    const hist = RecoEngine.history;
    if (!hist.length) {
        hList.appendChild(makeWaveEmpty('Пока ничего не играло'));
    } else {
        const start = Math.max(0, hist.length - HISTORY_UI_MAX);
        for (let i = hist.length - 1; i >= start; i--) {
            const state = i === RecoEngine.historyIndex
                ? 'current'
                : (i > RecoEngine.historyIndex ? 'future' : 'played');
            hList.appendChild(withDelay(makeWaveRow({
                index: i + 1,
                file: hist[i],
                state,
                onClick: () => playFromHistory(i),
            })));
        }
    }

    // текущий трек всегда должен быть в зоне видимости (без микро-скроллов)
    const scroll = document.getElementById('wave-view-scroll');
    const curRow = hList.querySelector('.wv-row.is-current');
    if (scroll && curRow) {
        const r = curRow.getBoundingClientRect();
        const c = scroll.getBoundingClientRect();
        if (r.top < c.top - 40 || r.bottom > c.bottom + 40) {
            curRow.scrollIntoView({ block: 'nearest' });
        }
    }
}

// Клик по треку в очереди: он играет, а всё что было выше — пропускаем
function playFromQueue(index) {
    const file = RecoEngine.queue[index];
    if (!file) return;
    RecoEngine.queue.splice(0, index + 1);
    RecoEngine.emit();
    playTrack(file);
}

// Клик по истории: возврат к тому, что уже играло
function playFromHistory(index) {
    const file = RecoEngine.jumpToHistory(index);
    if (file) playTrack(file, { fromHistory: true });
}

// ─── Извлечение фич из аудио ─────────────────────────
async function extractAudioFeatures(file) {
    const arrayBuffer = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let buffer;
    try {
        buffer = await ctx.decodeAudioData(arrayBuffer);
    } finally {
        ctx.close();
    }

    const sr = buffer.sampleRate;
    const duration = buffer.duration;
    const chData = buffer.getChannelData(0);

    // Берём окно 30 сек из середины трека
    const winLen = Math.min(30, duration);
    const start = Math.floor((duration - winLen) / 2 * sr);
    const slice = chData.subarray(start, start + Math.floor(winLen * sr));

    // ── RMS ──
    let sumSq = 0;
    for (let i = 0; i < slice.length; i++) sumSq += slice[i] * slice[i];
    const rms = Math.sqrt(sumSq / slice.length);

    // ── ZCR ──
    let zc = 0;
    for (let i = 1; i < slice.length; i++) {
        if ((slice[i] >= 0) !== (slice[i - 1] >= 0)) zc++;
    }
    const zcr = zc / slice.length;

    // ── Огибающая (10 мс окна) ──
    const frameSize = Math.max(1, Math.floor(sr * 0.01));
    const nFrames = Math.floor(slice.length / frameSize);
    const env = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
        let e = 0;
        const base = f * frameSize;
        for (let i = 0; i < frameSize; i++) e += Math.abs(slice[base + i]);
        env[f] = e / frameSize;
    }

    // ── Dynamics ──
    let mean = 0;
    for (let i = 0; i < nFrames; i++) mean += env[i];
    mean /= nFrames;
    let varc = 0;
    for (let i = 0; i < nFrames; i++) varc += (env[i] - mean) ** 2;
    varc /= nFrames;
    const dynamics = Math.sqrt(varc);

    // ── BPM ──
    const sm = new Float32Array(nFrames);
    const win = 2;
    for (let i = 0; i < nFrames; i++) {
        let s = 0, c = 0;
        for (let k = -win; k <= win; k++) {
            const j = i + k;
            if (j >= 0 && j < nFrames) { s += env[j]; c++; }
        }
        sm[i] = s / c;
    }
    const peaks = [];
    const thresh = mean * 1.1;
    for (let i = 1; i < nFrames - 1; i++) {
        if (sm[i] > sm[i - 1] && sm[i] > sm[i + 1] && sm[i] > thresh) {
            if (peaks.length === 0 || (i - peaks[peaks.length - 1]) > 5) peaks.push(i);
        }
    }
    const bpms = [];
    for (let i = 1; i < peaks.length; i++) {
        const dt = (peaks[i] - peaks[i - 1]) * 0.01;
        if (dt > 0.25 && dt < 1.5) {
            let bpm = 60 / dt;
            while (bpm < 60) bpm *= 2;
            while (bpm > 180) bpm /= 2;
            bpms.push(bpm);
        }
    }
    let bpm = 0;
    if (bpms.length > 0) {
        const bins = {};
        for (const b of bpms) {
            const bin = Math.floor(b / 5) * 5;
            bins[bin] = (bins[bin] || 0) + 1;
        }
        let bestBin = 0, bestCount = 0;
        for (const [bin, count] of Object.entries(bins)) {
            if (count > bestCount) { bestCount = count; bestBin = Number(bin); }
        }
        bpm = bestBin + 2.5;
    }

    return { v: FEATURES_VERSION, bpm, energy: rms, zcr, dynamics, duration };
}

// ══════════════════════════════════════════════════════
//  WAVE MODE ANIMATION
// ══════════════════════════════════════════════════════
const waveFx = document.getElementById('wave-fx');

function playWaveFx(fromButton, reverse = false) {
    // 1. Пульс самой кнопки
    if (fromButton) {
        fromButton.classList.remove('wave-pulse');
        void fromButton.offsetWidth;    // форс reflow для перезапуска анимации
        fromButton.classList.add('wave-pulse');
        setTimeout(() => fromButton.classList.remove('wave-pulse'), 700);
    }

    // 2. Горизонтальный свип
    const sweep = document.createElement('div');
    sweep.id = 'wave-sweep';
    if (reverse) sweep.classList.add('reverse');
    waveFx.appendChild(sweep);
    sweep.addEventListener('animationend', () => sweep.remove(), { once: true });

    // 3. Три волновых круга из центра кнопки
    const rect = fromButton ? fromButton.getBoundingClientRect() : null;
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;

    // радиус = расстояние до самого дальнего угла экрана
    const maxR = Math.hypot(
        Math.max(cx, window.innerWidth - cx),
        Math.max(cy, window.innerHeight - cy)
    ) * 2;

    [0, 120, 240].forEach((delay, i) => {
        const ripple = document.createElement('div');
        ripple.className = 'wave-ripple';
        ripple.style.left = cx + 'px';
        ripple.style.top = cy + 'px';
        ripple.style.width = maxR + 'px';
        ripple.style.height = maxR + 'px';
        ripple.style.animationDelay = delay + 'ms';
        // чуть разная толщина и прозрачность — объёмнее
        ripple.style.borderWidth = (i === 0 ? 3 : 2) + 'px';
        ripple.style.borderColor = i === 0
            ? 'var(--brand-color)'
            : 'rgba(30,215,96,0.45)';
        waveFx.appendChild(ripple);
        ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    });
}
