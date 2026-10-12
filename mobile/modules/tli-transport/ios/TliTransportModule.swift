import ExpoModulesCore
import Foundation
import Security
import CryptoKit

struct ConfigureOptions: Record {
  @Field var origin: String = ""
  @Field var certificateDer: String = ""
  @Field var certificateSha256: String = ""
  @Field var resolvedAddresses: [String] = []
  @Field var nodeId: String = ""
  @Field var publicKey: String = ""
}

struct FileRequestOptions: Record {
  @Field var id: String = ""
  @Field var path: String = ""
  @Field var headers: [String: String] = [:]
  @Field var fileUri: String = ""
  @Field var fileName: String = ""
  @Field var mimeType: String = ""
}
struct DiscoveryOptions: Record { @Field var timeoutMs: Int = 5000 }

struct RequestOptions: Record {
  @Field var id: String = ""
  @Field var path: String = ""
  @Field var method: String = "GET"
  @Field var headers: [String: String] = [:]
  @Field var body: String? = nil
  @Field var stream: Bool = false
}

public final class TliTransportModule: Module {
  private var transport: TransportSession?
  private var helpers: [String: TransportSession] = [:]

  public func definition() -> ModuleDefinition {
    Name("TliTransport")
    Events("onHeaders", "onChunk")

    AsyncFunction("configure") { (options: ConfigureOptions, promise: Promise) in
      let pending = self.helpers; self.helpers.removeAll(); pending.values.forEach { $0.invalidate() }
      self.transport?.invalidate()
      self.transport = nil
      do {
        self.transport = try TransportSession(options: options, emit: { [weak self] name, event in
          self?.sendEvent(name, event)
        })
        promise.resolve()
      } catch { reject(promise, error) }
    }.runOnQueue(.main)

    AsyncFunction("request") { (options: RequestOptions, promise: Promise) in
      guard let transport = self.transport else {
        promise.reject("E_NOT_CONFIGURED", "Pair with TLI first.")
        return
      }
      do { try transport.request(options, promise: promise) }
      catch { reject(promise, error) }
    }.runOnQueue(.main)

    AsyncFunction("uploadFile") { (options: FileRequestOptions, promise: Promise) in
      do {
        guard let transport = self.transport else { throw TransportFailure(code: "E_NOT_CONFIGURED", message: "Pair with TLI first.") }
        let data = try readUpload(options.fileUri)
        var request = RequestOptions(); request.id = options.id; request.path = options.path; request.headers = options.headers; request.method = "POST"
        try transport.request(request, promise: promise, upload: data)
      } catch { reject(promise, error) }
    }.runOnQueue(.main)

    AsyncFunction("downloadFile") { (options: FileRequestOptions, promise: Promise) in
      do {
        guard let transport = self.transport else { throw TransportFailure(code: "E_NOT_CONFIGURED", message: "Pair with TLI first.") }
        var request = RequestOptions(); request.id = options.id; request.path = options.path; request.headers = options.headers
        try transport.request(request, promise: promise, downloadName: options.fileName)
      } catch { reject(promise, error) }
    }.runOnQueue(.main)

    AsyncFunction("discover") { (_: DiscoveryOptions, promise: Promise) in
      promise.reject("E_UNSUPPORTED", "LAN discovery is available in the Android release. Use the reviewed IPv4 pairing address on iOS.")
    }
    AsyncFunction("probeConnection") { (_: ConfigureOptions, promise: Promise) in
      promise.reject("E_UNSUPPORTED", "Signed endpoint discovery is available in the Android release.")
    }

    AsyncFunction("requestHelper") { (configuration: ConfigureOptions, options: RequestOptions, promise: Promise) in
      do {
        try TransportPolicy.helperRequest(method: options.method, path: options.path, headers: options.headers, body: options.body, stream: options.stream)
        guard self.helpers[options.id] == nil else { throw TransportFailure(code: "E_REQUEST_ID", message: "Use a unique helper request identifier.") }
        let isolated = try TransportSession(options: configuration, helper: true, emit: { _, _ in }, settled: { [weak self] in
          self?.helpers.removeValue(forKey: options.id)?.invalidate()
        })
        self.helpers[options.id] = isolated
        do { try isolated.request(options, promise: promise) }
        catch { self.helpers.removeValue(forKey: options.id)?.invalidate(); throw error }
      } catch { reject(promise, error) }
    }.runOnQueue(.main)

    Function("cancel") { (id: String) in
      DispatchQueue.main.async { self.transport?.cancel(id); self.helpers.removeValue(forKey: id)?.invalidate() }
    }

    AsyncFunction("reset") {
      let pending = self.helpers; self.helpers.removeAll(); pending.values.forEach { $0.invalidate() }
      self.transport?.invalidate()
      self.transport = nil
    }.runOnQueue(.main)

    OnDestroy {
      DispatchQueue.main.async {
        let pending = self.helpers; self.helpers.removeAll(); pending.values.forEach { $0.invalidate() }
        self.transport?.invalidate()
        self.transport = nil
      }
    }
  }
}

