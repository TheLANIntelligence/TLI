package expo.modules.tlitransport

import android.os.Handler
import android.os.Looper
import android.os.Build
import android.util.Base64
import android.net.Uri
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkRequest
import android.net.LinkProperties
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import okhttp3.Call
import okhttp3.Connection
import okhttp3.EventListener
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.File
import java.io.ByteArrayOutputStream
import java.nio.charset.CharacterCodingException
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

class ConfigureOptions : Record {
  @Field var origin: String = ""
  @Field var certificateDer: String = ""
  @Field var certificateSha256: String = ""
  @Field var resolvedAddresses: List<String> = emptyList()
  @Field var nodeId: String = ""
  @Field var publicKey: String = ""
  @Field var timeoutMs: Int = 1500
}

class ResolveOptions : Record { @Field var origin: String = ""; @Field var timeoutMs: Int = 2000 }

class DiscoveryOptions : Record { @Field var timeoutMs: Int = 5000 }
class FileRequestOptions : Record {
  @Field var id: String = ""
  @Field var path: String = ""
  @Field var headers: Map<String, String> = emptyMap()
  @Field var fileUri: String = ""
  @Field var fileName: String = ""
  @Field var mimeType: String = ""
}

class RequestOptions : Record {
  @Field var id: String = ""
  @Field var path: String = ""
  @Field var method: String = "GET"
  @Field var headers: Map<String, String> = emptyMap()
  @Field var body: String? = null
  @Field var stream: Boolean = false
}

private data class Configuration(
  val origin: String,
  val certificate: X509Certificate,
  val client: OkHttpClient,
  val addresses: List<String> = emptyList()
)

private class PendingRequest(val options: RequestOptions, val call: Call, val promise: Promise, val helperClient: OkHttpClient? = null, val download: File? = null) {
  @Volatile var completeFile = false
}
private class PendingConfiguration(val candidate: Configuration, val promise: Promise, val options: ConfigureOptions)
private class PendingUpload(val promise: Promise) { @Volatile var cancelled = false }

/** Each instance has its own trust store, connection pool and pending calls. */
class TliTransportModule : Module() {
  private val lock = Any()
  private val main = Handler(Looper.getMainLooper())
  private var configuration: Configuration? = null
  private var pendingConfiguration: PendingConfiguration? = null
  private val pending = mutableMapOf<String, PendingRequest>()
  private val uploads = mutableMapOf<String, PendingUpload>()
  private val probes = mutableSetOf<OkHttpClient>()
  private var discovery: LanDiscovery? = null
  private val routeResolver = RouteResolver()
  private var networkManager: ConnectivityManager? = null
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var networkGeneration = 0
  private var networkNotice: Runnable? = null
  private var networkTracker: LanNetworkTracker? = null
  private var networkInvalidated = false

