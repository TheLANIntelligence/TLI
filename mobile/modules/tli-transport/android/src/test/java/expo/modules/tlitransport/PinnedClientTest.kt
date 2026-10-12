package expo.modules.tlitransport

import okhttp3.Call
import okhttp3.EventListener
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.net.InetSocketAddress
import java.net.InetAddress
import java.net.Proxy
import java.security.cert.CertificateExpiredException
import java.security.cert.CertificateNotYetValidException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

/** Real JVM handshakes through the same PinnedClient used by the Expo module.
 * Loopback is only a fixture transport here: TransportPolicyTest separately
 * proves production routes cannot be loopback or public addresses. Reviewed
 * .local hosts resolve only to bounded private candidates, preserving TLS SNI.
 * Every key/certificate is generated in memory; request data is dummy data.
 */
class PinnedClientTest {
  private val credential = "Bearer test-only-companion-credential"
  private val payload = "{\"message\":\"test-only image question\",\"image_b64\":\"dGVzdA==\"}"
  private val hour = TimeUnit.HOURS.toMillis(1)
  private val testLoopbackDns = object : Dns {
    override fun lookup(hostname: String): List<InetAddress> = listOf(InetAddress.getByName("127.0.0.1"))
  }

  private fun certificate(san: String = "127.0.0.1"): HeldCertificate {
    val now = System.currentTimeMillis()
    return HeldCertificate.Builder().commonName("TLI test")
      .addSubjectAlternativeName(san)
      .validityInterval(now - hour, now + hour).build()
  }

  private fun server(certificate: HeldCertificate): MockWebServer = MockWebServer().apply {
    val tls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
    useHttps(tls.sslSocketFactory(), false)
    // Avoid JVM/ALPN variability; the client still uses the production verifier.
    protocolNegotiationEnabled = false
    enqueue(MockResponse().setBody("{\"ok\":true}"))
    start(InetAddress.getByName("127.0.0.1"), 0)
  }

  private fun url(server: MockWebServer): HttpUrl = server.url("/api/companion/v1/bootstrap")
    .newBuilder().host("127.0.0.1").build()

  private fun request(url: HttpUrl): Request = Request.Builder().url(url)
    .header("Authorization", credential)
    .header("Content-Type", "application/json")
    .post(payload.toRequestBody()).build()

  private fun close(client: OkHttpClient?) {
    client?.dispatcher?.cancelAll()
    client?.connectionPool?.evictAll()
    client?.dispatcher?.executorService?.shutdown()
  }

