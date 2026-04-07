---
name: add-model-endpoint
description: Add a model endpoint — local (OMLX, Ollama) or remote (HuggingFace, Together AI, Groq, or any OpenAI-compatible URL). Triggers on "add endpoint", "add model", "model endpoint", "connect model".
---

# Add Model Endpoint

Connect a new model provider so its models appear in the `/model` command.

## Phase 1: Pre-flight

### Ensure custom models are enabled

```bash
ls src/runtime/codex-runtime.ts 2>/dev/null && echo "READY" || echo "NOT_READY"
```

If `NOT_READY`, tell the user to run `/add-custom-models` first.

## Phase 2: Select endpoint type

AskUserQuestion: What type of model endpoint?

1. **OMLX (local, Apple Silicon)** — Optimized for Mac. Persistent KV cache, tool calling, MCP support. Install: `brew install omlx`
2. **Ollama (local)** — Easy to use. Install: `brew install ollama` or https://ollama.com
3. **Remote URL** — Any OpenAI-compatible endpoint (Together AI, Groq, HuggingFace, Fireworks, self-hosted vLLM, etc.)

## Phase 3: Configure based on selection

### OMLX

1. Check if OMLX is installed and running:
```bash
curl -sf http://localhost:8000/v1/models 2>/dev/null | head -5
```

If not running, guide installation:
```bash
brew tap jundot/omlx https://github.com/jundot/omlx
brew install omlx
brew services start omlx
```

2. Check what models are available:
```bash
curl -sf http://localhost:8000/v1/models | python3 -c "import sys,json; [print(m['id']) for m in json.load(sys.stdin).get('data',[])]"
```

If no models, suggest downloading one:
```bash
# Models are downloaded on first use, or pre-download via OMLX admin UI at http://localhost:8000/admin
```

3. Add to `.env`:
```bash
grep -q 'OMLX_URL' .env || echo 'OMLX_URL=http://localhost:8000/v1' >> .env
```

4. Add models to `src/config.ts` under `AVAILABLE_MODELS.local`. Use the model IDs from the curl output above. Example:
```typescript
local: [
  { id: 'mlx-community/Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B (local)' },
],
```

### Ollama

1. Check if Ollama is running:
```bash
curl -sf http://localhost:11434/api/tags 2>/dev/null | head -5
```

If not running: `ollama serve` or check https://ollama.com for installation.

2. List available models:
```bash
ollama list
```

If none installed, suggest:
```bash
ollama pull llama3.1        # General purpose
ollama pull codellama       # Code focused
```

3. Add to `.env`:
```bash
grep -q 'OLLAMA_URL' .env || echo 'OLLAMA_URL=http://localhost:11434/v1' >> .env
```

Note: Ollama's OpenAI-compatible endpoint is at `/v1` (not the default `/api`).

4. Add models to `src/config.ts` under `AVAILABLE_MODELS.local`:
```typescript
local: [
  { id: 'llama3.1', name: 'Llama 3.1 (local, Ollama)' },
],
```

Note: For Ollama models, the OMLX_URL setting is used as the baseUrl. If using both OMLX and Ollama, you may need LiteLLM to route between them, or update the `/model` command to set the correct URL per model.

### Remote URL

1. Ask the user for:
   - Provider name (e.g., "together", "groq", "huggingface")
   - API base URL (e.g., `https://api.together.xyz/v1`)
   - API key (if required)
   - Model IDs they want to use

2. Add API key to `.env` if provided:
```bash
echo '<PROVIDER>_API_KEY=<key>' >> .env
```

3. Add to `.env` for LiteLLM routing:
```bash
grep -q 'LITELLM_URL' .env || echo 'LITELLM_URL=http://localhost:4000/v1' >> .env
```

Note: Remote endpoints that are OpenAI-compatible can be used directly via `baseUrl` without LiteLLM. Only endpoints with non-standard API formats need LiteLLM for translation.

4. Add models to `src/config.ts` under `AVAILABLE_MODELS.custom`:
```typescript
custom: [
  { id: 'together/meta-llama/Llama-3.1-70B', name: 'Llama 3.1 70B (Together AI)' },
],
```

## Phase 4: Build and verify

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

Send `/model` in Telegram. The new models should appear. Switch to one and send a test message.

## Removal

1. Remove the model entries from `src/config.ts` `AVAILABLE_MODELS`
2. Remove the URL and API key from `.env`
3. `npm run build` and restart service
