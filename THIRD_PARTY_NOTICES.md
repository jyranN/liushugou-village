# 第三方组件与数据声明

> 项目：柳树沟村三维气象可视化系统 V1.1
> 编制日期：2026-11-08
> 本文件列明本项目使用的第三方代码、素材与数据来源及其许可，用于满足各许可的署名与告知义务。
> 本项目自有代码的许可见 [LICENSE](LICENSE)。

---

## 一、总览

| 类别 | 名称 | 许可 | 是否随成品分发 |
|---|---|---|---|
| 三维引擎 | three.js r160 | MIT | 是（`vendor/`） |
| 引擎扩展 | three.js addons（loaders / postprocessing / shaders / math / utils） | MIT | 是（`vendor/`） |
| 图像素材 | Poly Haven HDRI、PBR 扫描贴图 | CC0 1.0 Universal | 是（`assets/`） |
| 气象数据 | Open-Meteo 历史气象数据 | **CC BY 4.0（需署名）** | 是（`data/`） |
| 构建工具 | esbuild | MIT | 否，仅构建期使用 |

---

## 二、three.js r160 及 addons

- 许可：**MIT License**
- 版权：Copyright © three.js authors（年份与完整声明见其仓库 LICENSE 文件）
- 来源：https://github.com/mrdoob/three.js
- 位置：`vendor/three.module.js`、`vendor/loaders/`、`vendor/postprocessing/`、`vendor/shaders/`、`vendor/math/`、`vendor/utils/`
- 使用方式：作为依赖库原样调用，**未修改其源码**
- 义务：分发时保留版权声明与许可文本

> 本项目提交的软件著作权登记材料中，**不包含** `vendor/` 目录下任何源码。

### MIT License（three.js）

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 三、Poly Haven 素材

- 许可：**CC0 1.0 Universal（公共领域贡献）**
- 来源：https://polyhaven.com/license
- 位置：`assets/hdri/`（高动态范围环境光照贴图）、`assets/tex/`（基于物理渲染的扫描贴图）
- 义务：**无强制署名义务**，注明来源属自愿的最佳实践
- 说明：CC0 允许自由使用、修改与再分发，包括商业用途

---

## 四、Open-Meteo 气象数据（**需署名**）

- 许可：**Attribution 4.0 International（CC BY 4.0）**
- 许可页：https://open-meteo.com/en/licence
- 数据来源：Open-Meteo 历史气象 API，聚合 ECMWF、DWD、NOAA 等国家级气象服务开放数据
- 本项目数据：甘肃定西岷县，2025-01-01 至 2025-12-31，逐小时 8760 条
  字段含气温、相对湿度、降水量、降雪量、云量、风速、天气代码、地表温度
- 位置：`data/minxian-2025-raw.json`，并内联进单文件成品

### CC BY 4.0 的三项义务

1. **适当署名**：标明数据来源、提供许可链接
2. **说明是否修改**：本项目将原始序列按时间轴读取并映射为渲染参数，未改动原始数值
3. **不得暗示背书**：不得表述为 Open-Meteo 认可或推荐本项目

### 建议署名文本

> 气象数据来自 Open-Meteo.com（CC BY 4.0），已按时间轴映射为场景渲染参数，原始数值未改动。
> Weather data by [Open-Meteo.com](https://open-meteo.com/) — CC BY 4.0

### ⚠️ 当前尚需补齐的一项

Open-Meteo 许可页明确要求：**在显示其数据的位置旁边附上署名链接**，示例为
`<a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a>`。

本项目界面底部时间轴右侧实时显示气温、云量与天气（即数据展示位置），
**目前该处尚未放置署名链接**。建议在时间栏旁增加一行小字链接，
并在离线单文件成品中同样保留（链接可点击，离线时仍可见文字）。

### 「API 访问条款」与「数据许可」是两回事

| | 内容 |
|---|---|
| 数据许可 | CC BY 4.0，**允许**包括商业用途在内的使用与再分发，条件是署名 |
| 免费 API 访问 | 面向非商业用途，每日 10,000 次调用以内免费 |
| 商业用途 / 更高调用量 | 需订阅 Open-Meteo 付费方案 |

本仓库分发的是**已获取并固定下来的历史数据文件**，不产生新的 API 调用，
但仍须履行 CC BY 4.0 的署名义务。若日后改为实时请求 API 且用于商业场景，需另行评估订阅要求。

### 学术引用（如用于论文）

> Zippenfenig, P. (2023). Open-Meteo.com Weather API [Computer software]. Zenodo.
> https://doi.org/10.5281/ZENODO.7970649

---

## 五、esbuild

- 许可：MIT
- 来源：https://github.com/evanw/esbuild
- 用途：构建期将源码与资源打包为单文件 HTML
- **不随成品分发**，成品中不含 esbuild 代码

---

## 六、本项目自有内容

以下内容由本项目独立完成，未经第三方授权许可，适用仓库根目录 [LICENSE](LICENSE)（MIT）：

- `js/` 全部 9 个模块、`css/style.css`、`index.html`
- 程序化生成的场景布局、村落档案数据、界面设计
- `tools/` 构建与截图脚本
- `docs/` 四份项目文档与效果图

村落、住户、牲畜、地名「柳树沟村」均为**虚构内容**，仅用于演示；
气象记录为真实历史数据，两者不得混同表述。

---

## 七、登记材料口径

软件著作权登记提交范围仅含 `js/` 与 `css/` 自研源码，
不含 `vendor/` 第三方库源码、不含 `assets/` 第三方素材。
登记材料（源代码文档、软件说明书）不随本工程分发，另行归档保存。

---

_本文件为事实性来源说明，不构成法律意见。若项目转为商业用途，建议就各许可的适用另行确认。_
