"""Pure persisted Notebook validation shared by readers and recovery checks.

Keep legacy string notes and existing structured notes readable without
normalizing, deleting or rewriting their metadata during a check.
"""
import re


def validate_memory_structure(data):
    """Raise for a structure the current application cannot open; change nothing."""
    if not isinstance(data, dict) or not isinstance(data.get("facts"), list):
        raise ValueError("Unsupported memory structure")
    facts = data["facts"]
    legacy = all(isinstance(f, str) for f in facts)
    current = all(isinstance(f, dict) and isinstance(f.get("text"), str) for f in facts)
    if not (legacy or current):
        raise ValueError("Unsupported note structure")
    if current:
        for fact in facts:
            if any(fact.get(k) is not None and not isinstance(fact[k], str)
                   for k in ("id", "title", "category", "device_id", "created_at", "updated_at", "source", "report_id")):
                raise ValueError("Unsupported note metadata")
            if "chat_source" in fact:
                source = fact["chat_source"]
                required = {"conversation_id", "message_index", "revision", "role"}
                if (not isinstance(source, dict) or not required <= set(source)
                        or set(source) - required - {"created_at", "provider", "model"}
                        or not isinstance(source["conversation_id"], str) or not 1 <= len(source["conversation_id"]) <= 256
                        or type(source["message_index"]) is not int or not 0 <= source["message_index"] <= 1000000
                        or not isinstance(source["revision"], str) or not re.fullmatch(r"[a-f0-9]{64}", source["revision"])
                        or source["role"] not in ("user", "assistant")
                        or any(key in source and (not isinstance(source[key], str) or not 1 <= len(source[key]) <= limit)
                               for key, limit in (("created_at", 64), ("provider", 120), ("model", 256)))):
                    raise ValueError("Unsupported saved chat source")
            if "note_links" in fact:
                value = fact["note_links"]
                if (not isinstance(value, dict) or set(value) != {"schema_version", "links"} or type(value["schema_version"]) is not int or
                        value["schema_version"] != 1 or not isinstance(value["links"], list) or len(value["links"]) > 8):
                    raise ValueError("Unsupported saved note relationships")
                seen = set()
                for link in value["links"]:
                    if (not isinstance(link, dict) or set(link) != {"id", "revision", "relation", "linked_at"} or
                            not isinstance(link["id"], str) or not 1 <= len(link["id"]) <= 256 or link["id"] == fact.get("id") or link["id"] in seen or
                            not isinstance(link["revision"], str) or not re.fullmatch(r"[a-f0-9]{64}", link["revision"]) or
                            link["relation"] not in ("related", "correction_reference", "different_experience") or
                            not isinstance(link["linked_at"], str) or not 1 <= len(link["linked_at"]) <= 64):
                        raise ValueError("Unsupported saved note relationship")
                    seen.add(link["id"])
