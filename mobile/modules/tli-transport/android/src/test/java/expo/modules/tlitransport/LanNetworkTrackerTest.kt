package expo.modules.tlitransport

import org.junit.Assert.*
import org.junit.Test

class LanNetworkTrackerTest {
  private val wifi = LanNetworkRoute(1, true, true, "wlan0", listOf("192.168.1.4/24"), listOf("192.168.1.0/24", "default via 192.168.1.1"), listOf("192.168.1.1"))

  @Test fun initialAndRepeatedCallbacksDoNotCauseReconnectLoops() {
    val tracker = LanNetworkTracker(listOf(wifi))
    repeat(4) { assertFalse(tracker.changed(listOf(wifi))) }
    assertFalse(tracker.changed(listOf(wifi.copy(routes = wifi.routes.reversed()))))
  }

  @Test fun unrelatedCellularEventsDoNotInvalidateLan() {
    val tracker = LanNetworkTracker(listOf(wifi))
    assertFalse(tracker.changed(listOf(wifi, LanNetworkRoute(2, false, false, "rmnet0", listOf("10.4.2.1/24")))))
    assertFalse(tracker.changed(listOf(wifi)))
  }

  @Test fun addressRouteDnsInterfaceAndActiveNetworkChangesRequireProofAgain() {
    for (changed in listOf(wifi.copy(addresses = listOf("192.168.1.9/24")), wifi.copy(routes = listOf("default via 192.168.1.2")),
      wifi.copy(dns = listOf("192.168.1.2")), wifi.copy(interfaceName = "eth0"), wifi.copy(active = false), wifi.copy(id = 3))) {
      val tracker = LanNetworkTracker(listOf(wifi))
      assertTrue(tracker.changed(listOf(changed)))
      assertFalse(tracker.changed(listOf(changed)))
    }
  }

  @Test fun lostAndReturnedLanAreSeparateTransitions() {
    val tracker = LanNetworkTracker(listOf(wifi))
    assertTrue(tracker.changed(emptyList()))
    assertFalse(tracker.changed(emptyList()))
    assertTrue(tracker.changed(listOf(wifi)))
    assertFalse(tracker.changed(listOf(wifi)))
  }
}
