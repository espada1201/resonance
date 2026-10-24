import Foundation
import Network

/// Serves the bundled web app to the app's own web view. WebKit gives the microphone and WebCrypto
/// only to secure pages, and 127.0.0.1 counts as one. The fixed port keeps the page's origin, and
/// with it everything the page stored, the same from one launch to the next.
final class LocalServer {
    static let port: NWEndpoint.Port = 41917
    let url = URL(string: "http://127.0.0.1:\(LocalServer.port.rawValue)/index.html")!

    private let root: URL
    private let queue = DispatchQueue(label: "resonance.server")
    private var listener: NWListener?

    init(root: URL) {
        self.root = root.standardizedFileURL
        start()
    }

    /// iOS can close the socket while the app is in the background; the app calls this on returning.
    func start() {
        queue.async { [self] in
            if listener != nil { return }
            let params = NWParameters.tcp
            params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: Self.port)
            params.allowLocalEndpointReuse = true
            guard let next = try? NWListener(using: params) else { return }
            next.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
            next.stateUpdateHandler = { [weak self, weak next] state in
                if case .failed = state, let self, self.listener === next {
                    self.listener = nil
                    self.queue.asyncAfter(deadline: .now() + 1) { self.start() }
                }
            }
            listener = next
            next.start(queue: queue)
        }
    }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, Data())
    }

    private func receive(_ connection: NWConnection, _ received: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
            var head = received
            if let data { head.append(data) }
            if let end = head.range(of: Data("\r\n\r\n".utf8)), let self {
                self.respond(connection, head: String(decoding: head[..<end.lowerBound], as: UTF8.self))
            } else if done || error != nil || head.count > 65536 || self == nil {
                connection.cancel()
            } else {
                self?.receive(connection, head)
            }
        }
    }

    private func respond(_ connection: NWConnection, head: String) {
        let request = head.split(separator: "\r\n").first?.split(separator: " ").map(String.init) ?? []
        let method = request.first ?? ""
        var status = "404 Not Found", type = "text/plain", body = Data("Not found".utf8)
        if method == "GET" || method == "HEAD", request.count > 1, let file = file(for: request[1]), let data = try? Data(contentsOf: file) {
            status = "200 OK"
            type = Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
            body = data
        }
        let header = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(header.utf8) + (method == "HEAD" ? Data() : body), completion: .contentProcessed { _ in connection.cancel() })
    }

    /// The bundled file a request path names, or nil for anything outside the bundle.
    private func file(for target: String) -> URL? {
        var path = String(target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
        path = path.removingPercentEncoding ?? path
        if path.hasSuffix("/") { path += "index.html" }
        let url = root.appendingPathComponent(path).standardizedFileURL
        return url.path.hasPrefix(root.path + "/") ? url : nil
    }

    private static let types = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json",
        "webmanifest": "application/manifest+json",
        "svg": "image/svg+xml",
        "png": "image/png",
        "wasm": "application/wasm",
        "wav": "audio/wav",
        "txt": "text/plain; charset=utf-8",
    ]
}
