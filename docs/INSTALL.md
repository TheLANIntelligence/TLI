# TLI Installation Guide

Fresh machine setup.

---

## Requirements

Windows 10/11 64-bit  
Python 3.10+  
8GB RAM minimum (16GB recommended)

---

## Steps

1. Clone or extract TheLegatoIntelligence folder

2. Install Python dependencies

cd backend
pip install -r requirements.txt

---

3. Place GGUF model

Put your model here:

backend/ai/models/

Expected default:

phi-3.5-mini-instruct.Q4_K_M.gguf

---

4. Start backend

run_backend.bat

or

python main.py

---

5. Open browser

http://fox.local:8000  
or  
http://localhost:8000

---

## Verify

Visit:

/api/ai/status

Should return:

"healthy": true

---

If issues occur:

- Check backend console
- Check llama_server logs
- Confirm model path

---

TLI is now live.
