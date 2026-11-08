# 柳树沟村三维气象可视化系统 V1.1

甘肃定西岷县风格的三维虚拟村庄，基于 Three.js / WebGL 2.0 的桌面端三维可视化系统：上帝视角俯瞰全村、点击物体查看档案、切第一人称漫游、一键自动巡游，场景的光照、云雾、降水、积雪与昼夜由岷县 2025 年全年真实逐小时气象记录驱动。

> 效果图：仓库根目录 `preview-01-晴天.png` ~ `preview-08-河边.png`；交付包内为 `预览图/01-晴天.png` ~ `08-河边.png`。

## 它是什么

- **虚构村落**：14 户民居、95 棵树、16 头牲畜、14 块耕地、13 处公共设施、9 件院落物件，另有 5 只村口石墩、1 座石碾、3 处水窖，共 **170 个档案对象**，每个都有独立档案卡。
- **完整河谷**：村西一条近南北向小河，宽 8 米、河床下切 2.2 米，水磨坊临河、河滩地退到东岸、漫水桥跨河；村东一座孤山，山腰有山神庙、40 级石阶和一棵庙前老槐。
- **真实天气**：岷县 2025 年全年 **8760 小时**气象数据（[Open-Meteo](https://open-meteo.com/)，CC BY 4.0），云量、降水、气温、风速都来自真实记录；“晴 / 阴 / 雨 / 雪”四个按钮直接从这 8760 条里现算极值时刻，不是写死日期。
- **连续昼夜**：太阳位置按赤纬 + 时角逐帧解算，日出日落是一条平滑曲线，不是按小时跳格。
- **可拖时间轴**：一年 35040 格（15 分钟/格），四档流速（一天 = 6 分 / 3 分 / 1 分 / 20 秒），默认 3 分钟一天。
- **画质三档**：流畅 / 均衡 / 精致，分别控制渲染像素比、GTAO、泛光与阴影贴图边长，选择记在 `localStorage`。
- **自动巡游**：6 个镜头、约 32 秒，低机位每帧贴地形 1.8 米，Esc 或点任意处中断。
- **桌面端离线**：全部资源内联进单个 HTML，双击即开，不联网、不用服务器。

> 第一人称街景见 `preview-05-第一人称街景.png`（交付包内 `预览图/05-第一人称街景.png`）。

## 快速开始

### 运行环境（最低配置）

| 项目 | 最低 | 建议 |
|---|---|---|
| 操作系统 | Windows 10 / macOS 11 | 近三年系统版本 |
| 浏览器 | Chrome / Edge 100+、Safari 15+ | 最新版 Chrome 或 Edge |
| 内存 | 8 GB | 16 GB |
| 显卡 | 集成显卡（Intel Iris / Apple 核显） | 独立显卡或 Apple M 系列 |
| 硬盘 | 约 30 MB 空闲 | — |
| 网络 | 不需要 | — |

仅支持桌面端；触屏设备可用虚拟摇杆，但拖拽旋转与档案卡体验不完整。完整说明见《管理员手册》2.1。

### 方式一：下载成品（推荐）

到仓库的 **Releases** 页面下载最新版本的 `Liushugou-Village-x.y.zip`，解压后双击 `柳树沟村.html`。

### 方式二：从源码构建

需要 Node 18+。

```bash
npm install
node tools/build-standalone.mjs     # 生成 柳树沟村.html
```

本地调试（源码版走 ES Module，必须经 HTTP）：

```bash
npx serve .        # 或 python3 -m http.server 8099
# 打开 http://localhost:8099/index.html
```

## 操作

| 操作 | 方式 |
|---|---|
| 旋转 / 缩放 | 左键拖动 / 滚轮（触控板双指） |
| 看档案 | 点击任意物体，点空白处关闭 |
| 第一人称 | `F` 进入，`Esc` 退出；`WASD` / 方向键 / 虚拟摇杆移动，`Shift` 加速 |
| 自动巡游 | 右下角「巡游」；`Esc` 或点画面任意处中断 |
| 暂停时间 | `空格` |
| 调时间 | 拖底部时间条，或切右侧速度档 |
| 典型天气 | 时间轴右侧「晴 / 阴 / 雨 / 雪」按钮，跳到当年真实出现过的对应时刻 |
| 画质 | 右下角流畅 / 均衡 / 精致三档，顶部实时显示帧率 |

调试参数：`?day=131&hour=10&pause=1`、`?speed=0..3`、`?quality=low|mid|high`、`?ao=1`、`?nopost=1`、`?qa=1`，完整列表见《管理员手册》。

## 目录

```
js/          源码：main / world / environment / climate / controls / ui / tour / data / textures / assets
css/         界面样式
data/        岷县 2025 逐小时气象（8760 条）
assets/      HDRI 与 PBR 扫描贴图
vendor/      three.js r160 及后处理
tools/       构建、打包、发布、截图与自检脚本
docs/        四份项目文档（Word + Markdown 源稿）、效果图
docs/软著/   软件著作权登记材料（操作步骤 / 源代码 / 说明书 / 过程记录）
LICENSE     本项目自有代码的 MIT 许可
THIRD_PARTY_NOTICES.md  第三方组件、素材与数据来源及许可
```

## 文档

| 文档 | 内容 |
|---|---|
| [管理员手册](docs/01-管理员手册.docx) | 怎么用、怎么演示、出问题怎么修 |
| [项目手册](docs/02-项目手册.docx) | 做了什么、怎么做的、技术方案 |
| [项目目录](docs/03-项目目录.docx) | 每个文件在哪、干什么 |
| [项目日志](docs/04-项目日志.docx) | 开发过程、踩过的坑、问题台账 |
| [预览图参数](docs/预览图参数.md) | 8 张预览图的固定时刻、机位、画质与 SHA-256 校验 |

## 版本与发布

每个版本对应一个 git tag 与一条 GitHub Release，Release 里附可直接运行的 zip。

```bash
./tools/release.sh 1.1 "新增村民日常动线"
```

脚本会：更新 `VERSION` → 追加 `CHANGELOG.md` → 构建单文件版与交付 zip → 提交 → 打 tag → 推送 → （装了 `gh` 时）创建 Release 并上传 zip。

第一次把仓库发布到 GitHub、以及不装命令行工具时的发布流程，见 [发布指南](docs/发布指南.md)。

只打包不发布：

```bash
./tools/package.sh          # 产物在 dist/
```

## 数据与素材

- 气象：[Open-Meteo](https://open-meteo.com/) 历史档案（**CC BY 4.0，需署名**），岷县 2025-01-01 ~ 12-31。
- 贴图与环境光：[Poly Haven](https://polyhaven.com/license)（CC0 1.0）。
- 三维引擎：[three.js](https://github.com/mrdoob/three.js) r160（MIT），未修改源码。
- 村落、住户、牲畜数据：全部虚构，仅用于演示。

> **气象数据署名**：Weather data by [Open-Meteo.com](https://open-meteo.com/) — CC BY 4.0。
> 数据按时间轴读取并映射为渲染参数，原始数值未改动。完整说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可

本项目自有代码（`js/`、`css/`、`index.html`、`tools/`）及原创文档采用 [MIT License](LICENSE)。

`vendor/`（three.js）、`assets/`（Poly Haven）、`data/`（Open-Meteo）**不属于**上述 MIT 授权范围，
各自按其原许可使用，署名与义务详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 已知限制

只支持桌面浏览器；没有村民角色；没有电线杆与架空线；建筑为构件拼装而非高模；无音频；气象为 2025 历史数据，暂不支持实时天气。
