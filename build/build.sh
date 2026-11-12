#!/bin/bash
# build.sh — 构建可发布 ZIP 包
#
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="ai-image-detector"
VERSION=$(node -p 'require("./manifest.json").version')
OUTPUT_DIR="${BUILD_OUTPUT_DIR:-build/artifacts}"
mkdir -p "${OUTPUT_DIR}"
OUTPUT_DIR=$(cd "${OUTPUT_DIR}" && pwd)
OUTPUT="${OUTPUT_DIR}/${NAME}-v${VERSION}.zip"
WORK=$(mktemp -d)
STAGE="${WORK}/extension"
trap 'rm -rf "${WORK}"' EXIT

echo "▶ 构建 ${OUTPUT}"

mkdir -p "${STAGE}"/{icons,models,lib,docs,src/{shared,content,popup,options,offscreen}}

cp manifest.json LICENSE NOTICE "${STAGE}/"
cp docs/LICENSING.md "${STAGE}/docs/"
cp icons/icon*.png "${STAGE}/icons/"
cp src/background.js "${STAGE}/src/"
# offscreen 用 metadata；content script 用 scoring。
cp src/shared/metadata.js src/shared/scoring.js "${STAGE}/src/shared/"
cp src/shared/provenance.js "${STAGE}/src/shared/"
cp src/shared/contracts.js "${STAGE}/src/shared/"
cp src/content/styles.css "${STAGE}/src/content/"
cp src/content/content.js "${STAGE}/src/content/content.js.src"
cp src/popup/* "${STAGE}/src/popup/"
cp src/options/* "${STAGE}/src/options/"
cp src/offscreen/* "${STAGE}/src/offscreen/"
# ONNX Runtime + 模型
cp lib/ort.wasm.min.js lib/ort-wasm-simd-threaded.mjs lib/ort-wasm-simd-threaded.wasm "${STAGE}/lib/"
cp lib/ONNXRUNTIME-LICENSE.txt lib/ONNXRUNTIME-ThirdPartyNotices.txt lib/ONNXRUNTIME-SOURCES.md "${STAGE}/lib/"
cp -R lib/c2pa "${STAGE}/lib/"
cp models/detector.onnx "${STAGE}/models/"
cp models/SOURCES.md "${STAGE}/models/"

# content.js 结构特殊（体积大、不影响调试），默认压缩；scoring.js/metadata.js 保持原样以便审阅
if npx --no-install terser --version >/dev/null 2>&1; then
  echo "  minify content.js"
  npx terser "${STAGE}/src/content/content.js.src" -o "${STAGE}/src/content/content.js" --compress --mangle
else
  echo "  terser 不可用，content.js 不压缩"
  cp "${STAGE}/src/content/content.js.src" "${STAGE}/src/content/content.js"
fi
rm -f "${STAGE}/src/content/content.js.src"

for js in "${STAGE}/src/"*.js "${STAGE}/src/"*/*.js; do
  node --check "${js}"
done
node build/check-package.mjs "${STAGE}"

# 每次从空归档构建，避免 zip 更新模式保留上次构建的废弃条目。
( cd "${STAGE}" && zip -qr "${WORK}/package.zip" . -x "*.DS_Store" )
mv "${WORK}/package.zip" "${OUTPUT}"
echo "✓ 已生成 ${OUTPUT}（$(du -h "${OUTPUT}" | cut -f1)）"
