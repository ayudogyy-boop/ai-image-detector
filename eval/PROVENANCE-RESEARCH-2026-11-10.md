# AI 图片水印调研与 2.2 改进记录

核实日期：2026 年 11 月 10 日。结论基于本轮读取的厂商官方文档、项目维护者仓库与实际本机验证。

**推荐路线是“验证来源、展示自述、谨慎估计”三层。** 通用视觉模型不能代替厂商水印验证，开源水印编码器也不能读取所有公司的私有水印。2.2 已把这三层落到代码和界面：本地 C2PA 真验签、压缩/结构化标识读取、清晰的验证状态与手动官方入口。原视觉模型保留，未声称其准确率提高。

## 三种标识的差别

| 方式 | 保存在哪里 | 能做什么 | 不能据此推出什么 |
|---|---|---|---|
| 可见角标/文字 | 图片像素 | 告诉人类“AI 生成”；有时可配置 | 角标可能被裁掉或后加，不能当作密码学证据 |
| C2PA / IPTC / AIGC 元数据 | 文件结构或清单 | 描述来源、工具、操作；C2PA 可验证签名和资产绑定 | 有元数据不等于已验签；有签名也不证明画面中事件真实 |
| SynthID / Content Seal 等隐形像素水印 | 生成图像自身 | 使用对应检测器识别特定生成体系的水印 | 不是搜索 EXIF 字串；没有检出不等于真人拍摄，也不能靠通用模型“读出” |

## 厂商现状与本扩展的处理