private func reject(_ promise: Promise, _ error: Error) {
  if let failure = error as? TransportFailure {
    promise.reject(failure.code, failure.message)
    return
  }
  let native = error as NSError
  if native.domain == NSURLErrorDomain && (-1206 ... -1200).contains(native.code) {
    promise.reject("E_TLS_TRUST", "TLI's certificate could not be verified. Check the desktop and pair again.")
  } else if native.domain == NSURLErrorDomain && native.code == NSURLErrorCancelled {
    promise.reject("E_CANCELLED", "The request was cancelled.")
  } else if native.domain == NSURLErrorDomain && native.code == NSURLErrorTimedOut {
    promise.reject("E_TIMEOUT", "TLI did not respond within the connection timeout.")
  } else if native.domain == NSURLErrorDomain && native.code == NSURLErrorCannotConnectToHost {
    promise.reject("E_CONNECT", "A connection to the paired TLI address could not be established.")
  } else if native.domain == NSURLErrorDomain && native.code == NSURLErrorNotConnectedToInternet {
    promise.reject("E_OFFLINE", "The phone reported no usable network connection.")
  } else {
    promise.reject("E_NETWORK", "TLI could not be reached securely. Check your Wi-Fi and the desktop.")
  }
}

private final class PendingRequest {
  let options: RequestOptions
  let task: URLSessionDataTask
  let promise: Promise
  var response: HTTPURLResponse?
  var headers: [String: String] = [:]
  var body = ""
  var decoder = IncrementalUTF8Decoder()
  var bytes = 0
  var failure: Error?
  var downloadURL: URL?
  var downloadHandle: FileHandle?

  init(options: RequestOptions, task: URLSessionDataTask, promise: Promise) {
    self.options = options
    self.task = task
    self.promise = promise
  }
}

