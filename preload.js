const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    normalizeAudioFile: (filePath) =>
        ipcRenderer.invoke(
            'normalize-audio-file',
            filePath
        )
});

// ══════════════════════════════════════════════════════
//  VOICE BRIDGE — ключ API остаётся в main-процессе
// ══════════════════════════════════════════════════════
contextBridge.exposeInMainWorld('voiceAPI', {
    getConfig: () => ipcRenderer.invoke('voice:get-config'),
    setConfig: (patch) => ipcRenderer.invoke('voice:set-config', patch),

    chat: (payload) => ipcRenderer.invoke('voice:chat', payload),
    tts: (payload) => ipcRenderer.invoke('voice:tts', payload),
    asr: (payload) => ipcRenderer.invoke('voice:asr', payload),
    voices: () => ipcRenderer.invoke('voice:voices'),
    ping: () => ipcRenderer.invoke('voice:ping'),

    onLog: (cb) => {
        const handler = (_e, data) => cb(data);
        ipcRenderer.on('voice:log', handler);
        return () => ipcRenderer.removeListener('voice:log', handler);
    },

    onHotkey: (cb) => {
        const handler = () => cb();
        ipcRenderer.on('voice:hotkey', handler);
        return () => ipcRenderer.removeListener('voice:hotkey', handler);
    }
});
