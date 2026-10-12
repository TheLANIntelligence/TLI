package expo.modules.tlitransport

import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom

/** No credentials enter this protocol. Discovery supplies routes, never trust. */
internal object ConnectionIdentity {
  const val PATH = "/api/connection/v1/identity"
  private val keys = setOf("protocol", "node_id", "public_key", "origin", "certificate_sha256", "nonce", "issued_at", "expires_at", "signature")
  fun nonce(): String = hex(ByteArray(24).also { SecureRandom().nextBytes(it) })
  fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
  fun fingerprint(der: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(der))

  fun validateInput(nodeId: String, publicKey: String, nonce: String) {
    if (nodeId.isEmpty() || nodeId.length > 128 || nodeId.any { it < ' ' || it == '\u007f' } ||
      !Regex("^[0-9a-f]{64}$").matches(publicKey) || !Regex("^[0-9a-f]{48}$").matches(nonce)) {
      throw TransportFailure("E_IDENTITY", "The saved TLI identity or challenge is invalid.")
    }
  }

  fun request(nodeId: String, origin: String, nonce: String): String =
    JSONObject().put("node_id", nodeId).put("origin", origin).put("nonce", nonce).toString()

  fun verify(body: String, nodeId: String, publicKey: String, origin: String, certificateSha256: String,
             nonce: String, now: Long = System.currentTimeMillis() / 1000): Map<String, Any> {
    validateInput(nodeId, publicKey, nonce)
    if (body.toByteArray(Charsets.UTF_8).size > 16384) fail()
    val document = try { JSONObject(body) } catch (_: Exception) { fail() }
    if (document.keys().asSequence().toSet() != keys || document.opt("protocol") != "tli-endpoint-v1" ||
      document.opt("node_id") != nodeId || document.opt("public_key") != publicKey ||
      document.opt("origin") != origin || document.opt("certificate_sha256") != certificateSha256 ||
      document.opt("nonce") != nonce) fail()
    val issued = integer(document.opt("issued_at"))
    val expires = integer(document.opt("expires_at"))
    if (issued > now + 30 || issued < now - 120 || expires < now || expires <= issued || expires - issued > 120) fail()
    val signature = document.opt("signature") as? String ?: fail()
    if (!Regex("^[0-9a-f]{128}$").matches(signature)) fail()
    val unsigned = keys.filter { it != "signature" }.sorted().joinToString(",", "{", "}") { key ->
      quote(key) + ":" + when (val value = document.get(key)) {
        is String -> quote(value)
        else -> integer(value).toString()
      }
    }.toByteArray(Charsets.UTF_8)
    val verifier = Ed25519Signer()
    verifier.init(false, Ed25519PublicKeyParameters(bytes(publicKey), 0))
    verifier.update(unsigned, 0, unsigned.size)
    if (!verifier.verifySignature(bytes(signature))) fail()
    return mapOf("verified" to true, "origin" to origin, "nodeId" to nodeId,
      "publicKey" to publicKey, "certificateSha256" to certificateSha256)
  }

  /** Python json.dumps(..., ensure_ascii=False, separators=(',', ':'), sort_keys=True). */
  internal fun quote(value: String): String = buildString {
    append('"')
    value.forEach { char -> when (char) {
      '"' -> append("\\\""); '\\' -> append("\\\\"); '\b' -> append("\\b")
      '\u000c' -> append("\\f"); '\n' -> append("\\n"); '\r' -> append("\\r"); '\t' -> append("\\t")
      else -> if (char < ' ') append("\\u%04x".format(char.code)) else append(char)
    } }
    append('"')
  }

  private fun integer(value: Any?): Long = when (value) {
    is Int -> value.toLong()
    is Long -> value
    else -> fail()
  }
  private fun bytes(value: String): ByteArray = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
  private fun fail(): Nothing = throw TransportFailure("E_IDENTITY", "The endpoint did not prove the saved TLI identity. No credential was sent.")
}
