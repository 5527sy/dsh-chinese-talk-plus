# Changelog

## 0.3.0

- Add local voice cloning: upload a short WAV reference clip and the bridge clones its voice zero-shot with Qwen3-TTS (`Qwen3-TTS-12Hz-1.7B-Base`, Apache-2.0).
- Add a voice-switcher dropdown — Microsoft Edge TTS or any saved cloned voice, one voice at a time.
- Add a preview / regenerate / save flow for cloned voices, persisted under `voices/cloned/<id>/`.
- Show a "synthesizing, please wait" notice while a cloned voice is synthesized locally.
- Document the voice-cloning feature, endpoints, and configuration in both READMEs; add third-party attribution for Qwen3-TTS.

## 0.2.1

- Make the voice panel draggable with a frosted-glass Apple-style UI.
- Collapse the panel via an in-panel close button; remove the standalone toggle.
- Add a drag-to-adjust dB threshold for voice-triggered recording.
- Shadow the built-in dsh-client-ui-voice-call panel to avoid duplicates.



## 0.2.0

- Convert the project into an installable DeepSeek Harness profile bundle.
- Add a self-contained client build for Git, npm, and tarball distribution.
- Replace source-tree patching scripts with the official `dsh plugin` workflow.
- Package the local bridge as an installable Python project.
- Remove machine-specific model and ffmpeg paths from launch scripts.
- Add Apache-2.0 licensing, bilingual setup documentation, and CI checks.
