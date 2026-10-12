package expo.modules.tlipreview

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.*
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayInputStream
import java.security.SecureRandom

/** A credential-free renderer. No JavascriptInterface or native web message bridge exists. */
class TliPreviewView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true
  val onCheckResult by EventDispatcher()
  var html = ""
  var headers: Map<String, String> = emptyMap()
  var token = ""
  var revisionKey = ""
  private val main = Handler(Looper.getMainLooper())
  private var web: WebView? = null
  private var loaded = ""
  @Volatile private var epoch = 0
  private var polling: Runnable? = null
  private var resultSent = false

  fun render() {
    if (html.isEmpty() || token.isEmpty() || revisionKey.isEmpty()) return
    val identity = revisionKey + "|" + token
    if (loaded == identity) return
    dispose(); loaded = identity; resultSent = false
    val generation = epoch
    try {
      val responseHeaders = PreviewPolicy.validate(html, headers, token, revisionKey)
      val source = html.toByteArray(Charsets.UTF_8)
      val nonce = ByteArray(24).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it.toInt() and 255) }
      val shellUrl = PreviewPolicy.ORIGIN + "/" + nonce + "/shell"
      val documentUrl = PreviewPolicy.ORIGIN + "/" + nonce + "/document"
      val shell = """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}body{overflow:hidden}</style></head><body><iframe id="preview" title="Isolated app preview" sandbox="allow-scripts" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" src="$documentUrl"></iframe><script nonce="$nonce">(()=>{const frame=document.getElementById('preview');let result=null;Object.defineProperty(window,'__tliReadPreviewResult',{value:()=>result,writable:false,configurable:false});addEventListener('message',e=>{if(result!==null||e.source!==frame.contentWindow||!e.data||e.data.tliAppPreview!=='$token')return;result={passed:e.data.passed===true,error:typeof e.data.error==='string'?e.data.error.slice(0,500):''};});})();</script></body></html>""".toByteArray(Charsets.UTF_8)
      val shellHeaders = mapOf("Content-Security-Policy" to "default-src 'none'; script-src 'nonce-$nonce'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'", "Cache-Control" to "no-store", "Referrer-Policy" to "no-referrer")
      val view = WebView(context)
      web = view
      configure(view)
      view.webViewClient = object : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
          if (epoch != generation || request.method != "GET") return denied()
          return when (request.url.toString()) {
            shellUrl -> if (request.isForMainFrame) response(shell, shellHeaders) else denied()
            documentUrl -> if (!request.isForMainFrame) response(source, responseHeaders) else denied()
            else -> denied()
          }
        }
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
          // Only the wrapper's initial child document may navigate. All app links/intents are denied.
          request.isForMainFrame || request.url.toString() != documentUrl || request.method != "GET"
        @Suppress("DEPRECATION")
        override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = true
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) { handler.cancel() }
        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
          if (url != shellUrl) { view.stopLoading(); report(false, "Preview navigation was blocked.", generation) }
        }
        override fun onPageFinished(view: WebView, url: String) { if (url == shellUrl && generation == epoch) poll(generation, 0) }
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
          report(false, "The preview renderer stopped. Reopen the saved version.", generation)
          dispose(); return true
        }
      }
      addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      view.loadUrl(shellUrl)
    } catch (error: Exception) {
      removeAllViews()
      addView(TextView(context).apply { text = "Isolated preview unavailable: " + (error.message ?: "unsupported sandbox") })
      report(false, "Preview sandbox could not be established.", generation)
    }
  }

  @Suppress("DEPRECATION")
  private fun configure(view: WebView) {
    WebView.setWebContentsDebuggingEnabled(false)
    view.settings.apply {
      javaScriptEnabled = true
      blockNetworkLoads = true
      blockNetworkImage = true
      allowFileAccess = false
      allowContentAccess = false
      allowFileAccessFromFileURLs = false
      allowUniversalAccessFromFileURLs = false
      domStorageEnabled = false
      databaseEnabled = false
      cacheMode = WebSettings.LOAD_NO_CACHE
      javaScriptCanOpenWindowsAutomatically = false
      setSupportMultipleWindows(false)
      setGeolocationEnabled(false)
      mediaPlaybackRequiresUserGesture = true
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      // Saved previews intentionally omit the generated head; use the phone's viewport.
      useWideViewPort = false
      builtInZoomControls = true
      displayZoomControls = false
    }
    CookieManager.getInstance().setAcceptCookie(false)
    CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
    if (Build.VERSION.SDK_INT >= 24) {
      ServiceWorkerController.getInstance().serviceWorkerWebSettings.apply {
        blockNetworkLoads = true; allowContentAccess = false; allowFileAccess = false; cacheMode = WebSettings.LOAD_NO_CACHE
      }
      ServiceWorkerController.getInstance().setServiceWorkerClient(object : ServiceWorkerClient() {
        override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse = denied()
      })
    }
    view.webChromeClient = object : WebChromeClient() {
      override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
      override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) { callback.invoke(origin, false, false) }
      override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean { filePathCallback.onReceiveValue(null); return true }
      override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean = false
      override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean { result.cancel(); return true }
      override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean { result.cancel(); return true }
      override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String?, result: JsPromptResult): Boolean { result.cancel(); return true }
    }
    view.setDownloadListener { _, _, _, _, _ -> /* No file writes or external application launch. */ }
    if (Build.VERSION.SDK_INT >= 26) view.importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
    if (Build.VERSION.SDK_INT >= 29) view.setWebViewRenderProcessClient(object : WebViewRenderProcessClient() {
      override fun onRenderProcessResponsive(view: WebView, renderer: WebViewRenderProcess?) = Unit
      override fun onRenderProcessUnresponsive(view: WebView, renderer: WebViewRenderProcess?) {
        report(false, "The app preview stopped responding.", epoch)
        renderer?.terminate()
      }
    })
  }

  private fun poll(generation: Int, count: Int) {
    if (generation != epoch || resultSent) return
    if (count >= 80) { report(false, "No check result within 8 seconds.", generation); return }
    // Fixed source, no caller/generated interpolation and no JavaScript-to-native bridge.
    web?.evaluateJavascript("JSON.stringify(window.__tliReadPreviewResult ? window.__tliReadPreviewResult() : null)") { encoded ->
      if (generation != epoch || resultSent) return@evaluateJavascript
      try {
        if (encoded.length <= 8192) {
          val text = JSONTokener(encoded).nextValue() as? String
          if (text != null && text != "null") {
            val value = JSONObject(text)
            report(value.opt("passed") == true, value.optString("error", "").take(500), generation)
            return@evaluateJavascript
          }
        }
      } catch (_: Exception) { report(false, "Invalid advisory check result.", generation); return@evaluateJavascript }
      polling = Runnable { poll(generation, count + 1) }.also { main.postDelayed(it, 100) }
    }
  }

  private fun report(passed: Boolean, error: String, generation: Int) {
    if (generation != epoch || resultSent) return
    resultSent = true
    onCheckResult(mapOf("revisionKey" to revisionKey, "passed" to passed, "error" to error.take(500)))
  }

  fun dispose() {
    ++epoch
    polling?.let { main.removeCallbacks(it) }; polling = null
    web?.let { view -> view.stopLoading(); removeView(view); view.clearHistory(); view.clearCache(true); view.destroy() }
    web = null; loaded = ""; removeAllViews()
  }

  private fun response(bytes: ByteArray, headers: Map<String, String>) = WebResourceResponse("text/html", "utf-8", 200, "OK", headers, ByteArrayInputStream(bytes))
  private fun denied() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", mapOf("Cache-Control" to "no-store", "Content-Security-Policy" to "default-src 'none'; sandbox"), ByteArrayInputStream(ByteArray(0)))
}
