import Foundation

let tliMaxResponseBytes = 8 * 1024 * 1024
let tliMaxRequestBytes = 16 * 1024 * 1024

struct TransportFailure: Error {
  let code: String
  let message: String
}

enum TransportPolicy {
  static func shouldStream(requested: Bool, status: Int) -> Bool {
    requested && (200...299).contains(status)
  }

  static func origin(_ value: String) throws -> URL {
    let pattern = #"^https://([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)(?::([0-9]+))?/?$"#
    guard value.range(of: pattern, options: .regularExpression) != nil,
      let components = URLComponents(string: value), let host = components.host,
      let url = components.url else {
      throw TransportFailure(code: "E_ORIGIN", message: "Use an HTTPS origin with a private LAN IPv4 address.")
    }
    let textParts = host.split(separator: ".", omittingEmptySubsequences: false)
    let parts = textParts.compactMap { Int($0) }
    guard parts.count == 4,
      zip(textParts, parts).allSatisfy({ String($0.1) == $0.0 && (0...255).contains($0.1) }),
      parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1])) ||
        (parts[0] == 192 && parts[1] == 168) || (parts[0] == 169 && parts[1] == 254) else {
      throw TransportFailure(code: "E_ORIGIN", message: "TLI beta connections require a private LAN IPv4 address.")
    }
    if let port = components.port, !(1...65535).contains(port) {
      throw TransportFailure(code: "E_ORIGIN", message: "The HTTPS port is invalid.")
    }
    // Match Android's canonical address/port rules and reject ambiguous URL spellings.
    let canonical = "https://" + host + (components.port.map { ":\($0)" } ?? "")
    guard value == canonical || value == canonical + "/" else {
      throw TransportFailure(code: "E_ORIGIN", message: "The HTTPS origin is not canonical.")
    }
    return URL(string: canonical) ?? url
  }

  static func requestURL(origin: URL, path: String) throws -> URL {
    guard path.hasPrefix("/"), !path.hasPrefix("//"), path.utf8.count <= 8192,
      !path.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 || $0 == "\\" || $0 == "#" }),
      let url = URL(string: origin.absoluteString + path),
      url.scheme == "https", url.host == origin.host, url.port == origin.port,
      url.user == nil, url.password == nil, url.fragment == nil else {
      throw TransportFailure(code: "E_PATH", message: "Requests must use a relative path on the paired TLI node.")
    }
    return url
  }

  static func validate(method: String, headers: [String: String], body: String?) throws {
    guard ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].contains(method) else {
      throw TransportFailure(code: "E_METHOD", message: "The request method is unsupported.")
    }
    if ["GET", "HEAD"].contains(method) && body != nil {
      throw TransportFailure(code: "E_METHOD", message: "GET and HEAD requests cannot contain a body.")
    }
    if (body?.utf8.count ?? 0) > tliMaxRequestBytes {
      throw TransportFailure(code: "E_REQUEST_TOO_LARGE", message: "The request exceeds 16 MiB.")
    }
    let forbidden: Set<String> = ["host", "connection", "content-length", "transfer-encoding", "upgrade",
      "proxy-authorization", "proxy-connection", "cookie", "te", "trailer"]
    var names = Set<String>()
    var length = 0
    guard headers.count <= 64 else {
      throw TransportFailure(code: "E_HEADERS", message: "Too many request headers.")
    }
    for (name, value) in headers {
      length += name.utf8.count + value.utf8.count
      guard name.range(of: #"^[!#$%&'*+.^_`|~0-9A-Za-z-]+\z"#, options: .regularExpression) != nil,
        !forbidden.contains(name.lowercased()), names.insert(name.lowercased()).inserted,
        !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value > 126 }) else {
        throw TransportFailure(code: "E_HEADERS", message: "A request header is invalid or reserved for the transport.")
      }
    }
    if length > 32768 { throw TransportFailure(code: "E_HEADERS", message: "The request headers are too large.") }
  }
}

/** Decode complete scalars only, retaining an unfinished UTF-8 scalar for the next network callback. */
struct IncrementalUTF8Decoder {
  private var pending = Data()

  mutating func decode(_ bytes: Data, end: Bool = false) throws -> String {
    pending.append(bytes)
    let values = Array(pending)
    var split = values.count
    if !end && !values.isEmpty {
      var start = values.count - 1
      while start > 0 && (values[start] & 0xc0) == 0x80 { start -= 1 }
      let lead = values[start]
      let width: Int
      switch lead {
      case 0xc2...0xdf: width = 2
      case 0xe0...0xef: width = 3
      case 0xf0...0xf4: width = 4
      default: width = 1
      }
      if values.count - start < width { split = start }
    }
    guard let result = String(data: pending.prefix(split), encoding: .utf8) else {
      throw TransportFailure(code: "E_ENCODING", message: "TLI returned invalid UTF-8.")
    }
    pending = Data(pending.dropFirst(split))
    return result
  }
}
