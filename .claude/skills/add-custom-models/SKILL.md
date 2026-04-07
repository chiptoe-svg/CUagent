---
name: add-custom-models
description: Enable custom model support — use local models (OMLX, Ollama) or any third-party model endpoint (HuggingFace, Together AI, Groq, etc.) alongside your primary agent SDK. Triggers on "custom models", "local models", "add custom", "add local".
---

# Add Custom Models

Enable support for custom model endpoints — local models, third-party providers, or self-hosted deployments. Uses the Codex SDK as the bridge to any OpenAI-compatible endpoint.

## Phase 1: Pre-flight

### Check if Codex SDK is installed

```bash
ls src/runtime/codex-runtime.ts 2>/dev/null && echo "CODEX_INSTALLED" || echo "CODEX_MISSING"
```

If `CODEX_MISSING`, the Codex SDK is required as the bridge for custom models. Invoke `/add-agentSDK-codex` first, then return here.

### Check current state

```bash
grep -q 'OMLX_URL\|LITELLM_URL' .env 2>/dev/null && echo "ENDPOINTS_CONFIGURED" || echo "NO_ENDPOINTS"
```

## Phase 2: Configure

### Explain to the user

> Custom models let you use any OpenAI-compatible endpoint alongside your primary agent SDK.
>
> This works by routing through the Codex SDK — when you select a custom model via `/model`, the system automatically uses Codex with the custom endpoint URL.
>
> Common endpoints:
> • **OMLX** — local models optimized for Apple Silicon (persistent KV cache, tool calling)
> • **Ollama** — easy local model hosting
> • **Together AI, Groq, Fireworks** — fast third-party inference
> • **HuggingFace Inference** — hosted open-source models
> • **Self-hosted vLLM, llama.cpp** — your own deployment
>
> Run `/add-model-endpoint` to add endpoints one at a time.

### Update available models in config

After running `/add-model-endpoint` for each desired provider, verify models appear in `/model` command output.

### Rebuild container

Only needed if this is the first time installing custom model support:

```bash
npm run build && ./container/build.sh
```

### Restart service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 3: Verify

Send `/model` in Telegram. You should see your custom models listed below the cloud models.

Switch to a custom model:
```
/model omlx/llama-3.1-8b
```

Send a message and verify it responds using the local/custom model.

Switch back:
```
/model gpt-5.4-mini
```

## Removal

Remove endpoint URLs from `.env` and remove the custom model entries from `AVAILABLE_MODELS` in `src/config.ts`. Rebuild and restart. The Codex SDK can remain installed.
