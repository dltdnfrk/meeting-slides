# Anarlog STT Model Manager Evidence

Worker: `st_019fc56d`
Repository: https://github.com/fastrepl/anarlog
Inspected HEAD: `ec674f9d039d62e26eb4020db925fff647cc533e`
License: MIT
Status: completed

## Verified catalog

| ID | Artifact | Bytes | Checksum |
| --- | --- | ---: | ---: |
| small | `ggml-small-q8_0.bin` | 264464607 | 3764849512 |
| large-v3-turbo | `ggml-large-v3-turbo-q8_0.bin` | 874188075 | 3055274469 |
| large-v3 | `openai_whisper-large-v3-v20240930_626MB.tar` | 625990656 | 1964673816 |

Download host:
`https://hyprnote.s3.us-east-1.amazonaws.com/v0/`

Install roots:

- Whisper `.bin`: `models/stt/<filename>`
- Argmax directory: `models/stt/<model-directory>/`

## Lifecycle contract

- Download states: downloading percent, completed, failed.
- Cancellation removes registry state, cancels the task, waits for exit, and deletes partial files.
- File models are installed when the final file exists.
- Directory models are installed when the directory exists and is non-empty.
- Provider/model selection persists; active download state does not.
- On restart, disk state is authoritative and remembered selection is restored only when installed.

## Medium gap

Current Anarlog HEAD does not contain a medium model. Meeting Slides must add an independently
verified official whisper.cpp medium artifact to satisfy the explicit user requirement.

### Verified medium artifact

- Repository: https://github.com/ggml-org/whisper.cpp
- File: `ggml-medium-q8_0.bin`
- URL: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q8_0.bin`
- Size: `823369779` bytes
- Hugging Face LFS OID:
  `42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502`
- Xet ETag:
  `c8116b244ec4960951435c4a244acdaee9efec098f3c7ca763a13762e66f7351`
- License: MIT
- Compatibility: the official `models/download-ggml-model.sh` accepts `medium-q8_0`
  and documents passing the resulting file to `whisper-cli -m`.
