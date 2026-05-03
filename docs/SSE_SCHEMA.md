# TLI SSE Streaming Schema

Endpoint:

POST /api/ai/chat/stream

Used when Bundled AI is active.

---

## Request Body

{
  "message": "user input",
  "conversation_id": "optional",
  "temperature": 0.2,
  "max_tokens": 450
}

---

## Stream Format

Server sends Server-Sent Events.

### Token chunk

data: {"token":"Hello"}

Repeated until complete.

---

### Metadata event

event: meta  
data: {"conversation_id":"abc123"}

---

### Completion

event: done  
data: {"finish_reason":"stop"}

finish_reason values:

- stop
- length
- error

---

## Client Behavior

Frontend must:

- Append tokens live
- Track conversation_id
- Detect finish_reason === length
- Offer Continue button if truncated
- Handle disconnect gracefully

---

## Fallback

If SSE fails:

POST /api/ai/chat

(non-streaming)
