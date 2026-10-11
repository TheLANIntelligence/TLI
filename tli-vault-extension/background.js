// TLI Vault Extension — background service worker
// Handles all fetch calls to the TLI instance (avoids mixed-content blocks in content scripts).

const DEFAULT_TLI_URL = "http://fox.local:8000";

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["tliUrl", "tliApiKey"], (items) => {
      resolve({
        tliUrl: (items.tliUrl || DEFAULT_TLI_URL).replace(/\/+$/, ""),
        tliApiKey: items.tliApiKey || "",
      });
    });
  });
}

async function fetchLogins(domain) {
  const { tliUrl, tliApiKey } = await getConfig();
  if (!tliApiKey) {
    return { error: "No API key configured. Open TLI Vault options." };
  }
  try {
    const url = `${tliUrl}/vault/ext/logins?domain=${encodeURIComponent(domain)}`;
    const res = await fetch(url, {
      headers: { "X-TLI-API-Key": tliApiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) return { error: "Invalid API key. Check your TLI Vault settings." };
    if (res.status === 403) return { error: "Vault is locked. Unlock it in TLI first." };
    if (!res.ok) return { error: `TLI responded with ${res.status}` };
    return await res.json();
  } catch (err) {
    if (err.name === "TimeoutError") return { error: "TLI instance unreachable (timeout). Is it running?" };
    return { error: `Could not reach TLI: ${err.message}` };
  }
}

async function saveLogin(data) {
  const { tliUrl, tliApiKey } = await getConfig();
  if (!tliApiKey) return { error: "No API key configured." };
  try {
    const res = await fetch(`${tliUrl}/vault/ext/logins`, {
      method: "POST",
      headers: { "X-TLI-API-Key": tliApiKey, "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) return { error: "Invalid API key." };
    if (res.status === 403) return { error: "Vault is locked. Unlock it in TLI first." };
    if (!res.ok) return { error: `TLI responded with ${res.status}` };
    return await res.json();
  } catch (err) {
    if (err.name === "TimeoutError") return { error: "TLI instance unreachable." };
    return { error: `Could not reach TLI: ${err.message}` };
  }
}

async function fetchAllLogins() {
  const { tliUrl, tliApiKey } = await getConfig();
  if (!tliApiKey) {
    return { error: "No API key configured." };
  }
  try {
    const url = `${tliUrl}/vault/ext/logins`;
    const res = await fetch(url, {
      headers: { "X-TLI-API-Key": tliApiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) return { error: "Invalid API key." };
    if (res.status === 403) return { error: "Vault is locked. Unlock it in TLI first." };
    if (!res.ok) return { error: `TLI responded with ${res.status}` };
    return await res.json();
  } catch (err) {
    if (err.name === "TimeoutError") return { error: "TLI instance unreachable (timeout)." };
    return { error: `Could not reach TLI: ${err.message}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "TLI_FETCH_LOGINS") {
    fetchLogins(msg.domain).then(sendResponse);
    return true; // keep channel open for async
  }
  if (msg.type === "TLI_FETCH_ALL_LOGINS") {
    fetchAllLogins().then(sendResponse);
    return true;
  }
  if (msg.type === "TLI_SAVE_LOGIN") {
    saveLogin(msg.data).then(sendResponse);
    return true;
  }
});
