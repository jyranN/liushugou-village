#!/usr/bin/env bash
# 打包当前版本：构建单文件 HTML + 组装交付目录 + 压缩
# 用法：./tools/package.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
VERSION=$(cat VERSION | tr -d ' \n')
DIST="$ROOT/dist"
PKG="$DIST/柳树沟村-项目包-$VERSION"
ZIP="$DIST/柳树沟村-项目包-$VERSION.zip"

echo "== 构建单文件版"
node tools/build-standalone.mjs

echo "== 组装交付目录 v$VERSION"
rm -rf "$PKG"
mkdir -p "$PKG/源码" "$PKG/预览图" "$PKG/文档/源稿"

cp 柳树沟村.html "$PKG/"
cp docs/使用说明.txt "$PKG/"
cp docs/images/overview.jpg "$PKG/预览图/俯瞰.jpg"
cp docs/images/closeup.jpg "$PKG/预览图/近景.jpg"
cp docs/*.docx "$PKG/文档/"
cp docs/src/*.md "$PKG/文档/源稿/"
cp docs/README.md "$PKG/文档/索引.md"

for d in js css data assets vendor tools; do cp -R "$d" "$PKG/源码/"; done
cp index.html package.json package-lock.json README.md CHANGELOG.md VERSION "$PKG/源码/"

find "$PKG" -name '.DS_Store' -delete

echo "== 压缩"
rm -f "$ZIP"
python3 - "$PKG" "$ZIP" <<'PY'
import os, sys, zipfile
pkg, out = sys.argv[1], sys.argv[2]
base = os.path.dirname(pkg)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(pkg):
        dirs[:] = [d for d in dirs if d != '.DS_Store']
        for f in files:
            if f == '.DS_Store':
                continue
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, base))
print('已生成 %s（%.1f MB）' % (out, os.path.getsize(out) / 1024 / 1024))
PY

echo "== 完成"
ls -lh "$ZIP"
