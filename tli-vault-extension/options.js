// TLI Vault Extension — options page script

const urlInput = document.getElementById("tli-url");
const keyInput = document.getElementById("tli-api-key");
const toggleBtn = document.getElementById("toggle-key");
const saveBtn = document.getElementById("save-btn");
const testBtn = document.getElementById("test-btn");
const result = document.getElementById("result");

// Load saved settings
chrome.storage.local.get(["tliUrl", "tliApiKey"], (items) => {
  urlInput.value = items.tliUrl || "";
  keyInput.value = items.tliApiKey || "";
});

toggleBtn.addEventListener("click", () => {
  keyInput.type = keyInput.type === "password" ? "text" : "password";
});

function showResult(msg, type) {
  result.textContent = msg;
  result.className = `result ${type}`;
}

saveBtn.addEventListener("click", () => {
  const url = urlInput.value.trim().replace(/\/+$/, "");
  const key = keyInput.value.trim();
  if (!url) { showResult("Please enter your TLI instance URL.", "error"); return; }
  chrome.storage.local.set({ tliUrl: url, tliApiKey: key }, () => {
    showResult("Settings saved.", "ok");
  });
});

testBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim().replace(/\/+$/, "");
  const key = keyInput.value.trim();
  if (!url) { showResult("Enter a TLI URL first.", "error"); return; }
  if (!key) { showResult("Enter an API key first.", "error"); return; }

  testBtn.disabled = true;
  testBtn.textContent = "Testing…";
  showResult("", "");

  try {
    const res = await fetch(`${url}/vault/ext/logins`, {
      headers: { "X-TLI-API-Key": key },
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 200) {
      const data = await res.json();
      const count = (data.logins || []).length;
      showResult(`Connected! ${count} login${count !== 1 ? "s" : ""} found in vault.`, "ok");
    } else if (res.status === 401) {
      showResult("API key rejected. Generate a new key in TLI Vault.", "error");
    } else if (res.status === 403) {
      showResult("Connected, but vault is locked. Unlock it in TLI first.", "error");
    } else {
      showResult(`Unexpected response: ${res.status}`, "error");
    }
  } catch (err) {
    if (err.name === "TimeoutError") {
      showResult("Connection timed out. Is TLI running at that URL?", "error");
    } else {
      showResult(`Could not connect: ${err.message}`, "error");
    }
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = "Test Connection";
  }
});
