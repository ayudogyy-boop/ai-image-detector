# AI Image Detector 项目约定

Chrome Manifest V3 扩展，当前 **2.2.1**。图片与模型推理、来源验证都在本地；官方专有水印核验由用户自行访问外部入口，不自动上传。

## 本轮已授权范围

用户已要求调研厂商水印和 GitHub 检测项目并据此优化。已实施离线 C2PA 资产绑定与签名验证、未验签声明降级、结构化生成参数、PNG 压缩文本、国内 AIGC 标识、统一评分和官方手动核验入口。CI、密钥、全局配置、删除和发布仍按上级规则处理。

## 目录与职责

- `manifest.json`：MV3 入口，scoring 先于 content 加载。
- `src/background.js`：offscreen 生命周期和消息路由，不处理图片。
- `src/offscreen/offscreen.js`：单次下载供元数据/模型/验签共享，最多两张图并发，模型推理串行。
- `src/offscreen/verify-c2pa.js`：延迟初始化本地 SDK 与同源 worker；关闭远端清单和 OCSP 请求。验签（含初始化和释放）限时 15 秒，超时终止共享 worker、让受影响请求降级，后续请求重新初始化；SDK worker 初始化另有 12 秒上限。
- `src/shared/metadata.js`：容器/EXIF/XMP/PNG/JPEG/WebP 与 AIGC 解析；`summarizeBytesAsync` 有界解压文本；`judgeMetadata` 仅提取未验签 AI 自述。
- `src/shared/provenance.js`：只解释 SDK 验证后的 active manifest，不从品牌名猜生成器。
- `src/shared/scoring.js`：`scoreAnalysis` 是 content 与 eval 的唯一决策入口。
- `src/content/`：发现图片、请求分析、缓存、画徽章和按图片统计。
- `lib/`、`models/`：随包 ORT 与 ViT；`lib/c2pa/` 放锁定 SDK、worker、WASM、公开信任列表、许可和来源记录。
- `build/vendor-c2pa.mjs`：从锁定 npm 依赖复建本地组件；只有 `--update-trust` 联网更新官方快照。
- `build/build.sh`、`build/check-package.mjs`：打包与入口/相对引用自检；产物放被忽略的 `build/artifacts/`。
- `eval/`：测试、评测、调研和历史审查。data/models/results 不入库，结果不得覆盖历史。

## 证据规则

1. trusted C2PA 且 active manifest 有受控 AI 动作才显示“已验证 AI 声明”。Valid 仅代表签名与绑定有效、签发方未受信任；Invalid 不提供可依赖的 AI 来源结论。
2. 有效相机声明也不证明画面真实。未验签 C2PA 关键词、相机 EXIF、IPTC digitalCapture 不得直接发绿标。
3. 工具字段、明确 SD 参数/ComfyUI 采样器结构、IPTC AI 类型及 AIGC Label=1 显示未验签声明，不冒充已证实；Label 2/3 不升级成确定生成。
4. 自由文本提及工具、普通 nodes 字段、程序绘图 algorithmicMedia、尺寸和“没有元数据”都不是直接 AI 证据。
5. 模型估计保持可选；绿标写“模型偏非 AI”，分数不称真实性概率。没模型/证据就弃权，不能用相机字段独自补绿。
6. SynthID / Content Seal 本地未支持，始终明确未核验；不集成在独立测试上失效的模板检测器。
7. C2PA 使用完整文件。超限或读取中断时不拿截断文件验签/推理。只读头部的元数据路径保持容错，默认 512KB；完整文件最多 40MB。文本解压最多 1MB、16 块。
8. 离线信任列表有日期和 SHA-256；不自动更新，不宣称实时吊销检查或 C2PA 官方认证。
9. 用户指定的模型展示分数颜色固定为：小于 40 红色、40–60（含边界）黄色、大于 60 绿色。旧 sensitivity 设置保留读取兼容，但不再改变颜色区间；设置页不再提供该开关。模型低分已呈红色时，未验签来源声明不得覆盖为黄色；没有有效模型结果时仍弃权，可信 AI 签名仍优先红色。

## 页面与缓存约定