| 厂商/产品 | 一手资料确认的情况 | 对本扩展的结论 |
|---|---|---|
| OpenAI | 官方来源核验支持图像中的 C2PA 和 SynthID，提供网页及 API；明确仅检查受支持的 OpenAI 信号，not_detected 不能排除 AI | C2PA 在本地验证；SynthID 不假装本地支持，提供手动入口。无需把 API 密钥放进扩展，也不自动上传图片。[官方文档](https://developers.openai.com/api/docs/guides/content-provenance) |
| Google / Gemini / Imagen | SynthID 将不可见标记嵌入媒体，官方现提供公众核验门户；覆盖 Google 与其支持伙伴，仍有支持范围 | 提供 Google 官方核验入口，不采用第三方“模板就能破解 SynthID”的说法。[DeepMind](https://deepmind.google/models/synthid/) |
| Meta / Muse Image | 官方称 Muse Image 使用 Content Seal 隐形水印，并提供预览核验工具 | Meta 的开源水印研究与其生产系统不能画等号；提供官方手动入口。[官方介绍](https://ai.meta.com/blog/introducing-muse-image-muse-video-msl/) |
| Adobe / Firefly | 自动为完全由 Firefly 生成的资产附加 Content Credentials，包含签发方、工具及操作；部分凭证可保存在云端 | 本地解析和验证嵌入的凭证；不假装已读取云端恢复凭证。[Adobe 文档](https://helpx.adobe.com/firefly/web/get-started/learn-the-basics/content-credentials-overview.html) |
| 字节 / 火山引擎 / 即梦相关接口 | 官方图像接口有显式水印配置及 AIGC 隐式标识参数；MediaKit 文档区分 Label 1=生成、2=可能、3=疑似，并列出提供者与内容编号 | 新增结构化 AIGC 自述读取。只把 Label 1 作为明确自述，2/3 保留原语义，不把所有版本/导出渠道视作同一水印方案。[图像接口](https://docs.volcengine.com/docs/large-model-of-image-generation/universal-30-text-to-image?lang=zh)、[标识字段](https://docs.volcengine.com/docs/intelligent-processing/add-aigc-metadata-guide?lang=zh) |
| 阿里 / 通义万相 | 文生图 API 的 watermark 描述是右下角“AI生成”的可见文字；另有 AIGC 标识服务，官方示例使用结构化 Label、ContentProducer 等字段 | 可见角标不等于像素隐形水印。本扩展补通用 AIGC 字段；不承诺读取阿里专有暗水印。[万相 API](https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference)、[AIGC 标识服务](https://help.aliyun.com/zh/sase/getting-started/aigc-image-logo-add-guide) |

不能从某个产品的默认行为推到所有 API、历史版本、转存图片、截图和编辑产物。对于 Midjourney、各类 FLUX 自托管模型等，本轮未获得足够的一手依据来建立统一、稳定的本地水印读取承诺，因此不编造“通用厂商水印特征”。

## GitHub 项目对照

以下仅比较实际读取的公开仓库说明/源码；没有把各项目作者的 benchmark 当作本扩展的实测准确率。

| 项目 | 实际用途 | 本项目采用/不采用的判断 |
|---|---|---|
| [contentauth/c2pa-js](https://github.com/contentauth/c2pa-js/tree/main/packages/c2pa-web) | 官方 WebAssembly C2PA 读取与签名验证 | **已采用**固定版本 0.16.0。整资产验证、active manifest、Reader 释放、离线信任快照；原来的品牌扫描不再参与决策 |
| [microsoft/c2pa-extension-validator](https://github.com/microsoft/c2pa-extension-validator) | 浏览器 C2PA 验证扩展原型 | 借鉴“来源验证是独立能力”。其维护者说明是开发预览，不能直接当作可生产替换品 |
| [contentauth/c2pa-conformance-tool](https://github.com/contentauth/c2pa-conformance-tool) | 在浏览器用 WASM 校验清单及信任列表 | 借鉴验证状态与官方/历史信任体系的区别；本扩展采用官方列表快照，不悄悄放宽为历史/测试证书 |
| [UniversalFakeDetect](https://github.com/WisconsinAIVision/UniversalFakeDetect) | CLIP ViT-L/14 特征与检测头，研究跨生成器泛化 | 值得作为后续候选；其完整特征骨干不是“小检测头”的体积。当前没有经过本扩展 ONNX/浏览器和现代独立测试集验证，未直接换上 |
| [NPR-DeepfakeDetection](https://github.com/chuangchuangtan/NPR-DeepfakeDetection) | 邻域像素关系检测，作者给出 PyTorch 网络和权重 | 值得优先评测的低层像素候选。必须保留其专用预处理，不能套用现有 224×224 ViT 流程；尚未转换/验证可发布的浏览器版本 |
| [facebookresearch/stable_signature](https://github.com/facebookresearch/stable_signature) | 给特定扩散模型植入并提取签名 | 检测其自身方案，不是所有 SD/FLUX/OpenAI 图像的通用识别器；不直接接为通用水印检测 |
| [facebookresearch/watermark-anything](https://github.com/facebookresearch/watermark-anything) | 局部水印嵌入与消息提取；仓库已归档 | 研究可参考，但它的权重/消息系统不等于 Meta 生产 Content Seal，也不是 SynthID 读取器 |
| [Rinne414/SynthID-detector](https://github.com/Rinne414/SynthID-detector) | 浏览器水印模板实验及其他检测路线 | **不采用模板检测**：作者明确披露原模板方法在 held-out 新图上失效，演示高分不能证明泛化 |
| [lynote-ai/ai-image-detector](https://github.com/lynote-ai/ai-image-detector) | CLI/API/Web UI，组合多个概率检测后端及评测 | 可借鉴后端对照和把概率输出当信号的产品表达；Python/多模型组合不能直接搬进小型本地悬停扩展 |
| [bythebug/AI-Image-Detector](https://github.com/bythebug/AI-Image-Detector) | 本地元数据/来源启发式，实验性 JUMBF 扫描 | 表明纯前端可行，但不能解决本项目原有“EXIF 可伪造、字符串不是验签”的核心问题，因此没有照搬其分数 |

## 已实施的 2.2 改进

1. **本地真验签**：增加官方 SDK、WASM、显式同源 worker。禁用远端清单获取和 OCSP，不使用运行时 CDN。信任列表快照来自 C2PA 官方公共仓库，有日期、来源与哈希。SDK 的 HTTPS-only worker 检查作了可复建、精确断言的同源扩展兼容补丁，未放宽扩展 CSP。
2. **结果分层**：只解释已验证 active manifest 的受控 AI 动作；trusted AI 才显示“已验证 AI 生成/编辑声明”。Valid 显示“签名有效但来源未受信任”。不再把品牌词、相机型号、IPTC digitalCapture 或不存在的水印直接变为“可信”。
3. **来源自述保留价值**：明确生成参数、工具名字段、IPTC AI 类型、AIGC Label=1 仍展示，但注明未验签；与模型倾向非 AI 时采取黄色，避免伪装成确定结论。
4. **少误报的结构读取**：SD 需要步骤/采样器/种子或 CFG 等组合；ComfyUI 需要解析 JSON 与采样器节点。描述中提工具、一般 nodes 字段、普通 algorithmicMedia 不直接判 AI。
5. **读取能力**：支持原生有界解压 PNG zTXt/压缩 iTXt，累计最多 1MB、16 块；完整文件已下载时可读取后置块。添加 JPEG APP11、PNG、XMP 等来源中的国内 AIGC 字段读取。
6. **资源预算**：最多两张图并发分析，推理串行；超限/断流不使用截断资产推理或验签。只开元数据且关闭 C2PA 时仍只取 512KB。
7. **模型边界保持**：移除了“没有 C2PA=中性 50”的伪特征，同时用等效整数阈值保留旧版缺省模型边界。不是在 240 张上重调阈值，也不是调整 AUC；有覆盖所有整数分数与灵敏度档位的等价检查。
8. **清晰交互**：绿标改成“模型偏非 AI”，未知与读取失败显示无法判断。详情显示证书过期/资产哈希不匹配等状态；官方入口不附图片/URL，用户自行上传。

完整规则在 [CLAUDE.md](../CLAUDE.md)，SDK 与公有信任数据的来源在 [SOURCES.md](../lib/c2pa/SOURCES.md)。

## 验证与局限

真实 Chrome 中已验证：

- 官方 SDK 样本 `C.jpg` 返回 **Valid**，测试签发方未被官方列表信任；它声明 algorithmicMedia，未被误标为 AI 生成。
- 既有 Nikon 样本返回证书过期/未受信任；原图没有资产哈希错误，改动像素后的版本增加 `assertion.dataHash.mismatch`。
- 普通照片插入 `jumb Adobe Firefly` 字符串返回未发现有效清单，不再直接判 AI。
- trusted AI 的策略正向检查用明确标注的合成 SDK 返回对象验证；本轮没有取得厂商签发、覆盖当前生成器的完整 trusted-AI 原图样本集，因此不把该单元检查当作厂商水印检出率。

模型仍是原来的 ViT。原评测集是老生成器/混合艺术作品集，不能测量 SynthID 或 Content Seal 的检出率。新规则的效果应看“来源验证是否真实、是否拒绝伪造、解释是否准确”，而不是声称已做到通用 AI 图片鉴定。

尚需后续工作的边界：现代生成器与编辑链路的独立评测集、NPR/CLIP 类候选的浏览器转换和代表性对照、更多格式/命名空间、blob/鉴权图源、大像素解码预算与手机逐图交互。官方云核验 API 本轮未接入，保持原本地隐私边界。

## 同一数据集前后对照

240 张，AI/真实各 120 张；前后均无推理错误。保持模型文件与预处理不变。

| 指标 | 2.1 基线 | 2.2 最终策略 |
|---|---:|---:|
| 原始模型 AUC | 0.6527 | 0.6527 |
| 真图标红 | 7/120，5.83% | 7/120，5.83% |
| AI 图标绿 | 9/120，7.50% | 9/120，7.50% |
| 弃权 | 175/240，72.92% | 177/240，73.75% |
| AI 图标红 | 19/120 | 17/120 |
| 明确结论正确率 | 49/65，75.38% | 47/63，74.60% |
| 中位耗时 | 495ms | 511ms |

两张图片原先仅靠未验签工具声明被标红，现在变成明确的未验签自述/不确定。这批图片恰好标注为 AI，因此少了两次正确红标，不能说新版本提高了该数据集上的检出率。保留这项代价，是为了不把可伪造声明冒充签名验证。

最终模型阈值为 medium 绿≥61 / 红<29，以等效整数边界代替旧版对“无 C2PA=50”的加权；完整回归检查验证了三档数学边界。一次中位耗时差 16ms 不足以说明显著性能变化。

本地原始结果：`results/current-provenance-before-2026-11-10T11-30-25.json`、`results/current-provenance-final-2026-11-10T11-47-52.json`，按约定不入库。中间试验 `provenance-after` 暴露了移除伪权重后模型边界会意外放宽，已通过等效边界修正；历史结果未覆盖。

## 交付验证

- 57 项元数据单测、14 项工程回归、18 项溯源策略/资源检查、29 项 Node/Chrome 流水线、41 项扩展真机检查通过，共 159 项不同检查。
- 最终 `ai-image-detector-v2.2.0.zip` 解压安装后，同一组 41 项真机检查通过，包含有效签名正向对照、过期、像素篡改与伪造关键词。
- 同源 worker、打包引用、全部自有 JS 语法、快照哈希与 `git diff --check` 通过。
- 离线验签组件约 9.2MB，按需加载；ZIP 从约 14MB 增到约 17MB。模型未替换，未引入图片上传。
- CI 配置未改；当前工作流直接调用旧单测入口，新增纯 Node 回归需后续授权接入。源码与本地构建产物已更新，未提交或发布。
