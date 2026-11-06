#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 docs/src/*.md 转成排版好的 HTML，再调用 workbuddy 的 convert_doc.py 生成 .docx

用法：
  python3 tools/md2docx.py docs/src/01-管理员手册.md docs/01-管理员手册.docx \
      --kind 管理员手册 --docno DOC-01

只支持本项目文档用到的 Markdown 子集：
  标题(#/##/###)、段落、**加粗**、`行内代码`、无序/有序列表、任务列表、
  表格、引用、代码块。
"""
import argparse
import html
import os
import re
import subprocess
import sys
import tempfile

CONVERT = os.path.expanduser(
    '~/.workbuddy/plugins/cache/workbuddy-builtin/workbuddy-docx/'
    '5.9.3-wb.42398134.gd4692421.h1dfe572c384a/skills/html-to-doc/scripts/convert_doc.py'
)


def esc(s: str) -> str:
    """只挡尖括号，不动 & —— 转换器不会解码 HTML 实体，
    写成 &amp; 会在 Word 里原样显示成 "&amp;"。"""
    return s.replace('<', '＜').replace('>', '＞')


def inline(text: str) -> str:
    """轻转义 + 行内格式"""
    s = esc(text)
    s = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'`([^`]+?)`', r'<code>\1</code>', s)
    # 任务列表的复选框
    s = s.replace('[ ] ', '☐ ')
    return s


def parse_table(lines):
    """lines 全部以 | 开头，第二行是分隔行"""
    def cells(row):
        row = row.strip()
        if row.startswith('|'):
            row = row[1:]
        if row.endswith('|'):
            row = row[:-1]
        return [c.strip() for c in row.split('|')]

    head = cells(lines[0])
    body = [cells(r) for r in lines[2:]]
    out = ['<table>', '<thead><tr>']
    for c in head:
        out.append(f'<th>{inline(c)}</th>')
    out.append('</tr></thead><tbody>')
    for r in body:
        out.append('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>')
    out.append('</tbody></table>')
    return '\n'.join(out)


def parse_md(md: str):
    lines = md.splitlines()
    title = None
    blocks = []          # (kind, html, text)  kind: h1/h2/h3/p/ul/ol/table/pre/quote/hr
    h1_no = 0
    h2_no = 0
    toc = []             # [(level, id, text)]

    i = 0
    while i < len(lines):
        raw = lines[i]
        line = raw.rstrip()
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        # 文档主标题
        if stripped.startswith('# ') and not stripped.startswith('##'):
            if title is None:
                title = stripped[2:].strip()
                i += 1
                continue

        # 代码块
        if stripped.startswith('```'):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith('```'):
                buf.append(lines[i])
                i += 1
            i += 1
            code = esc('\n'.join(buf))
            blocks.append(('pre', f'<pre>{code}</pre>'))
            continue

        # 表格
        if stripped.startswith('|'):
            buf = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                buf.append(lines[i])
                i += 1
            if len(buf) >= 2:
                blocks.append(('table', parse_table(buf)))
            continue

        # 标题
        m = re.match(r'^(#{2,4})\s+(.*)$', stripped)
        if m:
            level = len(m.group(1)) - 1        # ## → 1, ### → 2, #### → 3
            text = m.group(2).strip()
            if level == 1:
                h1_no += 1
                h2_no = 0
                hid = f'section-{h1_no}'
                toc.append((1, hid, text))
                blocks.append(('h1', f'<h1 id="{hid}" class="first">{inline(text)}</h1>'))
            elif level == 2:
                h2_no += 1
                hid = f'section-{h1_no}-{h2_no}'
                toc.append((2, hid, text))
                blocks.append(('h2', f'<h2 id="{hid}">{inline(text)}</h2>'))
            else:
                blocks.append(('h3', f'<h3>{inline(text)}</h3>'))
            i += 1
            continue

        # 引用
        if stripped.startswith('>'):
            buf = []
            while i < len(lines) and lines[i].strip().startswith('>'):
                buf.append(lines[i].strip().lstrip('>').strip())
                i += 1
            blocks.append(('quote', f'<blockquote>{inline("<br>".join(buf))}</blockquote>'))
            continue

        # 列表
        if re.match(r'^([-*]|\d+\.)\s+', stripped):
            ordered = bool(re.match(r'^\d+\.\s+', stripped))
            items = []
            while i < len(lines):
                s2 = lines[i].strip()
                if not s2:
                    # 列表内允许空行，但下一行不是列表就结束
                    if i + 1 < len(lines) and re.match(r'^([-*]|\d+\.)\s+', lines[i + 1].strip()):
                        i += 1
                        continue
                    break
                m2 = re.match(r'^([-*]|\d+\.)\s+(.*)$', s2)
                if not m2:
                    break
                items.append(m2.group(2))
                i += 1
            tag = 'ol' if ordered else 'ul'
            lis = ''.join(f'<li>{inline(t)}</li>' for t in items)
            blocks.append((tag, f'<{tag}>{lis}</{tag}>'))
            continue

        # 段落
        buf = [stripped]
        i += 1
        while i < len(lines):
            nxt = lines[i].strip()
            if (not nxt or nxt.startswith('#') or nxt.startswith('|')
                    or nxt.startswith('```') or nxt.startswith('>')
                    or re.match(r'^([-*]|\d+\.)\s+', nxt)):
                break
            buf.append(nxt)
            i += 1
        blocks.append(('p', f'<p>{inline("".join(buf))}</p>'))

    return title, blocks, toc


CSS = """
@page {
  margin: 2.4cm 2.2cm 2.6cm 2.2cm;
  @bottom-center { content: counter(page); font-family: "宋体", SimSun, serif; font-size: 9pt; color: #666; }
}
@page cover {
  @bottom-center { content: none; }
}
section[role="cover"] { page: cover; }

body { font-family: "宋体", SimSun, serif; font-size: 12pt; line-height: 1.75; color: #1a1a1a; }

/* 封面 */
.cover { padding-top: 5.5cm; }
.cover-mark { font-family: "黑体", SimHei, sans-serif; font-size: 11pt; letter-spacing: 0.28em; color: #3c6e5a; margin-bottom: 1.4em; }
.cover-title { font-family: "黑体", SimHei, sans-serif; font-size: 34pt; font-weight: bold; color: #14201c; margin: 0 0 0.35em 0; line-height: 1.25; }
.cover-sub { font-family: "黑体", SimHei, sans-serif; font-size: 14pt; color: #5b6b64; margin: 0 0 2.2em 0; }
.cover-rule { width: 3.2cm; height: 3px; background: #3c6e5a; margin: 0 0 2.2em 0; }
.cover-meta { font-size: 10.5pt; color: #4a4a4a; margin: 0.25em 0; line-height: 1.9; }

/* 目录 */
.doc-toc { padding-top: 0.4cm; }
.toc-title { font-family: "黑体", SimHei, sans-serif; font-size: 18pt; font-weight: bold; color: #14201c; margin: 0 0 1.1em 0; letter-spacing: 0.1em; }
.toc-list, .toc-list ol, .toc-list ul { list-style: none; list-style-type: none; padding-left: 0; margin: 0; }
.toc-list li { margin: 0.34em 0; font-size: 11.5pt; }
.toc-list > li > a { font-weight: bold; color: #14201c; text-decoration: none; }
.toc-list ol { padding-left: 1.6em; margin-top: 0.2em; }
.toc-list ol li { font-size: 10.5pt; color: #444; }
.toc-list a { color: #1f4d3d; text-decoration: none; }

/* 正文 */
.body { padding-top: 0; }
h1 { font-family: "黑体", SimHei, sans-serif; font-size: 20pt; font-weight: bold; color: #14201c;
     margin: 1.6em 0 0.7em 0; padding-bottom: 0.25em; border-bottom: 2px solid #3c6e5a;
     page-break-before: always; page-break-after: avoid; }
h1.first { margin-top: 0; }
h2 { font-family: "黑体", SimHei, sans-serif; font-size: 14pt; font-weight: bold; color: #1f4d3d;
     margin: 1.3em 0 0.5em 0; page-break-after: avoid; }
h3 { font-family: "黑体", SimHei, sans-serif; font-size: 12pt; font-weight: bold; color: #2b3a34;
     margin: 1em 0 0.4em 0; page-break-after: avoid; }
p { margin: 0 0 0.75em 0; text-indent: 2em; text-align: justify; }
ul, ol { margin: 0.3em 0 0.9em 0; padding-left: 2.2em; }
li { margin: 0.28em 0; }
blockquote { margin: 0.8em 0; padding: 0.6em 1em; border-left: 3px solid #3c6e5a;
             background: #f4f7f5; color: #33403a; }
blockquote p { text-indent: 0; }
pre { font-family: "Menlo", "Consolas", monospace; font-size: 9.5pt; line-height: 1.6;
      background: #f5f6f7; border: 1px solid #e2e5e8; padding: 0.7em 0.9em; margin: 0.7em 0 1em 0;
      white-space: pre-wrap; }
code { font-family: "Menlo", "Consolas", monospace; font-size: 9.5pt; background: #f2f4f5; color: #245c49; }

table { width: 100%; border-collapse: collapse; margin: 0.7em 0 1.1em 0; font-size: 10pt; }
th, td { border: 1px solid #c9cfd3; padding: 0.42em 0.55em; vertical-align: top; text-align: left; line-height: 1.55; }
th { background: #eef2f0; font-family: "黑体", SimHei, sans-serif; font-weight: bold; color: #14201c; }
td { text-indent: 0; }
"""


def build_html(title, kind, docno, blocks, toc):
    # 目录：一级 li 内嵌 <ol> 放二级条目
    nav = ['<nav class="doc-toc" aria-label="文档目录">', '<p class="toc-title" style="text-indent:0">目录</p>',
           '<ol class="toc-list">']
    open_li = False      # 当前是否有未闭合的一级 li
    open_sub = False     # 当前一级 li 内是否有未闭合的二级 ol
    for level, hid, text in toc:
        if level == 1:
            if open_sub:
                nav.append('</ol>')
                open_sub = False
            if open_li:
                nav.append('</li>')
            nav.append(f'<li><a href="#{hid}">{html.escape(text)}</a>')
            open_li = True
        else:
            if not open_sub:
                nav.append('<ol>')
                open_sub = True
            nav.append(f'<li><a href="#{hid}">{html.escape(text)}</a></li>')
    if open_sub:
        nav.append('</ol>')
    if open_li:
        nav.append('</li>')
    nav.append('</ol></nav>')

    body = '\n'.join(h for _, h in blocks)
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="docx-page-size" content="A4">
<title>{html.escape(title)}</title>
<style>{CSS}</style>
</head>
<body>
<section role="cover" class="cover">
  <p class="cover-mark" style="text-indent:0;margin-top:150pt">柳树沟村 · 数字村落</p>
  <p class="cover-title" style="text-indent:0">{html.escape(kind)}</p>
  <p class="cover-sub" style="text-indent:0">甘肃定西岷县风格 · 三维虚拟村落</p>
  <div class="cover-rule"></div>
  <p class="cover-meta" style="text-indent:0">文档编号　{docno}</p>
  <p class="cover-meta" style="text-indent:0">文档版本　v1.0</p>
  <p class="cover-meta" style="text-indent:0">编制日期　2026 年 11 月 6 日</p>
  <p class="cover-meta" style="text-indent:0">配套程序　柳树沟村.html（单文件离线版）</p>
</section>
<section role="cover" class="doc-toc-section">
{''.join(nav)}
</section>
<section role="body" class="body" data-page-restart="1">
{body}
</section>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('md')
    ap.add_argument('docx')
    ap.add_argument('--kind', required=True)
    ap.add_argument('--docno', default='DOC-00')
    ap.add_argument('--keep-html', action='store_true')
    ap.add_argument('--fast', action='store_true', help='跳过 verify（含 & 的段落会被误判为丢失）')
    args = ap.parse_args()

    md = open(args.md, encoding='utf-8').read()
    title, blocks, toc = parse_md(md)
    if not title:
        raise SystemExit('未找到一级标题')

    doc = build_html(title, args.kind, args.docno, blocks, toc)

    os.makedirs(os.path.dirname(os.path.abspath(args.docx)), exist_ok=True)
    tmp = tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, encoding='utf-8')
    tmp.write(doc)
    tmp.close()
    if args.keep_html:
        keep = os.path.splitext(args.docx)[0] + '.html'
        open(keep, 'w', encoding='utf-8').write(doc)
        print('HTML:', keep)

    print(f'转换：{os.path.basename(args.md)} → {os.path.basename(args.docx)}  '
          f'（{len(blocks)} 块，{len(toc)} 条目录）')

    cmd = [sys.executable, CONVERT, '--html', tmp.name, '--output', os.path.abspath(args.docx)]
    # 需要封面 + 页码 + 目录，走严格预检
    cmd += ['--require-page-furniture', '--require-toc']
    if args.fast:
        cmd.append('--no-verify')
    r = subprocess.run(cmd, capture_output=True, text=True)
    print(r.stdout.strip())
    if r.returncode != 0:
        print(r.stderr.strip())
        raise SystemExit(f'转换失败（退出码 {r.returncode}）')
    os.unlink(tmp.name)


if __name__ == '__main__':
    main()
