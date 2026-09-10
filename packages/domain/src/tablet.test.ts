import test from "node:test";
import assert from "node:assert/strict";
import { physicalKeyboardAttached, tabletModeFromProc } from "./tablet.ts";

const TYPE_COVER = `I: Bus=0019 Vendor=0000 Product=0005 Version=0000
N: Name="Lid Switch"
H: Handlers=event0

I: Bus=0019 Vendor=0001 Product=0001 Version=0100
N: Name="gpio-keys"
H: Handlers=kbd event8
B: KEY=c000000000000 0

I: Bus=0003 Vendor=045e Product=09c0 Version=0111
N: Name="Microsoft Surface Type Cover Keyboard"
H: Handlers=sysrq kbd event1 leds
`;

const TABLET_ONLY = `I: Bus=0019 Vendor=0000 Product=0005 Version=0000
N: Name="Lid Switch"
H: Handlers=event0

I: Bus=0019 Vendor=0001 Product=0001 Version=0100
N: Name="gpio-keys"
H: Handlers=kbd event8
B: KEY=c000000000000 0

I: Bus=0000 Vendor=0000 Product=0000 Version=0000
N: Name="HDA Intel PCH Headphone"
H: Handlers=event12
`;

const BT_KEYBOARD = `I: Bus=0005 Vendor=0000 Product=0000 Version=0000
N: Name="Logitech K380 Keyboard"
H: Handlers=sysrq kbd event20 leds
`;

test("Type Cover counts as a keyboard", () => {
  assert.equal(physicalKeyboardAttached(TYPE_COVER), true);
  assert.equal(tabletModeFromProc(TYPE_COVER), false);
});

test("lid, gpio, and audio devices are tablet mode", () => {
  assert.equal(physicalKeyboardAttached(TABLET_ONLY), false);
  assert.equal(tabletModeFromProc(TABLET_ONLY), true);
});

test("a Bluetooth keyboard counts as attached", () => {
  assert.equal(physicalKeyboardAttached(BT_KEYBOARD), true);
});
