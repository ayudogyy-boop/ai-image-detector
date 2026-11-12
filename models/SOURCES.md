# Bundled detector

- File: `detector.onnx`, the upstream `onnx/model_q4.onnx` file, unchanged.
- Publisher: [onnx-community/ai-image-detect-distilled-ONNX](https://huggingface.co/onnx-community/ai-image-detect-distilled-ONNX).
- Base model: [jacoballessio/ai-image-detect-distilled](https://huggingface.co/jacoballessio/ai-image-detect-distilled).
- SHA-256: `d6a0ad89d7fd55ee9e282d9cefd466d3c17d2c5ad1baec2ed6192494e3618247`.
- License evidence checked on 2026-11-12: the publisher's [model card](https://huggingface.co/onnx-community/ai-image-detect-distilled-ONNX/blob/main/README.md) declares `license: mit` and identifies the base model. This declaration is recorded separately from our own MIT copyright.

Pending review: a complete model-specific license/copyright notice has not been archived here. The model-card declaration is not a substitute for that text or for the rights of the underlying training images. Before external distribution or commercial delivery, obtain and archive the upstream notice and review the model/data rights. Do not fabricate a copyright holder or apply the project's own copyright to the weights.

The model remains the same Q4 ViT. Neither these source notes nor the 2.2.2 settings/message changes improve its detection accuracy. Existing accuracy limits are documented in the project README and eval reports.
