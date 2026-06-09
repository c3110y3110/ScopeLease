const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scopeleaseDesktop", {
  getState: () => ipcRenderer.invoke("state:get"),
  getPreflight: (payload) => ipcRenderer.invoke("project:preflight", payload),
  getHealth: (payload) => ipcRenderer.invoke("project:health", payload),
  getMeasurementMode: (payload) => ipcRenderer.invoke("measurement:get", payload),
  setMeasurementMode: (payload) => ipcRenderer.invoke("measurement:set", payload),
  startProject: (payload) => ipcRenderer.invoke("project:start", payload),
  selectRepo: () => ipcRenderer.invoke("project:select"),
  attachProject: (payload) => ipcRenderer.invoke("project:attach", payload),
  runAction: (payload) => ipcRenderer.invoke("command:run", payload),
  cancelCommand: () => ipcRenderer.invoke("command:cancel"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  revealPath: (targetPath) => ipcRenderer.invoke("path:reveal", targetPath),
  onCommandEvent: (callback) => {
    const listener = (_event, event) => callback(event);
    ipcRenderer.on("command:event", listener);
    return () => ipcRenderer.removeListener("command:event", listener);
  },
  onMenuAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("menu:action", listener);
    return () => ipcRenderer.removeListener("menu:action", listener);
  },
});
