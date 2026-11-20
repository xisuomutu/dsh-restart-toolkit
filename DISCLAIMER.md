# Disclaimer

This is an **unofficial** desktop-shell patch toolkit for DeepSeek Harness
Desktop on Windows.

- It modifies `resources/app.asar` of the installed application. This is not
  an officially supported extension point.
- The patch is written against **DSH Desktop 0.2.2-rc.5**. Other versions or
  builds may fail the anchor check and must not be forced.
- Always keep the automatic `app.asar.bak-<timestamp>` backup. If the
  application does not start, restore the backup before trying anything else.
- Desktop updates overwrite `app.asar`; re-run the compatibility check and
  patch after every update.
- ASAR integrity validation, code signing, enterprise policy, antivirus, and
  endpoint protection may block a modified archive. The toolkit reports the
  relevant Electron fuses where possible, but cannot guarantee acceptance.
- The restart sequence interrupts running turns, tools, terminals, and
  background jobs. Session logs are durable, but in-flight work is not.
- No warranty is provided. You are responsible for testing on your own
  machine and for complying with the DeepSeek Harness license, third-party
  licenses, and DeepSeek's terms of service.
- This document is not legal advice.
