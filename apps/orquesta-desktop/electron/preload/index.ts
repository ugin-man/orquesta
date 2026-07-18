import { contextBridge, ipcRenderer } from 'electron';
import { createDesktopHostApi } from './host-api';

const desktopHostApi = createDesktopHostApi((channel, input) => ipcRenderer.invoke(channel, input));

contextBridge.exposeInMainWorld('orquestaDesktop', desktopHostApi);
