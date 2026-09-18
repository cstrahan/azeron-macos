#!/usr/bin/env node
"use strict";
// Prints the byte offset of the squashfs payload embedded in a type-2 AppImage.
// The payload begins immediately after the ELF section-header table, so we read
// the ELF64 header to compute e_shoff + e_shentsize * e_shnum. (We can't use
// `--appimage-offset` because that requires running the Linux binary.)
const fs = require("fs");
const file = process.argv[2];
if (!file) {
  console.error("usage: appimage-offset.js <AppImage>");
  process.exit(1);
}
const fd = fs.openSync(file, "r");
const buf = Buffer.alloc(64);
fs.readSync(fd, buf, 0, 64, 0);
fs.closeSync(fd);
if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
  console.error("not an ELF file");
  process.exit(1);
}
if (buf[4] !== 2) {
  console.error("not ELF64");
  process.exit(1);
}
const e_shoff = Number(buf.readBigUInt64LE(0x28));
const e_shentsize = buf.readUInt16LE(0x3a);
const e_shnum = buf.readUInt16LE(0x3c);
process.stdout.write(String(e_shoff + e_shentsize * e_shnum));
