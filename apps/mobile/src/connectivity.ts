import { App } from "@capacitor/app";
import { Network } from "@capacitor/network";
import { setDeviceNetworkGetter, type DeviceNetwork } from "@floor/cloud";

export async function capacitorNetwork(): Promise<DeviceNetwork> {
  const status = await Network.getStatus();
  return {
    connected: status.connected,
    connectionType: status.connectionType,
  };
}

export function installDeviceNetwork(): void {
  setDeviceNetworkGetter(capacitorNetwork);
}

export function listenConnectivity(onChange: () => void): () => void {
  const handles: Array<{ remove: () => Promise<void> }> = [];
  void Network.addListener("networkStatusChange", () => onChange()).then((h) => handles.push(h));
  void App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) onChange();
  }).then((h) => handles.push(h));
  return () => {
    for (const h of handles) void h.remove();
  };
}
