# TLI Architecture Overview

TLI is a local-first AI platform.

No cloud dependency.

---

## High Level

Browser UI  
↓  
FastAPI Backend  
↓  
Bundled llama.cpp runtime  
↓  
GGUF model  

Optional fallback:

LM Studio (if enabled)

---

## Directory Layout

TheLegatoIntelligence/

- backend/
- frontend/
- modules/
- data/
- docs/
- ai/runtime/
- ai/models/
- ai/prompts/

---

## Backend

Python + FastAPI

Responsibilities:

- Model health
- Prompt loading
- Chat routing
- Streaming tokens
- Session management

---

## Frontend

HTML + CSS + JS

Responsibilities:

- Chat UI
- SSE consumption
- Formatting
- Continue handling
- Provider detection

---

## AI Providers

Priority order:

1. Bundled llama.cpp
2. LM Studio (optional)

Bundled is always preferred.

---

## Prompts

Runtime prompt:

backend/ai/prompts/system_default.txt

Panel rules:

backend/ai/prompts/panel_rules/

Docs live in /docs only.

---

## Philosophy

Offline-first  
Technician-grade  
Human readable  
Resilient UI  
Explicit failure handling