  private class Writes : EventListener() {
    val connections = AtomicInteger()
    val headers = AtomicInteger()
    val bodies = AtomicInteger()
    override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) { connections.incrementAndGet() }
    override fun requestHeadersStart(call: Call) { headers.incrementAndGet() }
    override fun requestBodyStart(call: Call) { bodies.incrementAndGet() }
  }

  @Test fun pairedCertificateSendsCredentialsAndBodyOnlyAfterSuccessfulHandshake() {
    val paired = certificate()
    val server = server(paired)
    val writes = Writes()
    val client = PinnedClient.create(paired.certificate).newBuilder()
      .eventListener(writes).callTimeout(5, TimeUnit.SECONDS).build()
    try {
      assertFalse(client.followRedirects)
      assertFalse(client.followSslRedirects)
      assertFalse(client.retryOnConnectionFailure)
      client.newCall(request(url(server))).execute().use { response ->
        assertEquals(200, response.code)
        assertEquals("{\"ok\":true}", response.body!!.string())
        assertNotNull(response.handshake)
      }
      val received = server.takeRequest(1, TimeUnit.SECONDS)!!
      assertEquals(credential, received.getHeader("Authorization"))
      assertEquals(payload, received.body.readUtf8())
      assertEquals(1, writes.connections.get())
      assertEquals(1, writes.headers.get())
      assertEquals(1, writes.bodies.get())
      assertEquals(1, server.requestCount)
    } finally { close(client); server.shutdown() }
  }

  private fun <T : Throwable> rejectsWithoutSending(
    presented: HeldCertificate,
    paired: X509Certificate,
    failure: Class<T>,
    expectedConnections: Int
  ) {
    val server = server(presented)
    val writes = Writes()
    val sensitiveRequest = request(url(server))
    var client: OkHttpClient? = null
    try {
      assertThrows(failure) {
        client = PinnedClient.create(paired).newBuilder()
          .eventListener(writes).callTimeout(5, TimeUnit.SECONDS).build()
        client!!.newCall(sensitiveRequest).execute().use { it.body?.string() }
      }
      // The client did not begin writing HTTP, and the peer received no request.
      assertEquals(expectedConnections, writes.connections.get())
      assertEquals(0, writes.headers.get())
      assertEquals(0, writes.bodies.get())
      assertNull(server.takeRequest(200, TimeUnit.MILLISECONDS))
      assertEquals(0, server.requestCount)
    } finally { close(client); server.shutdown() }
  }

  @Test fun aDifferentCertificateCannotReceiveAuthorizationOrBody() {
    rejectsWithoutSending(certificate(), certificate().certificate, SSLHandshakeException::class.java, 1)
  }

  @Test fun reissuedCertificateWithSamePublicKeyStillRequiresPairing() {
    val paired = certificate()
    val now = System.currentTimeMillis()
    val replacement = HeldCertificate.Builder().commonName("TLI test")
      .keyPair(paired.keyPair).serialNumber(2L).addSubjectAlternativeName("127.0.0.1")
      .validityInterval(now - hour, now + hour).build()
    rejectsWithoutSending(replacement, paired.certificate, SSLHandshakeException::class.java, 1)
  }

  @Test fun expiredPairedCertificateFailsBeforeOpeningAConnection() {
    val now = System.currentTimeMillis()
    val expired = HeldCertificate.Builder().commonName("TLI expired test")
      .addSubjectAlternativeName("127.0.0.1")
      .validityInterval(now - 2 * hour, now - hour).build()
    rejectsWithoutSending(expired, expired.certificate, CertificateExpiredException::class.java, 0)
  }

  @Test fun notYetValidPairedCertificateFailsBeforeOpeningAConnection() {
    val now = System.currentTimeMillis()
    val future = HeldCertificate.Builder().commonName("TLI future test")
      .addSubjectAlternativeName("127.0.0.1")
      .validityInterval(now + hour, now + 2 * hour).build()
    rejectsWithoutSending(future, future.certificate, CertificateNotYetValidException::class.java, 0)
  }

  @Test fun pairedCertificateWithWrongHostnameCannotReceiveAuthorizationOrBody() {
    val wrongHost = certificate("192.168.50.20")
    rejectsWithoutSending(wrongHost, wrongHost.certificate, SSLPeerUnverifiedException::class.java, 1)
  }

  @Test fun redirectDoesNotSendCredentialsOrBodyToAnotherServer() {
    val paired = certificate()
    val source = MockWebServer()
    val destination = server(paired)
    val tls = HandshakeCertificates.Builder().heldCertificate(paired).build()
    source.useHttps(tls.sslSocketFactory(), false)
    source.protocolNegotiationEnabled = false
    source.enqueue(MockResponse().setResponseCode(307).addHeader("Location", url(destination).toString()))
    source.start(InetAddress.getByName("127.0.0.1"), 0)
    val client = PinnedClient.create(paired.certificate)
    try {
      client.newCall(request(url(source))).execute().use { response -> assertEquals(307, response.code) }
      val original = source.takeRequest(1, TimeUnit.SECONDS)!!
      assertEquals(credential, original.getHeader("Authorization"))
      assertEquals(payload, original.body.readUtf8())
      assertNull(destination.takeRequest(200, TimeUnit.MILLISECONDS))
      assertEquals(0, destination.requestCount)
    } finally { close(client); source.shutdown(); destination.shutdown() }
  }

  @Test fun reviewedHostnameUsesOnlySuppliedRoutesAndKeepsHostnameVerification() {
    val paired = certificate("studio.local")
    val base = PinnedClient.create(paired.certificate, "studio.local", listOf("192.168.5.8"))
    assertEquals(listOf("192.168.5.8"), base.dns.lookup("studio.local").map { it.hostAddress })
    assertThrows(java.net.UnknownHostException::class.java) { base.dns.lookup("other.local") }
    val server = server(paired)
    // Only the test route maps to loopback; production DNS above rejects it.
    val client = base.newBuilder().dns(testLoopbackDns).build()
    try {
      val target = url(server).newBuilder().host("studio.local").build()
      val binary = byteArrayOf(0, 0xff.toByte(), 0xc0.toByte(), 10)
      val request = Request.Builder().url(target).header("Authorization", credential)
        .header("Content-Type", "application/octet-stream").post(binary.toRequestBody()).build()
      client.newCall(request).execute().use { assertEquals(200, it.code) }
      val received = server.takeRequest(1, TimeUnit.SECONDS)!!
      assertEquals("studio.local:${server.port}", received.getHeader("Host"))
      org.junit.Assert.assertArrayEquals(binary, received.body.readByteArray())
    } finally { close(client); close(base); server.shutdown() }
  }

  @Test fun hostnameMismatchDoesNotSendBinaryDocumentOrCredential() {
    val paired = certificate("other.local")
    val server = server(paired)
    val writes = Writes()
    val client = PinnedClient.create(paired.certificate, "studio.local", listOf("192.168.5.8"))
      .newBuilder().dns(testLoopbackDns).eventListener(writes).build()
    try {
      assertThrows(SSLPeerUnverifiedException::class.java) {
        client.newCall(request(url(server).newBuilder().host("studio.local").build())).execute().close()
      }
      assertEquals(0, writes.headers.get()); assertEquals(0, writes.bodies.get())
      assertNull(server.takeRequest(200, TimeUnit.MILLISECONDS))
    } finally { close(client); server.shutdown() }
  }
}
