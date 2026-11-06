#!/usr/bin/env bash
# 发布一个新版本：写版本号 → 记 CHANGELOG → 打包 → 提交 → 打 tag → 推送 → 建 Release
# 用法：./tools/release.sh 1.1 "新增村民日常动线"
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=${1:-}
MSG=${2:-}
if [ -z "$VERSION" ] || [ -z "$MSG" ]; then
  echo "用法：./tools/release.sh <版本号> <一句话说明>"
  echo "示例：./tools/release.sh 1.1 \"新增村民日常动线\""
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  工作区有未提交的改动，将一并提交进本次版本："
  git status --short
  echo
fi

echo "== 1/6 写入版本号"
echo "$VERSION" > VERSION

echo "== 2/6 更新 CHANGELOG"
python3 - "$VERSION" "$MSG" <<'PY'
import sys, datetime
ver, msg = sys.argv[1], sys.argv[2]
p = 'CHANGELOG.md'
s = open(p, encoding='utf-8').read()
entry = f"## [{ver}] - {datetime.date.today().isoformat()}\n\n{msg}\n\n"
i = s.find('\n## [')
s = (s[:i + 1] + entry + s[i + 1:]) if i > 0 else (s + '\n' + entry)
open(p, 'w', encoding='utf-8').write(s)
PY

echo "== 3/6 打包"
./tools/package.sh

echo "== 4/6 提交"
git add -A
git commit -m "release: v$VERSION - $MSG"

echo "== 5/6 打标签"
git tag -a "v$VERSION" -m "$MSG"

echo "== 6/6 推送"
ZIP="dist/Liushugou-Village-$VERSION.zip"
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "还没有配置远程仓库，已在本机完成提交与 tag。"
  echo
  echo "接着做两步："
  echo "  1) 在 GitHub 上新建一个空仓库（不要勾选 README）"
  echo "  2) 执行："
  echo "     git remote add origin https://github.com/<你的用户名>/<仓库名>.git"
  echo "     git push -u origin main --follow-tags"
  echo
  echo "推送完成后，到仓库的 Releases 页面新建一条："
  echo "  标签选 v$VERSION，标题写 v$VERSION，把 $ZIP 拖进去上传。"
  exit 0
fi

git push -u origin HEAD --follow-tags

if command -v gh >/dev/null 2>&1; then
  echo "== 创建 GitHub Release"
  gh release create "v$VERSION" "$ZIP" --title "v$VERSION" --notes "$MSG"
  echo "✅ 已发布 v$VERSION"
else
  echo "✅ 已推送 tag v$VERSION"
  echo
  echo "本机没有 GitHub CLI，Release 需要手动建："
  echo "  打开仓库 → Releases → Draft a new release → 选 v$VERSION"
  echo "  标题填 v$VERSION，把 $ZIP 拖进去上传。"
  echo "  （想自动上传可先安装：brew install gh && gh auth login）"
fi