  override fun definition() = ModuleDefinition {
    Name("TliTransport")
    Events("onHeaders", "onChunk", "onNetworkChanged")

    AsyncFunction("resolveConnection") { options: ResolveOptions ->
      assertLocalPermission()
      routeResolver.resolve(options.origin, options.timeoutMs)
    }

    AsyncFunction("configure") { options: ConfigureOptions, promise: Promise ->
      try {
        synchronized(lock) {
          resetLocked(networkInvalidated)
          monitorNetwork()
          val candidate = configureClient(options)
          val attempt = PendingConfiguration(candidate, promise, options)
          pendingConfiguration = attempt
          if (requiresLocalNetworkPermission()) {
            main.post { requestLocalNetworkPermission(attempt) }
          } else completeConfiguration(attempt, true)
        }
      } catch (error: Exception) {
        reject(promise, error)
      }
    }

    AsyncFunction("uploadFile") { options: FileRequestOptions, promise: Promise ->
      var upload: PendingUpload? = null
      try {
        val selected = synchronized(lock) {
          val config = activeConfiguration()
          if (!Regex("^[A-Za-z0-9_-]{1,128}$").matches(options.id) || pending.containsKey(options.id) || uploads.containsKey(options.id)) throw TransportFailure("E_REQUEST_ID", "Use a unique request identifier.")
          upload = PendingUpload(promise).also { uploads[options.id] = it }
          config
        }
        val bytes = readUpload(options.fileUri) { upload!!.cancelled }
        synchronized(lock) {
          val config = configuration
          if (config !== selected || upload!!.cancelled || uploads[options.id] !== upload) throw TransportFailure("E_CANCELLED", "The selected connection changed before sending the document.")
          val request = RequestOptions().apply { id = options.id; path = options.path; headers = options.headers; method = "POST" }
          enqueueRequest(selected, request, promise, upload = bytes)
          uploads.remove(options.id)
        }
      } catch (error: Exception) { synchronized(lock) {
        if (upload == null || uploads[options.id] === upload) { uploads.remove(options.id); reject(promise, error) }
      } }
    }

    AsyncFunction("downloadFile") { options: FileRequestOptions, promise: Promise ->
      var destination: File? = null
      try {
        synchronized(lock) {
          val config = activeConfiguration()
          val root = File(appContext.reactContext!!.cacheDir, "tli-downloads").apply { mkdirs() }
          // Keep the extension useful for the native share sheet; ignore all supplied path components.
          val extension = options.fileName.substringAfterLast('.', "bin").lowercase().takeIf { Regex("^[a-z0-9]{1,8}$").matches(it) } ?: "bin"
          destination = File.createTempFile("tli-", ".$extension", root)
          val request = RequestOptions().apply { id = options.id; path = options.path; headers = options.headers; method = "GET" }
          enqueueRequest(config, request, promise, download = destination)
        }
      } catch (error: Exception) { destination?.delete(); reject(promise, error) }
    }

    AsyncFunction("discover") { options: DiscoveryOptions, promise: Promise ->
      try {
        synchronized(lock) {
          assertLocalPermission()
          val service = discovery ?: LanDiscovery(appContext.reactContext!!).also { discovery = it }
          service.start(options.timeoutMs) { result, error -> if (error != null) reject(promise, error) else promise.resolve(result) }
        }
      } catch (error: Exception) { reject(promise, error) }
    }

    AsyncFunction("probeConnection") { options: ConfigureOptions, promise: Promise ->
      var isolated: Configuration? = null
      try {
        synchronized(lock) {
          assertLocalPermission()
          isolated = configureClient(options)
          val candidate = isolated!!
          probes.add(candidate.client)
          probe(candidate, options) { result, error ->
            synchronized(lock) {
              val current = probes.remove(candidate.client)
              closeClient(candidate.client)
              if (!current) promise.reject("E_CANCELLED", "Connection verification was cancelled.", null)
              else if (error != null) reject(promise, error) else promise.resolve(result)
            }
          }
        }
      } catch (error: Exception) {
        isolated?.client?.let { synchronized(lock) { probes.remove(it); closeClient(it) } }
        reject(promise, error)
      }
    }

    AsyncFunction("request") { options: RequestOptions, promise: Promise ->
      try {
        synchronized(lock) {
          val config = activeConfiguration()
          enqueueRequest(config, options, promise)
        }
      } catch (error: Exception) {
        reject(promise, error)
      }
    }

    // Per-request trust and connection pool; never replace the paired transport.
    AsyncFunction("requestHelper") { configuration: ConfigureOptions, options: RequestOptions, promise: Promise ->
      var isolated: Configuration? = null
      try {
        synchronized(lock) {
          TransportPolicy.helperRequest(options.method, options.path, options.headers, options.body, options.stream)
          if (TransportPolicy.isHostname(TransportPolicy.origin(configuration.origin))) throw TransportFailure("E_UNSUPPORTED", "The helper still requires its reviewed private IPv4 address.")
          isolated = configureClient(configuration)
          val fingerprint = MessageDigest.getInstance("SHA-256").digest(isolated!!.certificate.encoded).joinToString("") { "%02x".format(it.toInt() and 255) }
          if (fingerprint != configuration.certificateSha256) throw TransportFailure("E_TLS_TRUST", "The reviewed helper fingerprint does not match the paired certificate.")
          enqueueRequest(isolated!!, options, promise, true)
        }
      } catch (error: Exception) {
        isolated?.client?.let { closeClient(it) }
        reject(promise, error)
      }
    }

    Function("cancel") { id: String ->
      synchronized(lock) { cancelLocked(id) }
    }

    AsyncFunction("reset") {
      synchronized(lock) { resetLocked() }
    }

    OnDestroy {
      synchronized(lock) {
        resetLocked()
        networkNotice?.let { main.removeCallbacks(it) }; networkNotice = null
        networkCallback?.let { try { networkManager?.unregisterNetworkCallback(it) } catch (_: Exception) {} }
        networkCallback = null; networkManager = null; networkTracker = null
        routeResolver.close()
      }
    }
  }

