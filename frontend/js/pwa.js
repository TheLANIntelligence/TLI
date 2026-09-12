// TLI PWA Install Prompt
(function(){
  const LS_KEY = "tli_pwa_install_dismissed_v1";
  let _deferred = null;

  function _dismissed() { try { return !!localStorage.getItem(LS_KEY); } catch { return false; } }
  function _dismiss()   { try { localStorage.setItem(LS_KEY, "1"); } catch {} }

  function _showBanner(iosMode) {
    if (_dismissed()) return;
    const banner = document.getElementById("pwa-install-banner");
    if (!banner) return;
    if (iosMode) {
      const msg = banner.querySelector(".pwa-install-msg");
      const btn = document.getElementById("pwa-install-btn");
      if (msg) msg.textContent = 'Tap Share then "Add to Home Screen" to install TLI.';
      if (btn) btn.textContent = "Got it";
    }
    banner.hidden = false;
  }

  // TLI is a LAN tool — only show install banner on genuine mobile browsers.
  // Three independent signals must ALL agree it's mobile:
  //   1. Mobile user agent string
  //   2. Narrow viewport (phone/tablet width)
  //   3. Not a LAN/local hostname (fox.local, 192.168.x.x, localhost — all excluded)
  const _isMobileUA  = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
  const _isNarrow    = window.innerWidth <= 900;
  const _host        = (window.location.hostname || "").toLowerCase();
  const _isLanHost   = _host === "localhost" || _host.endsWith(".local")
                       || /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(_host)
                       || /^\d+\.\d+\.\d+\.\d+$/.test(_host);
  const _isMobile    = _isMobileUA && _isNarrow && !_isLanHost;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    _deferred = e;
    if (_isMobile) _showBanner(false);
  });

  document.addEventListener("DOMContentLoaded", () => {
    const installBtn  = document.getElementById("pwa-install-btn");
    const dismissBtn  = document.getElementById("pwa-install-dismiss");

    if (installBtn) {
      installBtn.addEventListener("click", async () => {
        if (_deferred) {
          _deferred.prompt();
          await _deferred.userChoice.catch(() => {});
          _deferred = null;
        }
        _dismiss();
        const banner = document.getElementById("pwa-install-banner");
        if (banner) banner.hidden = true;
      });
    }

    if (dismissBtn) {
      dismissBtn.addEventListener("click", () => {
        _dismiss();
        const banner = document.getElementById("pwa-install-banner");
        if (banner) banner.hidden = true;
      });
    }

    // iOS Safari — only on actual mobile, not LAN desktop
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.navigator.standalone === true
      || window.matchMedia("(display-mode: standalone)").matches;
    if (isIOS && !isStandalone && _isMobile) {
      _showBanner(true);
    }
  });
})();
