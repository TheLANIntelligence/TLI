package expo.modules.tlitransport

import android.os.Handler
import android.os.Looper
import android.os.Build
import android.util.Base64
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.ByteArrayInputStream
import java.io.IOException
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
  val client: OkHttpClient
)

private class PendingRequest(val options: RequestOptions, val call: Call, val promise: Promise, val helperClient: OkHttpClient? = null)
private class PendingConfiguration(val candidate: Configuration, val promise: Promise)

/** Each instance has its own trust store, connection pool and pending calls. */
class TliTransportModule : Module() {
  private val lock = Any()
  private val main = Handler(Looper.getMainLooper())
  private var configuration: Configuration? = null
  private var pendingConfiguration: PendingConfiguration? = null
  private val pending = mutableMapOf<String, PendingRequest>()

  override fun definition() = ModuleDefinition {
    Name("TliTransport")
    Events("onHeaders", "onChunk")

    AsyncFunction("configure") { options: ConfigureOptions, promise: Promise ->
      try {
        synchronized(lock) {
          resetLocked()
          val candidate = configureClient(options)
          if (requiresLocalNetworkPermission()) {
            val attempt = PendingConfiguration(candidate, promise)
            pendingConfiguration = attempt
            main.post { requestLocalNetworkPermission(attempt) }
          } else {
            configuration = candidate
            promise.resolve(null)
          }
        }
      } catch (error: Exception) {
        reject(promise, error)
      }
    }

    AsyncFunction("request") { options: RequestOptions, promise: Promise ->
      try {
        synchronized(lock) {
          val config = configuration ?: throw TransportFailure("E_NOT_CONFIGURED", "Pair with TLI first.")
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
      synchronized(lock) { resetLocked() }
    }
  }

  private fun enqueueRequest(config: Configuration, options: RequestOptions, promise: Promise, helper: Boolean = false) {
          if (requiresLocalNetworkPermission() && appContext.permissions?.hasGrantedPermissions(LOCAL_NETWORK_PERMISSION) != true) {
            throw TransportFailure("E_LOCAL_NETWORK_PERMISSION", "Allow TLI local network access in Android Settings, then reconnect.")
          }
          config.certificate.checkValidity()
          if (!Regex("^[A-Za-z0-9_-]{1,128}$").matches(options.id) || pending.containsKey(options.id)) {
            throw TransportFailure("E_REQUEST_ID", "Use a unique request identifier.")
          }
          val method = TransportPolicy.method(options.method)
          TransportPolicy.headers(options.headers)
          val url = TransportPolicy.requestUrl(config.origin, options.path)
          val bodyBytes = options.body?.toByteArray(Charsets.UTF_8)
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
          val state = PendingRequest(options, call, promise, if (helper) config.client else null)
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
    return Configuration(origin, certificate, PinnedClient.create(certificate))
  }

  private fun requiresLocalNetworkPermission(): Boolean {
    val context = appContext.reactContext
      ?: throw TransportFailure("E_NETWORK", "The application context is unavailable.")
    return Build.VERSION.SDK_INT >= 37 && context.applicationInfo.targetSdkVersion >= 37
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
    pendingConfiguration = null
    if (granted) {
      configuration = attempt.candidate
      attempt.promise.resolve(null)
    } else {
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
              if (total > (if (state.helperClient != null) 65536 else MAX_RESPONSE_BYTES)) throw TransportFailure("E_RESPONSE_TOO_LARGE", if (state.helperClient != null) "The helper response exceeds 64 KiB." else "The response exceeds 8 MiB.")
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
        if (pending[state.options.id] !== state) return@post
        pending.remove(state.options.id)
        state.helperClient?.let { closeClient(it) }
        if (error != null) reject(state.promise, error) else state.promise.resolve(result)
      }
    }
  }

  private fun cancelLocked(id: String) {
    pending.remove(id)?.let { state ->
      state.call.cancel()
      state.helperClient?.let { closeClient(it) }
      main.post { state.promise.reject("E_CANCELLED", "The request was cancelled.", null) }
    }
  }

  private fun resetLocked() {
    pending.keys.toList().forEach { cancelLocked(it) }
    pendingConfiguration?.let {
      closeClient(it.candidate.client)
      it.promise.reject("E_CANCELLED", "Connection setup was cancelled.", null)
    }
    pendingConfiguration = null
    configuration?.client?.let { closeClient(it) }
    configuration = null
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
