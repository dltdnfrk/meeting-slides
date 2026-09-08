import Foundation
import CoreAudio
import AudioToolbox
import AVFoundation

/// Captures the global macOS output mix as 16 kHz mono Float32 PCM.
/// Core Audio taps use System Audio Recording permission, not screen recording.
final class SystemAudioCapture: @unchecked Sendable {
    enum CaptureError: LocalizedError {
        case coreAudio(String, OSStatus)
        case invalidFormat(String)
        case unsupportedSystem

        var errorDescription: String? {
            switch self {
            case let .coreAudio(operation, status):
                return "\(operation) failed (\(Self.describe(status)))."
            case let .invalidFormat(detail):
                return "Unsupported system audio format: \(detail)"
            case .unsupportedSystem:
                return "Computer audio capture requires macOS 14.2 or later."
            }
        }

        private static func describe(_ status: OSStatus) -> String {
            let value = UInt32(bitPattern: status)
            let bytes = [
                UInt8((value >> 24) & 0xff), UInt8((value >> 16) & 0xff),
                UInt8((value >> 8) & 0xff), UInt8(value & 0xff), 0,
            ]
            let printable = bytes.dropLast().allSatisfy { $0 >= 32 && $0 <= 126 }
            return printable ? "'\(String(cString: bytes))'" : String(status)
        }
    }

    private let sampleQueue = DispatchQueue(label: "com.meetingslides.system-audio", qos: .userInitiated)
    private let stateQueue = DispatchQueue(label: "com.meetingslides.system-audio.state")
    private let onAudio: @Sendable (Data) -> Void
    private let onError: @Sendable (String) -> Void

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var inputFormat: AVAudioFormat?
    private var outputFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var running = false
    private var reportedRuntimeError = false

    init(
        onAudio: @escaping @Sendable (Data) -> Void,
        onError: @escaping @Sendable (String) -> Void
    ) {
        self.onAudio = onAudio
        self.onError = onError
    }

    func start() async throws {
        guard #available(macOS 14.2, *) else {
            throw CaptureError.unsupportedSystem
        }
        try stateQueue.sync {
            guard !running else { return }
            do {
                try createTapAndDevice()
                try startIO()
                running = true
            } catch {
                tearDown()
                throw error
            }
        }
    }

    func stop() async {
        stateQueue.sync { tearDown() }
    }

    @available(macOS 14.2, *)
    private func createTapAndDevice() throws {
        let tapDescription = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        tapDescription.name = "Meeting Slides Computer Audio"
        tapDescription.uuid = UUID()
        tapDescription.isPrivate = true
        tapDescription.muteBehavior = .unmuted

        var newTapID = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateProcessTap(tapDescription, &newTapID)
        guard status == noErr else {
            throw CaptureError.coreAudio("Creating the system audio tap", status)
        }
        tapID = newTapID

        var streamDescription = AudioStreamBasicDescription()
        var propertySize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var formatAddress = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        status = AudioObjectGetPropertyData(
            tapID, &formatAddress, 0, nil, &propertySize, &streamDescription
        )
        guard status == noErr,
              let sourceFormat = AVAudioFormat(streamDescription: &streamDescription) else {
            throw CaptureError.coreAudio("Reading the system audio format", status)
        }
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        ), let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) else {
            throw CaptureError.invalidFormat(sourceFormat.description)
        }
        inputFormat = sourceFormat
        outputFormat = targetFormat
        self.converter = converter

        let deviceDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Meeting Slides Computer Audio",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: tapDescription.uuid.uuidString,
                kAudioSubTapDriftCompensationKey: true,
            ]],
        ]
        var newAggregateID = AudioObjectID(kAudioObjectUnknown)
        status = AudioHardwareCreateAggregateDevice(
            deviceDescription as CFDictionary, &newAggregateID
        )
        guard status == noErr else {
            throw CaptureError.coreAudio("Creating the system audio input", status)
        }
        aggregateDeviceID = newAggregateID
    }

    private func startIO() throws {
        var newIOProcID: AudioDeviceIOProcID?
        let status = AudioDeviceCreateIOProcIDWithBlock(
            &newIOProcID,
            aggregateDeviceID,
            sampleQueue
        ) { [weak self] _, inputData, _, _, _ in
            self?.handle(inputData)
        }
        guard status == noErr else {
            throw CaptureError.coreAudio("Preparing system audio capture", status)
        }
        ioProcID = newIOProcID

        let startStatus = AudioDeviceStart(aggregateDeviceID, ioProcID)
        guard startStatus == noErr else {
            throw CaptureError.coreAudio("Starting system audio capture", startStatus)
        }
    }

    private func handle(_ inputData: UnsafePointer<AudioBufferList>) {
        guard let inputFormat, let outputFormat, let converter,
              let inputBuffer = AVAudioPCMBuffer(
                pcmFormat: inputFormat,
                bufferListNoCopy: inputData,
                deallocator: nil
              ) else { return }

        let ratio = outputFormat.sampleRate / inputFormat.sampleRate
        let outputCapacity = AVAudioFrameCount(ceil(Double(inputBuffer.frameLength) * ratio)) + 8
        guard outputCapacity > 0,
              let outputBuffer = AVAudioPCMBuffer(
                pcmFormat: outputFormat,
                frameCapacity: outputCapacity
              ) else { return }

        var suppliedInput = false
        var conversionError: NSError?
        let result = converter.convert(to: outputBuffer, error: &conversionError) { _, status in
            if suppliedInput {
                status.pointee = .noDataNow
                return nil
            }
            suppliedInput = true
            status.pointee = .haveData
            return inputBuffer
        }
        if result == .error {
            reportRuntimeError(conversionError?.localizedDescription ?? "Audio conversion failed.")
            return
        }
        guard outputBuffer.frameLength > 0,
              let samples = outputBuffer.floatChannelData?[0] else { return }
        onAudio(Data(bytes: samples, count: Int(outputBuffer.frameLength) * MemoryLayout<Float>.size))
    }

    private func reportRuntimeError(_ message: String) {
        guard !reportedRuntimeError else { return }
        reportedRuntimeError = true
        onError(message)
    }

    private func tearDown() {
        if aggregateDeviceID != kAudioObjectUnknown {
            if let ioProcID {
                AudioDeviceStop(aggregateDeviceID, ioProcID)
                AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
        }
        if tapID != kAudioObjectUnknown, #available(macOS 14.2, *) {
            AudioHardwareDestroyProcessTap(tapID)
        }
        tapID = AudioObjectID(kAudioObjectUnknown)
        aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
        ioProcID = nil
        inputFormat = nil
        outputFormat = nil
        converter = nil
        running = false
        reportedRuntimeError = false
    }

    deinit { tearDown() }
}