/** All state and URLSession callbacks are confined to the main queue. */
private final class TransportSession: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let origin: URL
  private let certificate: SecCertificate
  private let certificateDER: Data
  private let validity: CertificateValidity
  private let emit: (String, [String: Any]) -> Void
  private let settled: (() -> Void)?
  private let helper: Bool
  private var pending: [String: PendingRequest] = [:]
  private var taskIDs: [Int: String] = [:]
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.urlCredentialStorage = nil
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.tlsMinimumSupportedProtocolVersion = .TLSv12
    config.timeoutIntervalForRequest = helper ? 15 : 120
    config.timeoutIntervalForResource = helper ? 20 : 300
    config.waitsForConnectivity = false
    return URLSession(configuration: config, delegate: self, delegateQueue: .main)
  }()

  init(options: ConfigureOptions, helper: Bool = false, emit: @escaping (String, [String: Any]) -> Void, settled: (() -> Void)? = nil) throws {
    self.helper = helper
    self.settled = settled
    origin = try TransportPolicy.origin(options.origin)
    guard options.certificateDer.utf8.count <= 24576,
      let der = Data(base64Encoded: options.certificateDer), !der.isEmpty, der.count <= 16384,
      let cert = SecCertificateCreateWithData(nil, der as CFData),
      (SecCertificateCopyData(cert) as Data) == der else {
      throw TransportFailure(code: "E_CERTIFICATE", message: "The pairing certificate is not valid base64 DER.")
    }
    certificate = cert
    certificateDER = der
    if helper && SHA256.hash(data: der).map({ String(format: "%02x", $0) }).joined() != options.certificateSha256 {
      throw TransportFailure(code: "E_TLS_TRUST", message: "The reviewed helper fingerprint does not match the paired certificate.")
    }
    validity = try CertificateValidity(der: der)
    self.emit = emit
    super.init()
    try validity.check()
    // Verify the pinned certificate's SSL identity before any network request.
    var trust: SecTrust?
    let status = SecTrustCreateWithCertificates(certificate, SecPolicyCreateSSL(true, origin.host! as CFString), &trust)
    guard status == errSecSuccess, let trust, evaluate(trust) else {
      throw TransportFailure(code: "E_TLS_TRUST", message: "The pairing certificate does not match this TLI address.")
    }
  }

  func request(_ options: RequestOptions, promise: Promise, upload: Data? = nil, downloadName: String? = nil) throws {
    try validity.check()
    guard options.id.range(of: #"^[A-Za-z0-9_-]{1,128}\z"#, options: .regularExpression) != nil,
      pending[options.id] == nil else {
      throw TransportFailure(code: "E_REQUEST_ID", message: "Use a unique request identifier.")
    }
    let url = try TransportPolicy.requestURL(origin: origin, path: options.path)
    try TransportPolicy.validate(method: options.method, headers: options.headers, body: options.body)
    var request = URLRequest(url: url)
    request.httpMethod = options.method
    request.httpBody = upload ?? options.body.map { Data($0.utf8) }
    request.allHTTPHeaderFields = options.headers
    request.httpShouldHandleCookies = false
    let task = session.dataTask(with: request)
    let state = PendingRequest(options: options, task: task, promise: promise)
    if let downloadName {
      let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("tli-downloads", isDirectory: true)
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      let suppliedExtension = (downloadName as NSString).pathExtension.lowercased()
      let ext = suppliedExtension.range(of: #"^[a-z0-9]{1,8}$"#, options: .regularExpression) == nil ? "bin" : suppliedExtension
      let destination = root.appendingPathComponent("tli-" + UUID().uuidString + "." + ext)
      guard FileManager.default.createFile(atPath: destination.path, contents: nil) else { throw TransportFailure(code: "E_FILE", message: "Could not create the download cache file.") }
      state.downloadURL = destination
      do { state.downloadHandle = try FileHandle(forWritingTo: destination) }
      catch { try? FileManager.default.removeItem(at: destination); throw error }
    }
    pending[options.id] = state
    taskIDs[task.taskIdentifier] = options.id
    task.resume()
  }

  func cancel(_ id: String) {
    guard let state = pending.removeValue(forKey: id) else { return }
    taskIDs.removeValue(forKey: state.task.taskIdentifier)
    state.task.cancel()
    cleanupDownload(state)
    state.promise.reject("E_CANCELLED", "The request was cancelled.")
  }

  func invalidate() {
    Array(pending.keys).forEach { cancel($0) }
    session.invalidateAndCancel()
  }

  private func state(for task: URLSessionTask) -> PendingRequest? {
    taskIDs[task.taskIdentifier].flatMap { pending[$0] }
  }

  private func evaluate(_ trust: SecTrust) -> Bool {
    guard (try? validity.check()) != nil,
      let presented = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let leaf = presented.first, (SecCertificateCopyData(leaf) as Data) == certificateDER,
      SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, origin.host! as CFString)) == errSecSuccess,
      SecTrustSetAnchorCertificates(trust, [certificate] as CFArray) == errSecSuccess,
      SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
      SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess else { return false }
    var error: CFError?
    return SecTrustEvaluateWithError(trust, &error)
  }

  // URLSession forwards server-trust challenges here when no session-level handler is implemented.
  // Keeping the task lets us report an exact trust failure instead of a generic cancellation.
  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard let state = state(for: task) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      challenge.protectionSpace.host == origin.host,
      challenge.protectionSpace.port == (origin.port ?? 443),
      let trust = challenge.protectionSpace.serverTrust, evaluate(trust) else {
      state.failure = TransportFailure(code: "E_TLS_TRUST", message: "TLI's certificate or authentication challenge could not be verified.")
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) {
    state(for: task)?.failure = TransportFailure(code: "E_REDIRECT", message: "TLI transport refuses HTTP redirects.")
    completionHandler(nil)
    task.cancel()
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let state = state(for: dataTask), let http = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      return
    }
    if (300...399).contains(http.statusCode) {
      state.failure = TransportFailure(code: "E_REDIRECT", message: "TLI transport refuses HTTP redirects.")
      completionHandler(.cancel)
      return
    }
    let maxBytes = helper ? 65536 : state.downloadURL != nil ? ((200...299).contains(http.statusCode) ? 16 * 1024 * 1024 : 262144) : tliMaxResponseBytes
    if response.expectedContentLength > Int64(maxBytes) {
      state.failure = TransportFailure(code: "E_RESPONSE_TOO_LARGE", message: helper ? "The helper response exceeds 64 KiB." : "The response exceeds 8 MiB.")
      completionHandler(.cancel)
      return
    }
    state.response = http
    for (name, value) in http.allHeaderFields {
      state.headers[String(describing: name).lowercased()] = String(describing: value)
    }
    emit("onHeaders", ["id": state.options.id, "status": http.statusCode, "headers": state.headers])
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let state = state(for: dataTask), state.failure == nil else { return }
    do {
      let isDownload = state.downloadURL != nil && (200...299).contains(state.response?.statusCode ?? 0)
      let maxBytes = helper ? 65536 : state.downloadURL != nil ? (isDownload ? 16 * 1024 * 1024 : 262144) : tliMaxResponseBytes
      guard data.count <= maxBytes - state.bytes else {
        throw TransportFailure(code: "E_RESPONSE_TOO_LARGE", message: helper ? "The helper response exceeds 64 KiB." : "The response exceeds 8 MiB.")
      }
      state.bytes += data.count
      if isDownload { try state.downloadHandle?.write(contentsOf: data) }
      else { append(try state.decoder.decode(data), to: state) }
    } catch {
      state.failure = error
      dataTask.cancel()
    }
  }

  private func append(_ text: String, to state: PendingRequest) {
    guard !text.isEmpty else { return }
    if TransportPolicy.shouldStream(requested: state.options.stream, status: state.response?.statusCode ?? 0) {
      emit("onChunk", ["id": state.options.id, "chunk": text])
    }
    else { state.body += text }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let state = state(for: task) else { return }
    defer {
      pending.removeValue(forKey: state.options.id)
      taskIDs.removeValue(forKey: task.taskIdentifier)
      settled?()
    }
    if let failure = state.failure ?? error {
      cleanupDownload(state)
      reject(state.promise, failure)
      return
    }
    do {
      append(try state.decoder.decode(Data(), end: true), to: state)
      guard let response = state.response else {
        throw TransportFailure(code: "E_PROTOCOL", message: "TLI did not return an HTTP response.")
      }
      var result: [String: Any] = ["status": response.statusCode, "headers": state.headers, "body": state.body]
      if let url = state.downloadURL, (200...299).contains(response.statusCode) {
        try state.downloadHandle?.close(); state.downloadHandle = nil
        result["fileUri"] = url.absoluteString
      } else { cleanupDownload(state) }
      state.promise.resolve(result)
    } catch { cleanupDownload(state); reject(state.promise, error) }
  }
}

