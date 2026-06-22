// Generate icon.ico + icon.png from icon.svg (run: node electron/gen-icon.cjs).
// sharp rasterizes the SVG at several sizes, png-to-ico packs them into a Windows .ico.
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const pngToIcoMod = require("png-to-ico");
const pngToIco = pngToIcoMod.default || pngToIcoMod;

const dir = __dirname;
const svg = fs.readFileSync(path.join(dir, "icon.svg"));
const sizes = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  const pngs = await Promise.all(
    sizes.map((s) => sharp(svg).resize(s, s).png().toBuffer())
  );
  // 256px PNG for the Electron window/taskbar icon
  fs.writeFileSync(path.join(dir, "icon.png"), pngs[pngs.length - 1]);
  const ico = await pngToIco(pngs);
  fs.writeFileSync(path.join(dir, "icon.ico"), ico);
  console.log("wrote icon.png + icon.ico");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
