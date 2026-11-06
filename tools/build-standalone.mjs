/**
 * 构建单文件离线版：把 JS / CSS / 气象数据全部内联进一个 .html
 * 产物双击即可在浏览器打开，不需要服务器、不需要联网。
 *
 * 运行：node tools/build-standalone.mjs
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor');
const outFile = path.join(root, '柳树沟村.html');

/* ---------- 1. 打包 JS（three + addons 走自定义解析，避免双实例） ---------- */
const threeResolve = {
  name: 'three-resolve',
  setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({
      path: path.join(vendor, 'three.module.js'),
    }));
    build.onResolve({ filter: /^three\/addons\// }, (args) => ({
      path: path.join(vendor, args.path.replace('three/addons/', '')),
    }));
  },
};

const result = await esbuild.build({
  entryPoints: [path.join(root, 'js/main.js')],
  bundle: true,
  format: 'iife',
  write: false,
  target: ['chrome100', 'safari15', 'firefox100'],
  plugins: [threeResolve],
  logLevel: 'warning',
});

const js = result.outputFiles[0].text;

/* ---------- 2. 读样式与气候数据 ---------- */
const css = fs.readFileSync(path.join(root, 'css/style.css'), 'utf8');
const climate = fs.readFileSync(path.join(root, 'data/minxian-2025-raw.json'), 'utf8');

/* ---------- 2.5 素材内联：图片与 HDRI 转 data URI ---------- */
const assetMap = {};
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.hdr': 'image/vnd.radiance' };
const walkAssets = (dir, prefix = '') => {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) walkAssets(fp, `${prefix}${f}/`);
    else {
      const ext = path.extname(f).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      assetMap[`${prefix}${f}`] = `data:${mime};base64,${fs.readFileSync(fp).toString('base64')}`;
    }
  }
};
walkAssets(path.join(root, 'assets'));
const assetBytes = Object.values(assetMap).reduce((n, s) => n + s.length, 0);

/* ---------- 3. 内联安全化：避免提前闭合 script ---------- */
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');

/* ---------- 4. 组装 HTML ---------- */
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

html = html.replace(
  /<link rel="stylesheet" href="\.\/css\/style\.css" \/>/,
  `<style>\n${css}\n</style>`
);

html = html.replace(
  /<script type="importmap">[\s\S]*?<\/script>/,
  `<script>window.__CLIMATE_DATA = ${safe(climate)};window.__ASSETS = ${safe(JSON.stringify(assetMap))};</script>`
);

html = html.replace(
  /<script type="module" src="\.\/js\/main\.js"><\/script>/,
  `<script>\n${safe(js)}\n</script>`
);

fs.writeFileSync(outFile, html, 'utf8');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`已生成：${path.basename(outFile)}`);
console.log(`  内联 JS   ${kb(js.length)}`);
console.log(`  内联 CSS  ${kb(css.length)}`);
console.log(`  气候数据  ${kb(climate.length)}`);
console.log(`  素材(${Object.keys(assetMap).length} 件) ${kb(assetBytes)}`);
console.log(`  总计      ${kb(html.length)}`);
console.log(`检查：importmap 残留 ${/importmap/.test(html) ? '有（异常）' : '无'}，module script 残留 ${/type="module"/.test(html) ? '有（异常）' : '无'}`);
