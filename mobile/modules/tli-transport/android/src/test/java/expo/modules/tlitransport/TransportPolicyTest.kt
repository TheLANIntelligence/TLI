package expo.modules.tlitransport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.charset.CharacterCodingException

class TransportPolicyTest {
  @Test fun helperScopeRejectsMainCredentialsAndUnrelatedRoutes() {
    val headers = mapOf("Authorization" to "Bearer tlih_" + "a".repeat(64))
    TransportPolicy.helperRequest("GET", "/host-control/v1/status?node_id=n&helper_id=h", headers, null, false)
    TransportPolicy.helperRequest("POST", "/host-control/v1/start", headers, "{}", false)
    for (path in listOf("/api/actions", "//other/start", "/host-control/v1/start?other=1")) {
      assertThrows(TransportFailure::class.java) { TransportPolicy.helperRequest("POST", path, headers, "{}", false) }
    }
    assertThrows(TransportFailure::class.java) { TransportPolicy.helperRequest("POST", "/host-control/v1/start", mapOf("Authorization" to "Bearer main-session-token"), "{}", false) }
    assertThrows(TransportFailure::class.java) { TransportPolicy.helperRequest("GET", "/host-control/v1/status", headers, null, true) }
    assertThrows(TransportFailure::class.java) { TransportPolicy.helperRequest("POST", "/host-control/v1/start", headers, "a".repeat(4097), false) }
  }
  @Test fun failureCategoriesFollowNativeEvidenceWithoutGuessingTheCause() {
    assertEquals("E_TIMEOUT", transportError(java.net.SocketTimeoutException()).first)
    assertEquals("E_CONNECT", transportError(java.net.ConnectException()).first)
    assertEquals("E_NO_ROUTE", transportError(java.net.NoRouteToHostException()).first)
    assertEquals("E_TLS_TRUST", transportError(javax.net.ssl.SSLHandshakeException("sample")).first)
    assertEquals("E_TLS_TRUST", transportError(java.security.cert.CertificateException()).first)
    assertEquals("E_NETWORK", transportError(java.io.IOException("unknown cause")).first)
    assertEquals("E_CANCELLED", transportError(TransportFailure("E_CANCELLED", "sample")).first)
  }

  @Test fun buffersHttpErrorsEvenWhenStreamingWasRequested() {
    assertTrue(TransportPolicy.shouldStream(true, 200))
    assertFalse(TransportPolicy.shouldStream(false, 200))
    for (status in listOf(400, 401, 403, 409, 413, 429, 500)) {
      assertFalse(TransportPolicy.shouldStream(true, status))
    }
  }

  @Test fun acceptsOnlyCanonicalPrivateOrigins() {
    for (origin in listOf("https://10.0.0.8:8000", "https://172.16.0.8", "https://192.168.2.3", "https://169.254.2.3")) {
      assertEquals(origin, TransportPolicy.origin("$origin/"))
    }
    for (origin in listOf(
      "http://192.168.1.8", "https://example.com", "https://127.0.0.1", "https://8.8.8.8",
      "https://172.15.0.8", "https://172.32.0.8", "https://192.168.1.256", "https://010.0.0.8",
      "https://192.168.1.8:0", "https://192.168.1.8:65536", "https://192.168.1.8:0443",
      "https://user@192.168.1.8", "https://192.168.1.8/path", "https://192.168.1.8?x=1", "https://192.168.1.8#x"
    )) assertThrows(origin, TransportFailure::class.java) { TransportPolicy.origin(origin) }
  }

  @Test fun pathsCannotEscapeThePairedOrigin() {
    val origin = "https://192.168.1.8:8000"
    assertEquals("$origin/companion/overview?since=12", TransportPolicy.requestUrl(origin, "/companion/overview?since=12"))
    for (path in listOf("https://8.8.8.8/", "//8.8.8.8/", "/\\8.8.8.8/", "/x#fragment", "/x\r\nHost: evil")) {
      assertThrows(path, TransportFailure::class.java) { TransportPolicy.requestUrl(origin, path) }
    }
  }

  @Test fun requestHeadersCannotOverrideRoutingOrFraming() {
    TransportPolicy.headers(mapOf("Authorization" to "Bearer token", "Content-Type" to "application/json"))
    for (name in listOf("Host", "cOnNeCtIoN", "Content-Length", "Transfer-Encoding", "Proxy-Authorization", "Cookie")) {
      assertThrows(name, TransportFailure::class.java) { TransportPolicy.headers(mapOf(name to "value")) }
    }
    assertThrows(TransportFailure::class.java) { TransportPolicy.headers(mapOf("Authorization" to "Bearer x\r\nHost: evil")) }
    assertThrows(TransportFailure::class.java) { TransportPolicy.headers(mapOf("Host\n" to "evil")) }
    assertThrows(TransportFailure::class.java) { TransportPolicy.headers(mapOf("Accept" to "a", "accept" to "b")) }
  }

  @Test fun streamingPreservesUnicodeAtEveryPossibleByteBoundary() {
    val text = "data: {\"token\":\"🦉 café 漢字\"}\r\n\r\n"
    val bytes = text.toByteArray(Charsets.UTF_8)
    for (split in 0..bytes.size) {
      val decoder = IncrementalUtf8Decoder()
      val result = decoder.decode(bytes.copyOfRange(0, split)) +
        decoder.decode(bytes.copyOfRange(split, bytes.size)) + decoder.decode(byteArrayOf(), end = true)
      assertEquals("split $split", text, result)
    }
    val decoder = IncrementalUtf8Decoder()
    val result = bytes.joinToString("") { decoder.decode(byteArrayOf(it)) } + decoder.decode(byteArrayOf(), end = true)
    assertEquals(text, result)
  }

  @Test fun rejectsMalformedAndTruncatedUtf8() {
    for (bytes in listOf(
      byteArrayOf(0xc0.toByte(), 0xaf.toByte()),
      byteArrayOf(0xed.toByte(), 0xa0.toByte(), 0x80.toByte()),
      byteArrayOf(0xf4.toByte(), 0x90.toByte(), 0x80.toByte(), 0x80.toByte()),
      byteArrayOf(0xf0.toByte(), 0x9f.toByte())
    )) {
      val decoder = IncrementalUtf8Decoder()
      assertThrows(CharacterCodingException::class.java) { decoder.decode(bytes, end = true) }
    }
  }
}
