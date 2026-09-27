// Preloaded (`node --require`) into every child the end-to-end harness runs on the `ledger`
// network. It makes touching a Ledger device impossible from those runs, whatever the command
// under test does.
//
// `@nomicfoundation/hardhat-ledger` reaches the USB bus only through
// `@ledgerhq/hw-transport-node-hid` (`Transport.create`, in `LedgerHandler.init`), which it
// loads with a CommonJS `require` from `dist/src/internal/cjs-imports.js`. That require is
// answered here with a stand-in whose every entry point throws, and the two native modules
// underneath it are refused outright, so neither the transport nor the HID and USB bindings
// load at all. The marker line is how a test proves the stand-in was served: it is printed
// only when the plugin actually imported its handler in that process.
"use strict";

const Module = require("node:module");

const BLOCKED = "ledger device access is blocked in the end-to-end harness";
const MARKER = "[e2e] ledger transport replaced by a stand-in that cannot reach a device";

function refuse() {
  throw new Error(BLOCKED);
}

const standIn = {
  __esModule: true,
  default: { create: refuse, open: refuse, list: refuse, listen: refuse, isSupported: refuse },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "@ledgerhq/hw-transport-node-hid") {
    console.error(MARKER);
    return standIn;
  }
  if (request === "node-hid" || request === "usb") refuse();
  return originalLoad.call(this, request, parent, isMain);
};
