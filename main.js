const { app, BrowserWindow } = require('electron');
const path = require('path');

app.name = 'KivoPlayer';

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      // Разрешаем использовать локальные ресурсы
      webSecurity: false 
    },
    icon: path.join(__dirname, 'assets/icon_542x542.png'),
    title: 'KivoPlayer'
  });

  win.loadFile('index.html');
  win.maximize()
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});