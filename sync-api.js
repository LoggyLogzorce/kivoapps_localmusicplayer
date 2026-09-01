//const API_URL = "http://150.241.97.223:8000/api";
const API_URL = "http://127.0.0.1:8080/api";

class SyncApi {
    async request(url, options = {}) {
        try {
            const response = await fetch(url, options);

            if (!response.ok) {
                let error = response.statusText;

                try {
                    const body = await response.json();
                    error = body.error || error;
                } catch (_) {}

                return {
                    ok: false,
                    status: response.status,
                    error,
                };
            }

            return {
                ok: true,
                response,
            };
        } catch (err) {
            return {
                ok: false,
                status: 0,
                error: err.message,
            };
        }
    }

    async checkSync(files) {
        const result = await this.request(`${API_URL}/sync/check`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(files),
        });

        if (!result.ok)
            return result;

        return {
            ok: true,
            data: await result.response.json(),
        };
    }

    async uploadTrack(fingerprint, file) {
        const form = new FormData();
        form.append("file", file);

        const result = await this.request(
            `${API_URL}/tracks/${fingerprint}`,
            {
                method: "POST",
                body: form,
            }
        );

        if (!result.ok)
            return result;

        return { ok: true };
    }

    async uploadLyrics(audioFingerprint, lrcFingerprint, file) {
        const form = new FormData();
        form.append("file", file);

        const result = await this.request(
            `${API_URL}/tracks/${audioFingerprint}/lyrics/${lrcFingerprint}`,
            {
                method: "POST",
                body: form,
            }
        );

        if (!result.ok)
            return result;

        return { ok: true };
    }

    async downloadTrack(fingerprint) {
        const result = await this.request(
            `${API_URL}/tracks/${fingerprint}`
        );

        if (!result.ok)
            return result;

        return {
            ok: true,
            file: await result.response.blob(),
        };
    }

    async downloadLyrics(audioFingerprint, lrcFingerprint) {
        const result = await this.request(
            `${API_URL}/tracks/${audioFingerprint}/lyrics/${lrcFingerprint}`
        );

        if (!result.ok)
            return result;

        return {
            ok: true,
            file: await result.response.blob(),
        };
    }
}

const syncApi = new SyncApi();

