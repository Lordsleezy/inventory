/**
 * True when a real typing keyboard is present (Surface Type Cover, USB, Bluetooth).
 * Ignores lid/power/gpio keys so a naked tablet is not treated as having a keyboard.
 */
export function physicalKeyboardAttached(procDevices: string): boolean {
  const blocks = procDevices.split(/\n\n+/);
  for (const block of blocks) {
    const name = /^N: Name="([^"]*)"/m.exec(block)?.[1] ?? "";
    if (!name) continue;
    if (/^(Lid Switch|Power Button|Sleep Button|Video Bus|gpio-keys|HDA Intel)/i.test(name)) {
      continue;
    }
    if (/keyboard/i.test(name)) return true;
    if (/Type Cover/i.test(name) && /\bkbd\b/.test(block)) return true;
  }
  return false;
}

export function tabletModeFromProc(procDevices: string): boolean {
  return !physicalKeyboardAttached(procDevices);
}
