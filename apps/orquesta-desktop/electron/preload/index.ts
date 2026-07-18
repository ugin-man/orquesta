import { contextBridge, ipcRenderer } from 'electron';
import { createDesktopHostApi } from './host-api';

const desktopHostApi = createDesktopHostApi(
  (channel, input) => ipcRenderer.invoke(channel, input),
  (channel, listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
);

contextBridge.exposeInMainWorld('orquestaDesktop', desktopHostApi);