  private fun enqueueRequest(config: Configuration, options: RequestOptions, promise: Promise, helper: Boolean = false, upload: ByteArray? = null, download: File? = null) {
          assertLocalPermission()
          config.certificate.checkValidity()
          if (!Regex("^[A-Za-z0-9_-]{1,128}$").matches(options.id) || pending.containsKey(options.id) || (uploads.containsKey(options.id) && upload == null)) {
            throw TransportFailure("E_REQUEST_ID", "Use a unique request identifier.")
          }
          val method = TransportPolicy.method(options.method)
          TransportPolicy.headers(options.headers)
          val url = TransportPolicy.requestUrl(config.origin, options.path)
          val bodyBytes = upload ?: options.body?.toByteArray(Charsets.UTF_8)
          if ((bodyBytes?.size ?: 0) > MAX_REQUEST_BYTES) {
            throw TransportFailure("E_REQUEST_TOO_LARGE", "The request exceeds 16 MiB.")
          }
          if (method in setOf("GET", "HEAD") && bodyBytes != null) {
            throw TransportFailure("E_METHOD", "GET and HEAD requests cannot contain a body.")
          }
          val body = when {
            bodyBytes != null -> bodyBytes.toRequestBody(null)
            method in setOf("POST", "PUT", "PATCH") -> ByteArray(0).toRequestBody(null)
            else -> null
          }
          val builder = Request.Builder().url(url).method(method, body)
          options.headers.forEach { (name, value) -> builder.header(name, value) }
          // Credentials are never retried automatically; action requests may have side effects.
          val call = config.client.newCall(builder.build())
          if (helper) call.timeout().timeout(20, TimeUnit.SECONDS)
          val state = PendingRequest(options, call, promise, if (helper) config.client else null, download)
          pending[options.id] = state
          call.enqueue(callback(state))
  }

  private fun configureClient(options: ConfigureOptions): Configuration {
    val origin = TransportPolicy.origin(options.origin)
    if (options.certificateDer.length !in 1..24576 ||
      !Regex("^[A-Za-z0-9+/]+={0,2}$").matches(options.certificateDer)) {
      throw TransportFailure("E_CERTIFICATE", "The pairing certificate is not valid base64 DER.")
    }
    val der = try { Base64.decode(options.certificateDer, Base64.NO_WRAP) } catch (_: Exception) {
      throw TransportFailure("E_CERTIFICATE", "The pairing certificate is invalid.")
    }
    if (der.size > 16384) throw TransportFailure("E_CERTIFICATE", "The pairing certificate is too large.")
    val certificate = CertificateFactory.getInstance("X.509")
      .generateCertificate(ByteArrayInputStream(der)) as X509Certificate
    if (!MessageDigest.isEqual(der, certificate.encoded)) {
      throw TransportFailure("E_CERTIFICATE", "Expected exactly one DER certificate.")
    }
    val hostname = if (TransportPolicy.isHostname(origin)) java.net.URI(origin).host else null
    val addresses = if (hostname != null) TransportPolicy.addresses(options.resolvedAddresses) else emptyList()
    return Configuration(origin, certificate, PinnedClient.create(certificate, hostname, addresses), addresses)
  }