// Вычисление fingerprint для audio файла через Web Audio API
async function computeAudioFingerprint(file) {
    const arrayBuffer = await file.arrayBuffer();

    // Берём первые 1 МБ файла (или весь файл, если он меньше)
    const chunkSize = Math.min(arrayBuffer.byteLength, 1024 * 1024);
    const chunk = arrayBuffer.slice(0, chunkSize);

    const hashBuffer = await crypto.subtle.digest('SHA-256', chunk);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Вычисление fingerprint для LRC файла
async function computeLrcFingerprint(file) {
    const text = await file.text();
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

// Сохранение fingerprint mapping в JSON файл
async function saveFingerprints(dirHandle, fingerprints) {
    try {
        const fileHandle = await dirHandle.getFileHandle('fingerprints.json', { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(fingerprints, null, 2));
        await writable.close();
    } catch (e) {
        console.error('Failed to save fingerprints:', e);
    }
}

// Загрузка fingerprint mapping из JSON файла
async function loadFingerprints(dirHandle) {
    try {
        const fileHandle = await dirHandle.getFileHandle('fingerprints.json');
        const file = await fileHandle.getFile();
        const text = await file.text();
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

// Глобальная переменная для отслеживания состояния
let isSyncing = false;

// Хранилище fingerprint'ов в памяти (ключ - путь к папке)
const fingerprintStore = new Map();

// Сохранение fingerprint mapping в память
function saveFingerprintsToMemory(dirName, fingerprints) {
    fingerprintStore.set(dirName, fingerprints);
}

// Загрузка fingerprint mapping из памяти
function loadFingerprintsFromMemory(dirName) {
    return fingerprintStore.get(dirName) || null;
}

// Показать уведомление о синхронизации
function showSyncNotification(onRefresh) {
    const notification = document.createElement('div');
    notification.className = 'sync-notification';
    notification.innerHTML = `
        <span>Синхронизация завершена</span>
        <button class="refresh-btn">Обновить треки</button>
        <button class="close-btn">✕</button>
    `;

    notification.querySelector('.refresh-btn').addEventListener('click', () => {
        onRefresh();
        notification.remove();
    });

    notification.querySelector('.close-btn').addEventListener('click', () => {
        notification.remove();
    });

    document.body.appendChild(notification);

    setTimeout(() => {
        if (notification.parentNode) notification.remove();
    }, 10000);
}

// Основной процесс синхронизации
async function syncDirectory(dirHandle, allFiles, dirName, onProgress, onSyncStart) {
    if (isSyncing) return false;
    isSyncing = true;
    showSyncStatus(); // только плашка, без модалки

    try {
        const fingerprints = [];
        const totalFiles = allFiles.length;

        // ФАЗА 1: Вычисление fingerprint (плашка: "Читаю файлы...")
        for (let i = 0; i < totalFiles; i++) {
            const file = allFiles[i];
            const ext = file.name.split('.').pop().toLowerCase();

            if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) {
                const fp = await computeAudioFingerprint(file);
                fingerprints.push({ audio_finger_print: fp, filename: file.name, _file: file });
            } else if (ext === 'lrc') {
                const fp = await computeLrcFingerprint(file);
                fingerprints.push({ lrc_finger_print: fp, filename: file.name, _file: file });
            }

            if (onProgress) onProgress(i + 1, totalFiles, 'Читаю файлы...', file.name, 'fingerprint');
        }

        saveFingerprintsToMemory(dirName, fingerprints.map(({_file, ...rest}) => rest));

        const checkData = fingerprints.map(({audio_finger_print, lrc_finger_print, filename}) => {
            const obj = { filename };
            if (audio_finger_print) obj.audio_finger_print = audio_finger_print;
            if (lrc_finger_print) obj.lrc_finger_print = lrc_finger_print;
            return obj;
        });

        // ФАЗА 2: Проверка сервера (плашка: "Проверяю сервер...")
        if (onProgress) onProgress(totalFiles, totalFiles, 'Проверяю сервер...', '', 'check');
        const result = await syncApi.checkSync(checkData);
        if (!result.ok) {
            console.error('Sync check failed:', result.error);
            hideSyncStatus();
            return false;
        }

        const { download, upload } = result.data;
        const uploadCount = (upload && upload.length) || 0;
        const downloadCount = (download && download.length) || 0;

        // Нечего синхронизировать — скрываем плашку
        if (uploadCount === 0 && downloadCount === 0) {
            hideSyncStatus();
            return true;
        }

        // ФАЗА 3: Синхронизация
        const totalSteps = uploadCount + downloadCount;
        let step = 0;

        // Показываем полный список файлов
        const allSyncFiles = [
            ...(upload || []).map(item => ({ name: item.filename, operation: 'upload' })),
            ...(download || []).map(item => ({ name: item.filename, operation: 'download' }))
        ];
        if (onSyncStart) onSyncStart(allSyncFiles);

        // Загрузка на сервер
        if (uploadCount > 0) {
            for (let i = 0; i < upload.length; i++) {
                const item = upload[i];
                const localFile = fingerprints.find(f =>
                    (item.type === 'audio' && f.audio_finger_print === item.audio_fingerprint) ||
                    (item.type === 'lyrics' && f.lrc_finger_print === item.lrc_fingerprint)
                );

                if (localFile?._file) {
                    try {
                        if (item.type === 'audio') {
                            await syncApi.uploadTrack(item.audio_fingerprint, localFile._file);
                        } else if (item.type === 'lyrics') {
                            await syncApi.uploadLyrics(item.audio_fingerprint, item.lrc_fingerprint, localFile._file);
                        }
                    } catch (e) {
                        console.error(`Failed to upload ${localFile.filename}:`, e);
                    }
                }

                step++;
                if (onProgress) {
                    onProgress(step, totalSteps, `Загрузка... ${step}/${totalSteps}`, localFile?.filename || '', 'upload');
                }
            }
        }

        // Скачивание с сервера
        if (downloadCount > 0) {
            for (let i = 0; i < download.length; i++) {
                const item = download[i];
                try {
                    let blob;
                    if (item.type === 'audio') {
                        const dlResult = await syncApi.downloadTrack(item.audio_fingerprint);
                        if (dlResult.ok) blob = dlResult.file;
                    } else if (item.type === 'lyrics') {
                        const dlResult = await syncApi.downloadLyrics(item.audio_fingerprint, item.lrc_fingerprint);
                        if (dlResult.ok) blob = dlResult.file;
                    }

                    if (blob) {
                        const fileHandle = await dirHandle.getFileHandle(item.filename, { create: true });
                        const writable = await fileHandle.createWritable();
                        await writable.write(blob);
                        await writable.close();
                    }
                } catch (e) {
                    console.error(`Failed to download ${item.filename}:`, e);
                }

                step++;
                if (onProgress) {
                    onProgress(step, totalSteps, `Скачивание... ${step}/${totalSteps}`, item.filename || '', 'download');
                }
            }
            showSyncNotification(() => { loadDirectory(dirHandle, { skipSync: true }); });
        }

        return true;
    } finally {
        isSyncing = false;
        setTimeout(hideSyncStatus, 3000);
    }
}

