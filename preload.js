const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    normalizeAudioFile: (filePath) =>
        ipcRenderer.invoke(
            'normalize-audio-file',
            filePath
        )
});