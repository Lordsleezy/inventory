const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("floorDesktop", {
  marketplaceOpen: (channel) => ipcRenderer.invoke("marketplace:open", channel),
  marketplaceNavigate: (url) => ipcRenderer.invoke("marketplace:navigate", url),
  marketplaceBack: () => ipcRenderer.invoke("marketplace:back"),
  marketplaceBounds: (bounds) => ipcRenderer.invoke("marketplace:bounds", bounds),
  marketplaceHide: () => ipcRenderer.invoke("marketplace:hide"),
  marketplaceStatus: () => ipcRenderer.invoke("marketplace:status"),
  onMarketplaceUrl: (cb) => {
    ipcRenderer.on("marketplace:url", (_event, url) => cb(url));
  },
});