  private fun assertLocalPermission() {
    if (requiresLocalNetworkPermission() && appContext.permissions?.hasGrantedPermissions(LOCAL_NETWORK_PERMISSION) != true) {
      throw TransportFailure("E_LOCAL_NETWORK_PERMISSION", "Allow TLI local network access in Android Settings, then reconnect.")
    }
  }

  private fun readUpload(value: String, cancelled: () -> Boolean): ByteArray {
    val context = appContext.reactContext ?: throw TransportFailure("E_FILE", "The application context is unavailable.")
    val uri = Uri.parse(value)
    if (uri.scheme != "file" || !uri.authority.isNullOrEmpty() || uri.query != null || uri.fragment != null) throw TransportFailure("E_FILE", "Copy the selected document to the app cache before sending.")
    return TransferFiles.readUpload(File(uri.path ?: ""), listOfNotNull(context.cacheDir, context.externalCacheDir), cancelled)
  }

  private fun probe(config: Configuration, options: ConfigureOptions, completion: (Map<String, Any>?, Exception?) -> Unit) {
    val nonce = ConnectionIdentity.nonce()
    ConnectionIdentity.validateInput(options.nodeId, options.publicKey, nonce)
    val request = Request.Builder().url(TransportPolicy.requestUrl(config.origin, ConnectionIdentity.PATH))
      .header("Content-Type", "application/json").header("Accept", "application/json")
      .post(ConnectionIdentity.request(options.nodeId, config.origin, nonce).toRequestBody(null)).build()
    val connectedAddress = java.util.concurrent.atomic.AtomicReference<String>()
    // A proof establishes only the route that actually answered, not every DNS-SD hint.
    val timeout = options.timeoutMs.coerceIn(100, 2500).toLong()
    val probeClient = config.client.newBuilder().connectTimeout(timeout, TimeUnit.MILLISECONDS).eventListener(object : EventListener() {
      override fun connectionAcquired(call: Call, connection: Connection) {
        connectedAddress.set(connection.route().socketAddress.address?.hostAddress)
      }
    }).build()
    val call = probeClient.newCall(request)
    call.timeout().timeout(timeout, TimeUnit.MILLISECONDS)
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, error: IOException) { main.post { completion(null, error) } }
      override fun onResponse(call: Call, response: Response) {
        var result: Map<String, Any>? = null; var failure: Exception? = null
        response.use {
          try {
            if (response.code in 300..399) throw TransportFailure("E_REDIRECT", "TLI transport refuses HTTP redirects.")
            if (response.code != 200) throw TransportFailure("E_IDENTITY", "The endpoint did not return a valid identity challenge.")
            val input = response.body?.byteStream() ?: throw TransportFailure("E_IDENTITY", "Missing identity response.")
            val bytes = ByteArrayOutputStream(); val buffer = ByteArray(2048)
            while (true) { val count = input.read(buffer); if (count < 0) break
              if (bytes.size() + count > 16384) throw TransportFailure("E_IDENTITY", "The identity response is too large.")
              bytes.write(buffer, 0, count)
            }
            val body = IncrementalUtf8Decoder().decode(bytes.toByteArray(), end = true)
            val address = connectedAddress.get()
            if (TransportPolicy.isHostname(config.origin) && (address == null || address !in config.addresses)) throw TransportFailure("E_IDENTITY", "The verified socket did not use a reviewed private route.")
            result = ConnectionIdentity.verify(body, options.nodeId, options.publicKey, config.origin,
              ConnectionIdentity.fingerprint(config.certificate.encoded), nonce) +
              mapOf("resolvedAddresses" to if (TransportPolicy.isHostname(config.origin)) listOf(address!!) else emptyList<String>())
          } catch (error: Exception) { failure = error }
        }
        main.post { completion(result, failure) }
      }
    })
  }

  private fun requiresLocalNetworkPermission(): Boolean {
    val context = appContext.reactContext
      ?: throw TransportFailure("E_NETWORK", "The application context is unavailable.")
    return Build.VERSION.SDK_INT >= 37 && context.applicationInfo.targetSdkVersion >= 37
  }

  /** Native Wi-Fi/Ethernet changes invalidate only the route, never saved trust. */
  private fun monitorNetwork() {
    if (networkCallback != null) return
    val context = appContext.reactContext ?: return
    val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    @Suppress("DEPRECATION")
    fun snapshot(changed: Network? = null, properties: LinkProperties? = null, lost: Boolean = false): List<LanNetworkRoute> {
      val active = manager.activeNetwork
      val networks = (manager.allNetworks.toList() + listOfNotNull(changed)).distinct().filter { !lost || it != changed }
      return networks.map { network ->
        val capabilities = manager.getNetworkCapabilities(network)
        val eligible = capabilities?.let { it.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) ||
          it.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET) } == true
        val link = if (network == changed && properties != null) properties else manager.getLinkProperties(network)
        LanNetworkRoute(network.networkHandle, eligible, network == active, link?.interfaceName ?: "",
          link?.linkAddresses?.map { it.toString() } ?: emptyList(),
          link?.routes?.map { it.toString() } ?: emptyList(),
          link?.dnsServers?.mapNotNull { it.hostAddress } ?: emptyList())
      }
    }
    val callback = object : ConnectivityManager.NetworkCallback() {
      private fun changed(network: Network, properties: LinkProperties? = null, lost: Boolean = false) {
        synchronized(lock) {
          if (networkCallback !== this) return@synchronized
          val changed = try { networkTracker?.changed(snapshot(network, properties, lost)) == true }
            catch (_: Exception) { true } // Unknown route state cannot retain credential authority.
          if (!changed) return@synchronized
          // Invalidate before returning from the native callback. Debouncing is
          // only for UI notification; no request can reuse the route meanwhile.
          resetLocked(networkChanged = true)
          networkNotice?.let { main.removeCallbacks(it) }
          networkNotice = Runnable {
            synchronized(lock) {
              networkNotice = null
              if (networkCallback === this) sendEvent("onNetworkChanged", mapOf("generation" to ++networkGeneration))
            }
          }.also { main.postDelayed(it, 350) }
        }
      }
      override fun onAvailable(network: Network) = changed(network)
      override fun onLost(network: Network) = changed(network, lost = true)
      override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) = changed(network, properties)
    }
    try {
      networkTracker = LanNetworkTracker(snapshot())
      networkManager = manager; networkCallback = callback
      manager.registerNetworkCallback(NetworkRequest.Builder().clearCapabilities()
        .addTransportType(android.net.NetworkCapabilities.TRANSPORT_WIFI)
        .addTransportType(android.net.NetworkCapabilities.TRANSPORT_ETHERNET).build(), callback)
    } catch (_: Exception) { networkCallback = null; networkManager = null; networkTracker = null /* Foreground/manual recovery remains available. */ }
  }

  /** Only target 37+ declares/requests this permission; older targets retain INTERNET behavior. */
  private fun requestLocalNetworkPermission(attempt: PendingConfiguration) {
    synchronized(lock) {
      if (pendingConfiguration !== attempt) return
      val permissions = appContext.permissions
      if (permissions == null || !permissions.isPermissionPresentInManifest(LOCAL_NETWORK_PERMISSION)) {
        completeConfiguration(attempt, false)
        return
      }
      try {
        permissions.askForPermissions({ result ->
          synchronized(lock) {
            completeConfiguration(attempt, result[LOCAL_NETWORK_PERMISSION]?.status == PermissionsStatus.GRANTED)
          }
        }, LOCAL_NETWORK_PERMISSION)
      } catch (_: Exception) {
        completeConfiguration(attempt, false)
      }
    }
  }

  private fun completeConfiguration(attempt: PendingConfiguration, granted: Boolean) {
    if (pendingConfiguration !== attempt) return
    if (granted) {
      if (TransportPolicy.isHostname(attempt.candidate.origin)) {
        try {
          probe(attempt.candidate, attempt.options) { result, error -> synchronized(lock) {
            if (pendingConfiguration !== attempt) return@synchronized
            pendingConfiguration = null
            if (error == null) {
              try {
                val routes = (result?.get("resolvedAddresses") as? List<*>)?.filterIsInstance<String>() ?: emptyList()
                if (routes.size != 1) throw TransportFailure("E_IDENTITY", "The connection did not prove one private route.")
                val candidate = attempt.candidate
                configuration = candidate.copy(client = PinnedClient.create(candidate.certificate, java.net.URI(candidate.origin).host, routes), addresses = routes)
                networkInvalidated = false
                closeClient(candidate.client)
                attempt.promise.resolve(null)
              } catch (failure: Exception) { closeClient(attempt.candidate.client); reject(attempt.promise, failure) }
            }
            else { closeClient(attempt.candidate.client); reject(attempt.promise, error) }
          } }
        } catch (error: Exception) {
          pendingConfiguration = null; closeClient(attempt.candidate.client); reject(attempt.promise, error)
        }
      } else { pendingConfiguration = null; configuration = attempt.candidate; networkInvalidated = false; attempt.promise.resolve(null) }
    } else {
      pendingConfiguration = null
      closeClient(attempt.candidate.client)
      attempt.promise.reject("E_LOCAL_NETWORK_PERMISSION", "Allow TLI local network access in Android Settings, then reconnect.", null)
    }
  }

  private fun callback(state: PendingRequest) = object : Callback {
    override fun onFailure(call: Call, error: IOException) {
      finish(state, error = if (call.isCanceled()) TransportFailure("E_CANCELLED", "The request was cancelled.") else error)
    }

    override fun onResponse(call: Call, response: Response) {
      response.use {
        try {
          if (response.code in 300..399) throw TransportFailure("E_REDIRECT", "TLI transport refuses HTTP redirects.")
          val headers = response.headers.names().associate { it.lowercase() to response.headers.values(it).joinToString(", ") }
          emit(state, "onHeaders", mapOf("id" to state.options.id, "status" to response.code, "headers" to headers))
          if (state.download != null && response.isSuccessful) {
            writeDownload(state, response)
            finish(state, mapOf("status" to response.code, "headers" to headers, "body" to "", "fileUri" to Uri.fromFile(state.download).toString()))
            return
          }
          state.download?.delete()
          val body = StringBuilder()
          val streamResponse = TransportPolicy.shouldStream(state.options.stream, response.code)
          val decoder = IncrementalUtf8Decoder()
          val buffer = ByteArray(8192)
          var total = 0L
          response.body?.byteStream()?.use { input ->
            while (true) {
              if (call.isCanceled()) throw TransportFailure("E_CANCELLED", "The request was cancelled.")
              val read = input.read(buffer)
              if (read == -1) break
              total += read
              if (total > (if (state.helperClient != null) 65536 else if (state.download != null) 262144 else MAX_RESPONSE_BYTES)) throw TransportFailure("E_RESPONSE_TOO_LARGE", "The response exceeds its transfer limit.")
              append(state, decoder.decode(buffer, read), body, streamResponse)
            }
          }
          append(state, decoder.decode(ByteArray(0), end = true), body, streamResponse)
          finish(state, mapOf("status" to response.code, "headers" to headers, "body" to body.toString()))
        } catch (error: Exception) {
          call.cancel()
          finish(state, error = error)
        }
      }
    }
  }

  private fun writeDownload(state: PendingRequest, response: Response) {
    if ((response.body?.contentLength() ?: 0) > MAX_DOWNLOAD_BYTES) throw TransportFailure("E_RESPONSE_TOO_LARGE", "The download exceeds 16 MiB.")
    var total = 0L
    state.download!!.outputStream().use { output ->
      response.body?.byteStream()?.use { input ->
        val buffer = ByteArray(8192)
        while (true) {
          if (state.call.isCanceled()) throw TransportFailure("E_CANCELLED", "The download was cancelled.")
          val count = input.read(buffer); if (count < 0) break
          total += count
          if (total > MAX_DOWNLOAD_BYTES) throw TransportFailure("E_RESPONSE_TOO_LARGE", "The download exceeds 16 MiB.")
          output.write(buffer, 0, count)
        }
      }
    }
  }

  private fun append(state: PendingRequest, text: String, body: StringBuilder, stream: Boolean) {
    if (text.isEmpty()) return
    if (stream) emit(state, "onChunk", mapOf("id" to state.options.id, "chunk" to text))
    else body.append(text)
  }

  // A single main queue preserves headers -> chunks -> settlement order for each request.
  private fun emit(state: PendingRequest, name: String, data: Map<String, Any>) {
    main.post {
      synchronized(lock) {
        if (pending[state.options.id] === state) sendEvent(name, data)
      }
    }
  }

  private fun finish(state: PendingRequest, result: Map<String, Any>? = null, error: Exception? = null) {
    main.post {
      synchronized(lock) {
        if (pending[state.options.id] !== state) { if (!state.completeFile) state.download?.delete(); return@post }
        pending.remove(state.options.id)
        state.helperClient?.let { closeClient(it) }
        if (error != null) { state.download?.delete(); reject(state.promise, error) }
        else { state.completeFile = result?.containsKey("fileUri") == true; state.promise.resolve(result) }
      }
    }
  }

  private fun cancelLocked(id: String) {
    uploads.remove(id)?.let { upload -> upload.cancelled = true; main.post { upload.promise.reject("E_CANCELLED", "The upload was cancelled.", null) } }
    pending.remove(id)?.let { state ->
      state.call.cancel()
      state.download?.delete()
      state.helperClient?.let { closeClient(it) }
      main.post { state.promise.reject("E_CANCELLED", "The request was cancelled.", null) }
    }
  }

  private fun activeConfiguration(): Configuration = configuration ?: throw when {
    networkInvalidated -> TransportFailure("E_NETWORK", "The LAN route changed. Reconnect to verify the saved TLI identity before sending.")
    pendingConfiguration != null -> TransportFailure("E_PAUSED", "Secure connection verification is still in progress.")
    else -> TransportFailure("E_NOT_CONFIGURED", "Pair with TLI first.")
  }

  private fun resetLocked(networkChanged: Boolean = false) {
    discovery?.cancel()
    probes.toList().forEach { closeClient(it) }; probes.clear()
    (pending.keys + uploads.keys).toList().forEach { cancelLocked(it) }
    pendingConfiguration?.let {
      closeClient(it.candidate.client)
      it.promise.reject("E_CANCELLED", "Connection setup was cancelled.", null)
    }
    pendingConfiguration = null
    configuration?.client?.let { closeClient(it) }
    configuration = null
    networkInvalidated = networkChanged
  }

  private fun closeClient(client: OkHttpClient) {
    client.dispatcher.cancelAll()
    client.connectionPool.evictAll()
    client.dispatcher.executorService.shutdown()
  }

  private fun reject(promise: Promise, error: Exception) {
    val (code, message) = transportError(error)
    promise.reject(code, message, null)
  }

  companion object {
    private const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
  }
}

internal fun transportError(error: Exception): Pair<String, String> = when (error) {
      is TransportFailure -> error.code to (error.message ?: "Transport error.")
      is CertificateException, is SSLHandshakeException, is SSLPeerUnverifiedException ->
        "E_TLS_TRUST" to "TLI's certificate could not be verified. Check the desktop and pair again."
      is java.net.SocketTimeoutException -> "E_TIMEOUT" to "TLI did not respond within the connection timeout."
      is java.net.NoRouteToHostException -> "E_NO_ROUTE" to "No network route to the paired TLI address."
      is java.net.ConnectException -> "E_CONNECT" to "A connection to the paired TLI address could not be established."
      is CharacterCodingException -> "E_ENCODING" to "TLI returned invalid UTF-8."
      else -> "E_NETWORK" to "TLI could not be reached securely. Check your Wi-Fi and the desktop."
    }
