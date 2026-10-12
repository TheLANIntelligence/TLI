package expo.modules.tlitransport

import java.net.URI
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction

internal const val MAX_RESPONSE_BYTES = 8 * 1024 * 1024
internal const val MAX_REQUEST_BYTES = 16 * 1024 * 1024
internal const val MAX_UPLOAD_BYTES = 8 * 1024 * 1024
internal const val MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024

internal class TransportFailure(val code: String, message: String) : Exception(message)

internal object TransportPolicy {
  private val originPattern = Regex("^https://([a-z0-9.-]+)(?::([0-9]+))?/?$")
  private val localHostname = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.local$")
  private val headerName = Regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
  private val forbiddenHeaders = setOf(
    "host", "connection", "content-length", "transfer-encoding", "upgrade",
    "proxy-authorization", "proxy-connection", "cookie", "te", "trailer"
  )
  private val methods = setOf("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")

  fun origin(value: String): String {
    val match = originPattern.matchEntire(value)
      ?: throw TransportFailure("E_ORIGIN", "Use an HTTPS origin with a private LAN IPv4 address.")
    val host = match.groupValues[1]
    if (!localHostname.matches(host)) privateAddress(host)
    val portText = match.groupValues[2]
    if (portText.isNotEmpty()) {
      val port = portText.toIntOrNull()
      if (port == null || port !in 1..65535 || port.toString() != portText) {
        throw TransportFailure("E_ORIGIN", "The HTTPS port is invalid.")
      }
    }
    return if (localHostname.matches(host) && portText.isEmpty()) "https://$host:443" else value.removeSuffix("/")
  }

  fun isHostname(origin: String): Boolean = URI(origin).host.endsWith(".local")

  fun privateAddress(value: String): String {
    val text = value.split('.')
    if (text.size != 4) throw TransportFailure("E_ORIGIN", "Use a canonical private LAN IPv4 address or reviewed .local hostname.")
    val parts = text.map { part ->
      val number = part.toIntOrNull()
      if (number == null || number !in 0..255 || number.toString() != part) {
        throw TransportFailure("E_ORIGIN", "The LAN IPv4 address is invalid.")
      }
      number
    }
    val privateAddress = parts[0] == 10 ||
      (parts[0] == 172 && parts[1] in 16..31) ||
      (parts[0] == 192 && parts[1] == 168) ||
      (parts[0] == 169 && parts[1] == 254)
    if (!privateAddress) throw TransportFailure("E_ORIGIN", "TLI beta connections require a private LAN address.")
    return value
  }

  fun addresses(values: List<String>): List<String> {
    if (values.isEmpty() || values.size > 8) throw TransportFailure("E_DISCOVERY", "Resolve 1–8 private LAN addresses before connecting.")
    return values.map { privateAddress(it) }.distinct()
  }

  fun requestUrl(origin: String, path: String): String {
    if (!path.startsWith('/') || path.startsWith("//") || path.length > 8192 ||
      path.any { it <= ' ' || it == '\u007f' || it == '\\' || it == '#' }) {
      throw TransportFailure("E_PATH", "Requests must use a relative path on the paired TLI node.")
    }
    val base = URI(origin)
    val candidate = try { URI(origin + path) } catch (_: Exception) {
      throw TransportFailure("E_PATH", "The request path is invalid.")
    }
    if (candidate.scheme != "https" || candidate.host != base.host || candidate.port != base.port ||
      candidate.userInfo != null || candidate.fragment != null) {
      throw TransportFailure("E_PATH", "The request must stay on the paired TLI origin.")
    }
    return candidate.toASCIIString()
  }

  fun method(value: String): String {
    if (value !in methods) throw TransportFailure("E_METHOD", "The request method is unsupported.")
    return value
  }

  fun helperRequest(method: String, path: String, headers: Map<String, String>, body: String?, stream: Boolean) {
    val status = method == "GET" && (path == "/host-control/v1/status" || path.startsWith("/host-control/v1/status?")) && body == null
    val start = method == "POST" && path == "/host-control/v1/start"
    val credential = headers.entries.singleOrNull { it.key.equals("Authorization", ignoreCase = true) }?.value
    if ((!status && !start) || stream || (body?.toByteArray(Charsets.UTF_8)?.size ?: 0) > 4096 ||
      credential == null || !Regex("^Bearer tlih_[0-9a-f]{64}$").matches(credential)) {
      throw TransportFailure("E_HELPER_SCOPE", "Use only the reviewed helper status/start connection and its restricted credential.")
    }
  }

  fun shouldStream(requested: Boolean, status: Int): Boolean = requested && status in 200..299

  fun headers(headers: Map<String, String>) {
    if (headers.size > 64) throw TransportFailure("E_HEADERS", "Too many request headers.")
    val names = mutableSetOf<String>()
    var length = 0
    for ((name, value) in headers) {
      length += name.length + value.length
      if (!headerName.matches(name) || name.lowercase() in forbiddenHeaders ||
        !names.add(name.lowercase()) || value.any { it < ' ' || it > '~' }) {
        throw TransportFailure("E_HEADERS", "A request header is invalid or reserved for the transport.")
      }
    }
    if (length > 32768) throw TransportFailure("E_HEADERS", "The request headers are too large.")
  }
}

/** Holds incomplete UTF-8 bytes between reads, never emits a partial surrogate pair. */
internal class IncrementalUtf8Decoder {
  private val decoder = Charsets.UTF_8.newDecoder()
    .onMalformedInput(CodingErrorAction.REPORT)
    .onUnmappableCharacter(CodingErrorAction.REPORT)
  private var pending = byteArrayOf()

  fun decode(bytes: ByteArray, count: Int = bytes.size, end: Boolean = false): String {
    val combined = pending + bytes.copyOfRange(0, count)
    val input = ByteBuffer.wrap(combined)
    val output = CharBuffer.allocate(combined.size + 2)
    decoder.decode(input, output, end).throwIfError()
    pending = ByteArray(input.remaining()).also { input.get(it) }
    if (end) decoder.flush(output).throwIfError()
    output.flip()
    return output.toString()
  }

  private fun java.nio.charset.CoderResult.throwIfError() {
    if (isError) throwException()
    if (isOverflow) throw TransportFailure("E_ENCODING", "The response could not be decoded safely.")
  }
}
