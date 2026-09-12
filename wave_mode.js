// ══════════════════════════════════════════════════════
//  WAVE MODE
// ══════════════════════════════════════════════════════
const waveBtn = document.getElementById('wave-btn');
let waveMode = false;

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
        btnFavorite.style.display = 'none';
        btnDislike.style.display  = 'none';
        btnFavorite.classList.remove('reveal');
        btnDislike.classList.remove('reveal');
    }

    // ── Логика движка ──
    if (waveMode) {
        await RecoEngine.init();
        if (currentTrackGlobalIndex !== -1) {
            RecoEngine.onTrackStarted(tracks[currentTrackGlobalIndex]);
        }
        RecoEngine.preloadAll();
    } else {
        RecoEngine.stopPreload();
        RecoEngine.queue = [];
        RecoEngine.recentKeys = [];
        voteState = 0;
        renderVote();
    }
});

// ══════════════════════════════════════════════════════
//  RECOMMENDATION ENGINE (Wave mode)
// ══════════════════════════════════════════════════════
const QUEUE_SIZE = 5;
const FEATURES_VERSION = 1;
const RECO_HISTORY = 12;   // сколько последних треков не повторять
const RECO_COOLDOWN_MS = 2 * 60 * 60 * 1000;    // 2 часа
const POOL_SIZE = 15

// живёт, пока открыта вкладка
const sessionPlayed = new Set();

const RecoEngine = {
    db: null,
    stats: new Map(),           // key -> { playCount, totalListened, avgCompletion, vote, skipCount, lastPlayed }
    features: new Map(),        // key -> { bpm, energy, zcr, dynamics, duration, v }
    queue: [],
    recentKeys: [],
    featuresPending: new Set(),
    _preloading: false,

    key(file) {
        return `${file.name}|${file.size}`;
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

    // ─── Queue ──────────────────────────────────────────
    buildQueue(seedFile) {
        const seedFeat  = this.features.get(this.key(seedFile));
        const recent    = new Set(this.recentKeys);
        const now       = Date.now();
        const candidates = [];

        for (const track of tracks) {
            if (track === seedFile) continue;

            const k = this.key(track);
            const stat = this.stats.get(k);

            // 1. явный дизлайк — никогда
            if (stat && stat.vote === -1) continue;

            // 2. последние N треков подряд (A→B→A→B)
            if (recent.has(k)) continue;

            // 3. играл в этой сессии
            if (sessionPlayed.has(k)) continue;

            // 4. карантин 2 часа
            if (stat && stat.lastPlayed && (now - stat.lastPlayed) < RECO_COOLDOWN_MS) continue;

            const feat = this.features.get(k);
            const sim = this.similarity(seedFeat, feat);
            const pref = this.preferenceScore(stat);
            const novelty = stat ? Math.max(0, 1 - stat.playCount * 0.15) : 1;

            const score = 0.55 * sim + 0.30 * pref + 0.15 * novelty;
            candidates.push({ track, score });
        }

        candidates.sort((a, b) => b.score - a.score);
        const pool = candidates.slice(0, POOL_SIZE);

        const queue = [];
        while (queue.length < QUEUE_SIZE && pool.length > 0) {
            const weights = pool.map(c => Math.max(0.05, c.score + 0.5));
            const idx = weightedPick(weights);
            queue.push(pool[idx].track);
            pool.splice(idx, 1);
        }

        this.queue = queue;
        console.log('[Reco] queue:', queue.map(f => f.parsedTitle));
    },

    popNext() {
        if (this.queue.length === 0) {
            const seed = currentTrackGlobalIndex !== -1 ? tracks[currentTrackGlobalIndex] : null;

            // Пробуем собрать очередь от текущего трека
            if (seed) this.buildQueue(seed);

            // Всё ещё пусто (маленькая библиотека / всё под карантином)?
            // Берём что угодно, кроме сида и уже игравшего в сессии.
            if (this.queue.length === 0) {
                const exclude = new Set(sessionPlayed);
                if (seed) exclude.add(this.key(seed));

                let pool = tracks.filter(t => !exclude.has(this.key(t)));

                // Если и тут пусто — сбрасываем сессию и играем что угодно
                if (pool.length === 0) {
                    sessionPlayed.clear();
                    pool = seed ? tracks.filter(t => t !== seed) : tracks.slice();
                }

                if (pool.length) {
                    this.queue.push(pool[Math.floor(Math.random() * pool.length)]);
                }
            }
        }

        const next = this.queue.shift() || null;
        if (next) sessionPlayed.add(this.key(next));   // ← сразу помечаем
        return next;
    },

    // ─── Events ─────────────────────────────────────────
    onTrackStarted(file) {
        const k = this.key(file);
        this.recentKeys.unshift(k);
        if (this.recentKeys.length > RECO_HISTORY) this.recentKeys.pop();

        if (!this.queue.includes(file)) {
            this.buildQueue(file);
        } else {
            const idx = this.queue.indexOf(file);
            if (idx !== -1) this.queue.splice(0, idx + 1);
        }

        // Пре-фетч фич для текущего и следующих
        this.ensureFeatures(file).then(() => {
            if (this.queue.length < QUEUE_SIZE) this.buildQueue(file);
        });
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
        this.buildQueue(file);
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