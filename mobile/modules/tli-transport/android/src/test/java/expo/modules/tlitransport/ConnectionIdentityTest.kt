package expo.modules.tlitransport

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConnectionIdentityTest {
  private val privateKey = Ed25519PrivateKeyParameters(ByteArray(32) { (it + 1).toByte() }, 0)
  private val publicKey = ConnectionIdentity.hex(privateKey.generatePublicKey().encoded)
  private val origin = "https://studio-tli.local:8443"
  private val nonce = "a".repeat(48)
  private val pin = "b".repeat(64)
  private val now = 1700000000L

  private fun signed(node: String = "tli-雪", changes: Map<String, Any> = emptyMap()): String {
    val fields = sortedMapOf<String, Any>("protocol" to "tli-endpoint-v1", "node_id" to node,
      "public_key" to publicKey, "origin" to origin, "certificate_sha256" to pin,
      "nonce" to nonce, "issued_at" to now, "expires_at" to now + 60)
    fields.putAll(changes)
    val bytes = fields.entries.joinToString(",", "{", "}") { (key, value) ->
      ConnectionIdentity.quote(key) + ":" + if (value is String) ConnectionIdentity.quote(value) else value.toString()
    }.toByteArray(Charsets.UTF_8)
    val signer = Ed25519Signer(); signer.init(true, privateKey); signer.update(bytes, 0, bytes.size)
    return JSONObject(fields as Map<*, *>).put("signature", ConnectionIdentity.hex(signer.generateSignature())).toString()
  }

  @Test fun verifiesSavedIdentityWithFreshNonceAndPinnedCertificate() {
    val result = ConnectionIdentity.verify(signed(), "tli-雪", publicKey, origin, pin, nonce, now)
    assertEquals(true, result["verified"])
    assertEquals(origin, result["origin"])
  }
  @Test fun verifiesIndependentPythonCryptographyFixtureWithUnicode() {
    // Python cryptography Ed25519, seed bytes(range(32)); json.dumps sort_keys,
    // ensure_ascii=False, separators=(',', ':'). No production key material.
    val fixture = """{"protocol":"tli-endpoint-v1","node_id":"tli-\u96ea\"one","public_key":"03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8","origin":"https://studio-tli.local:8443","certificate_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","issued_at":1700000000,"expires_at":1700000060,"signature":"c24d9b39ac9d935eaee5b2229bbe50faac44625fdf430c7ee5bc5cb3d1a85703c2db0d3e82a69e273827b831be3b9221b7f6fc28ae1c48e2cd840a64a3af0e0c"}"""
    assertEquals(true, ConnectionIdentity.verify(fixture, "tli-雪\"one", "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8", origin, pin, nonce, now)["verified"])
  }
  @Test fun signedButWrongBindingsNeverVerify() {
    for (changes in listOf(mapOf("node_id" to "other"), mapOf("public_key" to "d".repeat(64)), mapOf("origin" to "https://other.local:8443"),
      mapOf("nonce" to "c".repeat(48)), mapOf("certificate_sha256" to "c".repeat(64)),
      mapOf("issued_at" to now - 200, "expires_at" to now - 140), mapOf("issued_at" to now + 60, "expires_at" to now + 120),
      mapOf("expires_at" to now + 500), mapOf("extra" to "value"))) {
      assertThrows(TransportFailure::class.java) { ConnectionIdentity.verify(signed(changes = changes), "tli-雪", publicKey, origin, pin, nonce, now) }
    }
  }
  @Test fun modifiedSignatureAndNumericCoercionAreRejected() {
    for (body in listOf(JSONObject(signed()).put("signature", "0".repeat(128)).toString(),
      JSONObject(signed()).put("issued_at", now.toString()).toString(),
      signed().replace("\"expires_at\":${now + 60}", "\"expires_at\":${now + 60}.0"))) {
      assertThrows(TransportFailure::class.java) { ConnectionIdentity.verify(body, "tli-雪", publicKey, origin, pin, nonce, now) }
    }
  }
  @Test fun privateRoutesAreBoundedAndCanonical() {
    assertEquals("https://studio-tli.local:8443", TransportPolicy.origin(origin))
    assertEquals("https://studio-tli.local:443", TransportPolicy.origin("https://studio-tli.local"))
    assertEquals("https://studio-tli.local:443", TransportPolicy.origin("https://studio-tli.local:443/"))
    assertEquals(listOf("192.168.1.2"), TransportPolicy.addresses(listOf("192.168.1.2", "192.168.1.2")))
    for (value in listOf("https://x.y.local", "https://X.local", "https://evil.example", "https://tli.local@evil.local", "https://-tli.local")) {
      assertThrows(TransportFailure::class.java) { TransportPolicy.origin(value) }
    }
    for (values in listOf(emptyList(), List(9) { "192.168.1.2" }, listOf("127.0.0.1"), listOf("8.8.8.8"), listOf("192.168.001.2"), listOf("tli.local"))) {
      assertThrows(TransportFailure::class.java) { TransportPolicy.addresses(values) }
    }
  }
}