private func cleanupDownload(_ state: PendingRequest) {
  try? state.downloadHandle?.close(); state.downloadHandle = nil
  if let url = state.downloadURL { try? FileManager.default.removeItem(at: url) }
}

private func readUpload(_ value: String) throws -> Data {
  guard let supplied = URL(string: value), supplied.isFileURL, supplied.host == nil || supplied.host == "",
    supplied.query == nil, supplied.fragment == nil else {
    throw TransportFailure(code: "E_FILE", message: "Copy the selected document to the app cache before sending.")
  }
  let file = supplied.resolvingSymlinksInPath().standardizedFileURL
  let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].resolvingSymlinksInPath().standardizedFileURL.path + "/"
  let resource = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
  guard file.path.hasPrefix(root), resource.isRegularFile == true, (resource.fileSize ?? Int.max) <= 8 * 1024 * 1024 else {
    throw TransportFailure(code: "E_FILE", message: "Choose an app-cache document up to 8 MiB.")
  }
  let handle = try FileHandle(forReadingFrom: file)
  defer { try? handle.close() }
  var bytes = Data()
  while let chunk = try handle.read(upToCount: 8192), !chunk.isEmpty {
    guard bytes.count + chunk.count <= 8 * 1024 * 1024 else { throw TransportFailure(code: "E_REQUEST_TOO_LARGE", message: "The document exceeds 8 MiB.") }
    bytes.append(chunk)
  }
  return bytes
}
