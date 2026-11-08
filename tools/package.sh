#!/usr/bin/env bash
# 打包当前版本：构建单文件 HTML → 组装交付包 + 全量包 → 生成 MANIFEST 与校验和
# 用法：./tools/package.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
VERSION=$(cat VERSION | tr -d ' \n')
DIST="$ROOT/dist"
DELIVER_ZIP="$DIST/Liushugou-Village-$VERSION.zip"
FULL_ZIP="$DIST/柳树沟村-项目全量-$VERSION.zip"
mkdir -p "$DIST"

# 在临时目录组装，避免覆盖/删除既有目录
STAGE_D=$(mktemp -d /tmp/village-deliver.XXXXXX)
STAGE_F=$(mktemp -d /tmp/village-full.XXXXXX)
PKG="$STAGE_D/柳树沟村-项目包-$VERSION"
FULL="$STAGE_F/柳树沟村-$VERSION-完整工程"

# 生成 MANIFEST（文件清单 + 逐个 SHA256）
manifest() {
  python3 - "$1" "$2" <<'PY'
import hashlib, os, sys, datetime
pkg, label = sys.argv[1], sys.argv[2]
rows, total = [], 0
for root, dirs, files in os.walk(pkg):
    dirs[:] = sorted(d for d in dirs if d != '.DS_Store')
    for f in sorted(files):
        if f in ('.DS_Store', 'MANIFEST.txt', 'MANIFEST.sha256'):
            continue
        p = os.path.join(root, f)
        rel = os.path.relpath(p, pkg).replace(os.sep, '/')
        data = open(p, 'rb').read()
        h = hashlib.sha256(data).hexdigest()
        total += len(data)
        rows.append((h, len(data), rel))
with open(os.path.join(pkg, 'MANIFEST.txt'), 'w', encoding='utf-8') as fh:
    fh.write('# MANIFEST · %s\n' % label)
    fh.write('# 生成时间：%s\n' % datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
    fh.write('# 文件数：%d    合计：%.1f MB\n' % (len(rows), total / 1024 / 1024))
    fh.write('# 校验：在本目录执行  shasum -a 256 -c MANIFEST.sha256\n')
    fh.write('# SHA256                                                           字节        路径\n')
    for h, n, rel in rows:
        fh.write('%s  %10d  %s\n' % (h, n, rel))
with open(os.path.join(pkg, 'MANIFEST.sha256'), 'w', encoding='utf-8') as fh:
    for h, n, rel in rows:
        fh.write('%s  ./%s\n' % (h, rel))
print('  MANIFEST：%d 个文件 / %.1f MB' % (len(rows), total / 1024 / 1024))
PY
}

zipdir() {
  python3 - "$1" "$2" <<'PY'
import os, sys, zipfile
pkg, out = sys.argv[1], sys.argv[2]
base = os.path.dirname(pkg)
if os.path.exists(out):
    os.remove(out)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(pkg):
        dirs[:] = sorted(d for d in dirs if d != '.DS_Store')
        for f in sorted(files):
            if f == '.DS_Store':
                continue
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, base))
print('  %s（%.1f MB）' % (os.path.basename(out), os.path.getsize(out) / 1024 / 1024))
PY
}

echo "== 0/5 安全预检"
[ -f "docs/软著/evidence/conversation-data.json" ] && \
  echo "  · 敏感文件存在，已排除：docs/软著/evidence/conversation-data.json"
[ -f "docs/软著/evidence/.gitignore" ] && \
  echo "  · evidence/.gitignore 保留在仓库内，不进任何包"
BAD=$(find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./dist -prune -o \
      -type f -size +50M -print 2>/dev/null | grep -v conversation-data || true)
if [ -n "$BAD" ]; then echo "  ✗ 存在大于 50 MB 的文件：$BAD"; exit 1; fi
echo "  · 无 >50 MB 文件"

echo "== 1/5 构建单文件版"
node tools/build-standalone.mjs

echo "== 2/5 组装交付包 v$VERSION"
mkdir -p "$PKG/源码" "$PKG/预览图" "$PKG/文档/源稿"
# 根目录直放：解开压缩包就能读的东西，不用进子目录找
cp 柳树沟村.html 使用说明.txt README.md CHANGELOG.md VERSION LICENSE \
   THIRD_PARTY_NOTICES.md PROVENANCE.md CITATION.cff .gitattributes "$PKG/"
cp docs/*.docx "$PKG/文档/"
cp docs/预览图参数.md docs/v1.1-交付清单.md "docs/发布验证-v$VERSION.md" \
   "docs/Release-Notes-v$VERSION.md" "$PKG/文档/"
cp docs/README.md "$PKG/文档/索引.md"
cp docs/src/0[1-4]-*.md "$PKG/文档/源稿/"
for f in preview-0*.png; do cp "$f" "$PKG/预览图/${f#preview-}"; done
for d in js css data assets vendor tools; do cp -R "$d" "$PKG/源码/"; done
cp index.html package.json package-lock.json README.md CHANGELOG.md VERSION \
   LICENSE THIRD_PARTY_NOTICES.md "$PKG/源码/"
find "$PKG" -name '.DS_Store' -delete
manifest "$PKG" "柳树沟村-项目包-${VERSION}（交付包）"

echo "== 3/5 组装全量包 v$VERSION"
mkdir -p "$FULL"
cp README.md CHANGELOG.md VERSION LICENSE THIRD_PARTY_NOTICES.md PROVENANCE.md \
   CITATION.cff .gitattributes .gitignore index.html package.json package-lock.json \
   使用说明.txt 柳树沟村.html "$FULL/"
cp preview-0*.png "$FULL/"
for d in js css data assets vendor tools research .vscode; do cp -R "$d" "$FULL/"; done
mkdir -p "$FULL/docs"
# 复制 docs 全部内容，但排除软著/evidence（对话原文，永不进包）
(cd docs && find . -mindepth 1 -maxdepth 1 ! -name '软著' -exec cp -R {} "$FULL/docs/" \;)
mkdir -p "$FULL/docs/软著"
(cd docs/软著 && find . -mindepth 1 -maxdepth 1 ! -name 'evidence' -exec cp -R {} "$FULL/docs/软著/" \;)
find "$FULL" -name '.DS_Store' -delete
manifest "$FULL" "柳树沟村-$VERSION-完整工程（全量包）"

echo "== 4/5 压缩"
zipdir "$PKG" "$DELIVER_ZIP"
zipdir "$FULL" "$FULL_ZIP"

echo "== 5/5 校验和"
(cd "$DIST" && shasum -a 256 "$(basename "$DELIVER_ZIP")" "$(basename "$FULL_ZIP")" > SHA256SUMS)
cat "$DIST/SHA256SUMS"

echo "== 完成"
ls -lh "$DELIVER_ZIP" "$FULL_ZIP"
echo "临时组装目录：${STAGE_D} / ${STAGE_F}（不需要可手动删除）"
