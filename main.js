const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.name = 'KivoPlayer';

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'assets/icon_542x542.png'),
    title: 'KivoPlayer'
  });

  win.loadFile('index-test.html');
  //win.loadFile('index.html');
  win.maximize()
}

ipcMain.handle(
    'normalize-audio-file',
    async (_, filePath) => {

      console.log('normalize:', filePath);

      return {
        ok: true
      };
    }
);

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});