- processed 仅用于统计/自动检测去重，不能禁止再次悬停。
- 换源、设置变化、鼠标离开后不显示旧异步结果；设置代次隔离缓存与请求锁。
- 懒加载每图只绑定一次；扫描暂停后必须能由可见性/设置事件恢复。
- 图片监听器以 WeakSet 为准；DOM 标记会随 cloneNode 复制，不能据此跳过绑定或认定已分析。
- 徽章详情转义来自文件的文本，外链固定为官方入口，noopener/noreferrer，不附图片或页面 URL。
- 模型首次启动失败后，实际推理请求可按需重试；启动请求共享、相邻尝试至少间隔 3 秒。推理运行时失效时释放 session，让后续请求重建；图片解码错误不得无故重载模型。
- 请求的模型未返回有效结果时，不缓存为十分钟成功结果。未取得任何检测结论时使用灰色“未完成”状态与空分数，和模型 40–60 的黄色区间区分；可信/未验签声明仍分别可独立红/黄。
- 错误详情区分图片请求/超限/超时/解码、模型加载/初始化/推理及模型关闭，保留截断并转义的具体错误和扩展版本，不能一律提示“重新悬停重试”。

## Model details
- **Source**: `onnx-community/ai-image-detect-distilled-ONNX` → `onnx/model_q4.onnx`
- **本地文件 sha256** = `d6a0ad89…18247`，与上游 LFS oid **完全一致**（已核对）
- **Architecture**: Distilled ViT，11.8M 参数，8 层，hidden 384
- **Input**: 224×224 RGB，pixel → [-1,1]（mean=std=0.5），无 center crop，与 `preprocessor_config.json` 一致
- **Output**: logits [batch, 2]，**class 0 = fake**，1 = real（已核实 `config.json` 的 id2label）
- **训练数据**: Google Open Images（真）vs BLIP 描述 + SD 生成图 + Midjourney v4（假），2022–2023 年代
- **模型卡**: 验证集 74% / 真实世界集 72%
- **本机实测（n=240，用户指定 40/60 区间）**: AUC **0.653**、最优阈值准确率 61.3%、弃权 47.9%、真图红标 33/120；阈值改变不代表模型能力增强，详见 eval/README.md。
- **量化档位实验（2026-10-19）**: Q4 / q4f16 / int8 / fp16 / fp32 五档 AUC 差异 < 0.003，
  最优阈值准确率全是 61.3%。**74% → 61% 不是量化造成的，换量化解决不了任何问题。**
  另外 `fp16` 与 `q4f16` 在 ORT-web 1.27 的 `graphOptimizationLevel:'all'` 下无法加载，需要在 `basic` 下跑。

## 测试与评测

```bash
npm run test        # 元数据、工程、溯源、对抗性故障注入及流水线回归
npm run test:ext    # 59 真机检查：含验签、模型/worker 故障恢复、失败缓存及 40/60 徽章
npm run eval        # 浏览器使用同一元数据/验签路径 + scoreAnalysis，n=240
npm run build       # 本地验证包，不是发布
```

- 改检测策略前先保存基线，改完按同一数据集复测；模型原始 AUC 和最终颜色指标分别报告。
- 不复制评分或验签逻辑到测试台。涉及 worker、WASM、CSP 的修改必须把最终 ZIP 解压后真正装进 Chrome 验证。
- 测试不依赖未入库数据；SDK 正向夹具有来源、哈希与许可记录。
- 模型仍较弱，旧评测数据不能替代现代生成器与原图/压缩/截图/AI 编辑的分组评估。未经代表性实测不替换模型、不以调阈值冒充能力提升。

## 文档与已知局限

当前调研、实现取舍、指标见 `eval/PROVENANCE-RESEARCH-2026-11-10.md`；随后对抗性审查与待决策项见 `eval/ADVERSARIAL-REVIEW-2026-11-10.md`。`eval/AUDIT-2026-11-10.md` 是上一轮快照，保留历史，不作为当前规则。

仍有：本地专有水印检测缺失、现代独立评测集不足、远端清单/在线吊销不验证、部分格式/命名空间和后置数据可能遗漏、超大像素解码内存预算、手机逐图交互、blob/鉴权图读取等边界。不要承诺通用 AI 检测准确率。
