import SwiftUI

struct Message: Identifiable {
    let id = UUID()
    let text: String
    let isUser: Bool
    let timestamp = Date()
}

struct ContentView: View {
    @StateObject private var client = NanoClawClient()
    @StateObject private var speech = SpeechManager()
    @State private var messages: [Message] = []
    @State private var errorMessage: String?
    @State private var showSettings = false
    @State private var autoSpeak = true

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Conversation history
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(messages) { msg in
                                MessageBubble(message: msg)
                                    .id(msg.id)
                            }

                            if client.isLoading {
                                HStack {
                                    ProgressView()
                                        .scaleEffect(0.8)
                                    Text("Thinking...")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.horizontal)
                                .id("loading")
                            }
                        }
                        .padding()
                    }
                    .onChange(of: messages.count) {
                        withAnimation {
                            proxy.scrollTo(messages.last?.id ?? "loading", anchor: .bottom)
                        }
                    }
                }

                // Error banner
                if let error = errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.white)
                        .padding(8)
                        .frame(maxWidth: .infinity)
                        .background(.red.opacity(0.8))
                        .onTapGesture { errorMessage = nil }
                }

                // Live transcription
                if speech.isListening && !speech.transcribedText.isEmpty {
                    Text(speech.transcribedText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal)
                        .padding(.vertical, 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.ultraThinMaterial)
                }

                Divider()

                // Controls
                HStack(spacing: 20) {
                    // Auto-speak toggle
                    Button {
                        autoSpeak.toggle()
                    } label: {
                        Image(systemName: autoSpeak ? "speaker.wave.2.fill" : "speaker.slash.fill")
                            .font(.title3)
                            .foregroundStyle(autoSpeak ? .blue : .secondary)
                    }

                    Spacer()

                    // Mic button
                    Button {
                        if speech.isListening {
                            speech.stopListening()
                            sendTranscribedText()
                        } else if speech.isSpeaking {
                            speech.stopSpeaking()
                        } else {
                            speech.startListening()
                        }
                    } label: {
                        ZStack {
                            Circle()
                                .fill(micButtonColor)
                                .frame(width: 72, height: 72)
                                .shadow(color: micButtonColor.opacity(0.4), radius: speech.isListening ? 12 : 4)
                                .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: speech.isListening)

                            Image(systemName: micButtonIcon)
                                .font(.title)
                                .foregroundStyle(.white)
                        }
                    }
                    .disabled(!client.isConfigured || client.isLoading || speech.authorizationStatus != .authorized)

                    Spacer()

                    // Stop speaking
                    Button {
                        speech.stopSpeaking()
                    } label: {
                        Image(systemName: "stop.circle")
                            .font(.title3)
                            .foregroundStyle(speech.isSpeaking ? .red : .secondary)
                    }
                    .disabled(!speech.isSpeaking)
                }
                .padding()
                .background(.ultraThinMaterial)
            }
            .navigationTitle("NanoVoice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gear")
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        messages.removeAll()
                    } label: {
                        Image(systemName: "trash")
                    }
                    .disabled(messages.isEmpty)
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView(client: client)
            }
            .onAppear {
                if !client.isConfigured {
                    showSettings = true
                }
            }
        }
    }

    private var micButtonColor: Color {
        if speech.isListening { return .red }
        if speech.isSpeaking { return .orange }
        if client.isLoading { return .gray }
        return .blue
    }

    private var micButtonIcon: String {
        if speech.isListening { return "mic.fill" }
        if speech.isSpeaking { return "waveform" }
        return "mic"
    }

    private func sendTranscribedText() {
        let text = speech.transcribedText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        messages.append(Message(text: text, isUser: true))
        errorMessage = nil

        Task {
            do {
                let response = try await client.sendMessage(text)
                messages.append(Message(text: response, isUser: false))
                if autoSpeak {
                    speech.speak(response)
                }
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

struct MessageBubble: View {
    let message: Message

    var body: some View {
        HStack {
            if message.isUser { Spacer(minLength: 60) }

            Text(message.text)
                .padding(12)
                .background(message.isUser ? Color.blue : Color(.systemGray5))
                .foregroundStyle(message.isUser ? .white : .primary)
                .clipShape(RoundedRectangle(cornerRadius: 16))

            if !message.isUser { Spacer(minLength: 60) }
        }
    }
}

struct SettingsView: View {
    @ObservedObject var client: NanoClawClient
    @Environment(\.dismiss) private var dismiss
    @State private var serverURL: String = ""
    @State private var apiKey: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("NanoClaw Server") {
                    TextField("Server URL", text: $serverURL)
                        .textContentType(.URL)
                        .autocapitalization(.none)
                        .keyboardType(.URL)

                    SecureField("API Key", text: $apiKey)
                        .autocapitalization(.none)
                }

                Section {
                    Button("Test Connection") {
                        Task {
                            client.serverURL = serverURL
                            client.apiKey = apiKey
                            do {
                                let response = try await client.sendMessage("ping")
                                // Success — save and dismiss
                                dismiss()
                            } catch {
                                // Show error but still save
                            }
                        }
                    }
                }

                Section("About") {
                    Text("NanoVoice connects to your NanoClaw agent via the HTTP API channel. Set the server URL and API key from your .env file.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        client.serverURL = serverURL
                        client.apiKey = apiKey
                        dismiss()
                    }
                }
            }
            .onAppear {
                serverURL = client.serverURL
                apiKey = client.apiKey
            }
        }
    }
}

#Preview {
    ContentView()
}
