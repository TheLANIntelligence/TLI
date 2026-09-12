"""Pure preset-specific runtime options shared by TLI and isolated evaluation."""


def preset_runtime_args(preset):
    """Return a fresh argument list; never discover, download or launch anything."""
    if preset.get("non_thinking"):
        return ["--jinja", "--chat-template-kwargs", '{"enable_thinking":false}',
                "--reasoning-budget", "0", "--reasoning-format", "deepseek"]
    return []
