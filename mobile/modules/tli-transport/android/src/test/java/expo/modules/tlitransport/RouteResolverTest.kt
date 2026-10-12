package expo.modules.tlitransport

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class RouteResolverTest {
  @Test fun dnsResultsRemainPrivateHints() {
    val resolver=RouteResolver { listOf("127.0.0.1","8.8.8.8","192.168.1.8","192.168.1.8","10.5.2.8","::1") }
    try { assertEquals(listOf("192.168.1.8","10.5.2.8"),resolver.resolve("https://tli.local:9443",500)) }
    finally { resolver.close() }
  }
  @Test fun literalOriginsDoNotResolveDns() {
    val resolver=RouteResolver { throw AssertionError("Unexpected DNS") }
    try {
      assertEquals(listOf("192.168.1.8"),resolver.resolve("https://192.168.1.8:9443",500))
      assertThrows(TransportFailure::class.java) { resolver.resolve("https://public.example:443",500) }
    } finally { resolver.close() }
  }
  @Test fun blockedDnsHasADeadlineAndBoundedWorkers() {
    val finish=CountDownLatch(1)
    val resolver=RouteResolver { finish.await(5,TimeUnit.SECONDS);listOf("10.2.3.4") }
    try {
      val start=System.nanoTime()
      assertThrows(TransportFailure::class.java) { resolver.resolve("https://one.local:8443",100) }
      assertThrows(TransportFailure::class.java) { resolver.resolve("https://two.local:8443",100) }
      assertThrows(TransportFailure::class.java) { resolver.resolve("https://three.local:8443",100) }
      assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-start)<2000)
    } finally { finish.countDown();resolver.close() }
  }
}
