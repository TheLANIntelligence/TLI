import Foundation

/**
 * Explicitly check the pinned leaf's validity, including when the platform treats it as an anchor.
 * Security.framework still validates the complete certificate and its SSL hostname policy.
 * This small DER reader only locates TBSCertificate.validity; it does not implement X.509 trust.
 */
struct CertificateValidity {
  let notBefore: Date
  let notAfter: Date

  init(der: Data) throws {
    let bytes = Array(der)
    var document = DERReader(bytes: bytes, range: 0..<bytes.count)
    let certificate = try document.next(expected: 0x30)
    guard document.finished else { throw Self.invalid() }
    var certificateFields = DERReader(bytes: bytes, range: certificate.content)
    let tbs = try certificateFields.next(expected: 0x30)
    var fields = DERReader(bytes: bytes, range: tbs.content)
    if fields.peek == 0xa0 { _ = try fields.next(expected: 0xa0) }
    _ = try fields.next(expected: 0x02) // serialNumber
    _ = try fields.next(expected: 0x30) // signature
    _ = try fields.next(expected: 0x30) // issuer
    let validity = try fields.next(expected: 0x30)
    var times = DERReader(bytes: bytes, range: validity.content)
    let before = try times.next()
    let after = try times.next()
    guard times.finished else { throw Self.invalid() }
    notBefore = try Self.date(tag: before.tag, bytes: Array(bytes[before.content]))
    notAfter = try Self.date(tag: after.tag, bytes: Array(bytes[after.content]))
    guard notAfter > notBefore else { throw Self.invalid() }
  }

  func check(at date: Date = Date()) throws {
    guard date >= notBefore && date <= notAfter else {
      throw TransportFailure(code: "E_TLS_TRUST", message: "TLI's certificate has expired or is not yet valid.")
    }
  }

  private static func invalid() -> TransportFailure {
    TransportFailure(code: "E_CERTIFICATE", message: "The pairing certificate contains invalid DER or validity dates.")
  }

  private static func date(tag: UInt8, bytes: [UInt8]) throws -> Date {
    guard (tag == 0x17 && bytes.count == 13) || (tag == 0x18 && bytes.count == 15),
      bytes.last == 0x5a, bytes.dropLast().allSatisfy({ (0x30...0x39).contains($0) }) else {
      throw invalid()
    }
    let yearDigits = tag == 0x17 ? 2 : 4
    func number(_ start: Int, _ count: Int = 2) -> Int {
      bytes[start..<(start + count)].reduce(0) { $0 * 10 + Int($1 - 0x30) }
    }
    let shortYear = number(0, yearDigits)
    let year = yearDigits == 4 ? shortYear : (shortYear >= 50 ? 1900 : 2000) + shortYear
    let components = DateComponents(year: year, month: number(yearDigits), day: number(yearDigits + 2),
      hour: number(yearDigits + 4), minute: number(yearDigits + 6), second: number(yearDigits + 8))
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    guard let date = calendar.date(from: components),
      calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date) == components else {
      throw invalid()
    }
    return date
  }
}

private struct DERElement {
  let tag: UInt8
  let content: Range<Int>
}

private struct DERReader {
  let bytes: [UInt8]
  private var offset: Int
  private let end: Int

  init(bytes: [UInt8], range: Range<Int>) {
    self.bytes = bytes
    offset = range.lowerBound
    end = range.upperBound
  }

  var finished: Bool { offset == end }
  var peek: UInt8? { offset < end ? bytes[offset] : nil }

  mutating func next(expected: UInt8? = nil) throws -> DERElement {
    func invalid() -> TransportFailure {
      TransportFailure(code: "E_CERTIFICATE", message: "The pairing certificate contains malformed DER.")
    }
    guard end - offset >= 2 else { throw invalid() }
    let tag = bytes[offset]
    if let expected, tag != expected { throw invalid() }
    offset += 1
    let initial = Int(bytes[offset])
    offset += 1
    var length = initial
    if initial & 0x80 != 0 {
      let count = initial & 0x7f
      guard count > 0, count <= 4, end - offset >= count, bytes[offset] != 0 else { throw invalid() }
      length = 0
      for _ in 0..<count {
        length = (length << 8) | Int(bytes[offset])
        offset += 1
      }
      guard length >= 128 else { throw invalid() }
    }
    guard length <= end - offset else { throw invalid() }
    let range = offset..<(offset + length)
    offset += length
    return DERElement(tag: tag, content: range)
  }
}
