import Foundation
import XCTest
@testable import TliTransport

final class TransportPolicyTests: XCTestCase {
  func testHelperScopeRejectsMainCredentialsAndUnrelatedRoutes() throws {
    let headers = ["Authorization": "Bearer tlih_" + String(repeating: "a", count: 64)]
    try TransportPolicy.helperRequest(method: "GET", path: "/host-control/v1/status?node_id=n&helper_id=h", headers: headers, body: nil, stream: false)
    try TransportPolicy.helperRequest(method: "POST", path: "/host-control/v1/start", headers: headers, body: "{}", stream: false)
    for path in ["/api/actions", "//other/start", "/host-control/v1/start?other=1"] {
      XCTAssertThrowsError(try TransportPolicy.helperRequest(method: "POST", path: path, headers: headers, body: "{}", stream: false))
    }
    XCTAssertThrowsError(try TransportPolicy.helperRequest(method: "POST", path: "/host-control/v1/start", headers: ["Authorization": "Bearer main-session-token"], body: "{}", stream: false))
    XCTAssertThrowsError(try TransportPolicy.helperRequest(method: "GET", path: "/host-control/v1/status", headers: headers, body: nil, stream: true))
    XCTAssertThrowsError(try TransportPolicy.helperRequest(method: "POST", path: "/host-control/v1/start", headers: headers, body: String(repeating: "a", count: 4097), stream: false))
  }
  func testBuffersHttpErrorsEvenWhenStreamingWasRequested() {
    XCTAssertTrue(TransportPolicy.shouldStream(requested: true, status: 200))
    XCTAssertFalse(TransportPolicy.shouldStream(requested: false, status: 200))
    for status in [400, 401, 403, 409, 413, 429, 500] {
      XCTAssertFalse(TransportPolicy.shouldStream(requested: true, status: status))
    }
  }

  func testOnlyCanonicalPrivateOriginsAreAccepted() throws {
    for origin in ["https://10.0.0.8:8000", "https://172.16.0.8", "https://192.168.2.3", "https://169.254.2.3"] {
      XCTAssertEqual(try TransportPolicy.origin(origin + "/").absoluteString, origin)
    }
    for origin in ["http://192.168.1.8", "https://example.com", "https://127.0.0.1", "https://8.8.8.8",
      "https://172.15.0.8", "https://172.32.0.8", "https://192.168.1.256", "https://010.0.0.8",
      "https://192.168.1.8:0", "https://192.168.1.8:65536", "https://192.168.1.8:0443",
      "https://user@192.168.1.8", "https://192.168.1.8/path", "https://192.168.1.8?x=1", "https://192.168.1.8#x"] {
      XCTAssertThrowsError(try TransportPolicy.origin(origin), origin)
    }
  }

  func testRequestCannotOverrideOriginOrFraming() throws {
    let origin = try TransportPolicy.origin("https://192.168.1.8:8000")
    XCTAssertEqual(try TransportPolicy.requestURL(origin: origin, path: "/companion/overview?since=12").absoluteString,
      "https://192.168.1.8:8000/companion/overview?since=12")
    for path in ["https://8.8.8.8/", "//8.8.8.8/", "/\\8.8.8.8/", "/x#fragment", "/x\r\nHost: evil"] {
      XCTAssertThrowsError(try TransportPolicy.requestURL(origin: origin, path: path), path)
    }
    for name in ["Host", "cOnNeCtIoN", "Content-Length", "Transfer-Encoding", "Proxy-Authorization", "Cookie"] {
      XCTAssertThrowsError(try TransportPolicy.validate(method: "POST", headers: [name: "value"], body: "{}"), name)
    }
    XCTAssertThrowsError(try TransportPolicy.validate(method: "POST", headers: ["Authorization": "x\r\nHost: evil"], body: nil))
    XCTAssertThrowsError(try TransportPolicy.validate(method: "POST", headers: ["Host\n": "evil"], body: nil))
    XCTAssertThrowsError(try TransportPolicy.validate(method: "GET", headers: [:], body: "payload"))
  }

  func testStreamingPreservesUnicodeAtEveryByteBoundary() throws {
    let text = "data: {\"token\":\"🦉 café 漢字\"}\r\n\r\n"
    let data = Data(text.utf8)
    for split in 0...data.count {
      var decoder = IncrementalUTF8Decoder()
      let first = try decoder.decode(Data(data.prefix(split)))
      let second = try decoder.decode(Data(data.dropFirst(split)))
      let final = try decoder.decode(Data(), end: true)
      XCTAssertEqual(first + second + final, text, "split \(split)")
    }
    var decoder = IncrementalUTF8Decoder()
    var result = ""
    for byte in data { result += try decoder.decode(Data([byte])) }
    result += try decoder.decode(Data(), end: true)
    XCTAssertEqual(result, text)
  }

  func testRejectsInvalidUtf8() {
    let invalid: [[UInt8]] = [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf0, 0x9f]]
    for bytes in invalid {
      var decoder = IncrementalUTF8Decoder()
      XCTAssertThrowsError(try decoder.decode(Data(bytes), end: true))
    }
  }

  func testCertificateDatesUseRFC5280YearWindowAndRejectExpiry() throws {
    let validity = try CertificateValidity(der: validityFixture(before: "500101000000Z", after: "490101000000Z"))
    let formatter = ISO8601DateFormatter()
    XCTAssertEqual(validity.notBefore, formatter.date(from: "1950-01-01T00:00:00Z"))
    XCTAssertEqual(validity.notAfter, formatter.date(from: "2049-01-01T00:00:00Z"))
    XCTAssertNoThrow(try validity.check(at: formatter.date(from: "2026-09-06T12:00:00Z")!))
    XCTAssertThrowsError(try validity.check(at: formatter.date(from: "2050-01-01T00:00:00Z")!))
    XCTAssertThrowsError(try validity.check(at: formatter.date(from: "1949-01-01T00:00:00Z")!))
    XCTAssertThrowsError(try CertificateValidity(der: validityFixture(before: "260230000000Z", after: "490101000000Z")))
    XCTAssertThrowsError(try CertificateValidity(der: Data([0x30, 0x80, 0x00, 0x00])))
  }

  // Structurally sufficient ONLY for the validity reader. Security.framework rejects these as certificates.
  private func validityFixture(before: String, after: String) -> Data {
    func element(_ tag: UInt8, _ content: [UInt8]) -> [UInt8] { [tag, UInt8(content.count)] + content }
    let times = element(0x30, element(0x17, Array(before.utf8)) + element(0x17, Array(after.utf8)))
    let tbs = element(0x30, element(0x02, [1]) + element(0x30, []) + element(0x30, []) + times)
    return Data(element(0x30, tbs))
  }
}
