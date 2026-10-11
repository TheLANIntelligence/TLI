"""Optional Qwen3 choices, pinned to publisher artifacts inspected 2026-09-06.

These are text models. Hardware fit is estimated; activation still requires
the existing bounded startup and inference checks. No default replacement.
"""

QWEN3_PRESETS = {}
for ident, label, filename, size, ram, revision, checksum, quant in (
    ("qwen3_1_7b", "1.7B", "Qwen3-1.7B-Q8_0.gguf", 1834426016, 8,
     "90862c4b9d2787eaed51d12237eafdfe7c5f6077", "061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a", "Q8_0"),
    ("qwen3_4b", "4B", "Qwen3-4B-Q4_K_M.gguf", 2497280256, 12,
     "bc640142c66e1fdd12af0bd68f40445458f3869b", "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5", "Q4_K_M"),
    ("qwen3_8b", "8B", "Qwen3-8B-Q4_K_M.gguf", 5027783488, 16,
     "7c41481f57cb95916b40956ab2f0b139b296d974", "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785", "Q4_K_M"),
):
    repo = f"Qwen/Qwen3-{label}-GGUF"
    QWEN3_PRESETS[ident] = {
        "id": ident, "name": f"Qwen3 {label} (Optional)", "family": "Qwen3", "tier": ident,
        "description": "Optional text model. TLI uses non-thinking mode; check performance on this host before relying on it.",
        "filename": filename, "size_bytes": size, "size_human": f"{size / 1024**3:.2f} GB",
        "min_ram_gb": ram, "ctx_size": 4096, "license": "Apache 2.0", "quantization": quant,
        "url": f"https://huggingface.co/{repo}/resolve/{revision}/{filename}",
        "source_url": f"https://huggingface.co/{repo}", "revision": revision, "sha256": checksum,
        "min_runtime_build": 5092, "required_runtime_flags": ["--jinja", "--chat-template-kwargs", "--reasoning-budget", "--reasoning-format"],
        "non_thinking": True, "is_vision": False,
        "validation_note": "Publisher artifact and runtime requirements checked. See the dated answer evaluation below; performance on this host remains unverified.",
    }
