import Foundation

/// HTTP client for the NanoClaw API channel.
class NanoClawClient: ObservableObject {
    @Published var isLoading = false

    var serverURL: String {
        get { UserDefaults.standard.string(forKey: "serverURL") ?? "http://localhost:3100" }
        set { UserDefaults.standard.set(newValue, forKey: "serverURL") }
    }

    var apiKey: String {
        get { UserDefaults.standard.string(forKey: "apiKey") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "apiKey") }
    }

    var isConfigured: Bool {
        !serverURL.isEmpty && !apiKey.isEmpty
    }

    func sendMessage(_ text: String) async throws -> String {
        guard isConfigured else {
            throw ClientError.notConfigured
        }

        let url = URL(string: "\(serverURL)/api/message")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 300 // 5 minute timeout (agent can be slow)

        let body: [String: String] = ["text": text, "apiKey": apiKey]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        await MainActor.run { isLoading = true }
        defer { Task { @MainActor in isLoading = false } }

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw ClientError.invalidResponse
        }

        guard httpResponse.statusCode == 200 else {
            let errorBody = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw ClientError.serverError(statusCode: httpResponse.statusCode, message: errorBody)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let responseText = json["response"] as? String else {
            throw ClientError.invalidResponse
        }

        return responseText
    }

    enum ClientError: LocalizedError {
        case notConfigured
        case invalidResponse
        case serverError(statusCode: Int, message: String)

        var errorDescription: String? {
            switch self {
            case .notConfigured:
                return "Server URL and API key not set. Open Settings."
            case .invalidResponse:
                return "Invalid response from server."
            case .serverError(let code, let message):
                return "Server error (\(code)): \(message)"
            }
        }
    }
}
