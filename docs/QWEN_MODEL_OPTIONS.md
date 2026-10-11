# Optional Qwen3 models

Added 2026-09-06 as optional text models. The existing Standard default and all
Qwen2.5 presets remain available. No model or runtime is automatically replaced.

| Choice | Published quantization | Download bytes | Estimated minimum total RAM |
|---|---|---:|---:|
| Qwen3 1.7B | Q8_0 | 1,834,426,016 | 8 GiB |
| Qwen3 4B | Q4_K_M | 2,497,280,256 | 12 GiB |
| Qwen3 8B | Q4_K_M | 5,027,783,488 | 16 GiB |

The 1.7B publisher repository provides Q8_0. TLI does not label that file as
Q4_K_M. Requirements are conservative estimates, not measured performance.
Current available memory and model-folder free space are checked independently.

## Artifact and runtime evidence

- [Qwen3 1.7B publisher repository](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF)
- [Qwen3 4B publisher repository](https://huggingface.co/Qwen/Qwen3-4B-GGUF)
- [Qwen3 8B publisher repository](https://huggingface.co/Qwen/Qwen3-8B-GGUF)
- [Qwen's llama.cpp support documentation](https://github.com/QwenLM/Qwen3/blob/main/docs/source/run_locally/llama.cpp.md)

Each catalogue entry pins a publisher revision, filename, byte size and LFS
SHA-256 from the Hugging Face model API. HEAD requests to all three pinned URLs
returned HTTP 200 and the expected content lengths. No weight bodies were
downloaded during development.

Qwen documents architecture support beginning at llama.cpp b5092. TLI also
requires Jinja template parameters, reasoning-budget and reasoning-format
controls. A version number alone does not establish compatibility. The actual
bundled Windows runtime reports b7896 and advertises these controls. This was
checked with bounded `--version` and `--help` commands without starting inference.

Runtime checks are local, cached for at most a minute, and invalidated by changes
to executable size or modification time. Old or unidentified runtimes do not
receive an automatic upgrade. Downloads for these presets stay disabled until
runtime support can be established; the backend enforces the same check.

## Runtime behavior and compatibility

- Use a 4096-token context and non-thinking mode for these new presets.
- Send the template's `enable_thinking=false`, set reasoning budget to zero,
  and keep any reasoning output separate from the answer field. Existing SSE
  fields and the existing presets' launch arguments remain unchanged.
- Verify the checksum while downloading, before publishing files. A failed hash
  or size check retains previous files and the existing selected model.
- Check the publisher checksum again when selecting a manually placed or
  imported file with a curated filename, before stopping the current runtime.
  This check has a 120-second bound; failure or timeout leaves inference intact.
- Keep the existing startup/inference trial and failed-switch recovery.
- New persisted selections use the same `preset_id` and `filename` JSON fields.
  Older code will not know the new preset IDs; select a legacy preset before
  intentionally rolling back to code without this catalogue.

## Why Qwen3.5 remains deferred

[llama.cpp b7973](https://github.com/ggml-org/llama.cpp/releases/tag/b7973) introduced
Qwen3.5 text architecture support, after this installation's b7896 runtime.
A later checkpoint must validate a suitable complete runtime bundle, its DLLs
or shared libraries, existing-model behavior, vision dependencies if requested,
and restoration of the previous bundle. This checkpoint does not upgrade it.

## Validation limits

Publisher metadata and runtime controls were checked. Isolated tests use fake
model bytes, downloads and processes for checksums, runtime gating, launch
arguments, stream continuity and recovery. Real-model quality, speed, and startup
on Windows/macOS/Linux hardware have not been benchmarked. The UI states this;
an installation still has to pass its own startup and inference trial.
