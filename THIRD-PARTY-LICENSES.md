# Third-Party Licenses

This document lists third-party software included in or used by this project,
along with their respective licenses.

---

## git-ai

- **Source**: https://github.com/nicolo-ribaudo/git-ai
- **License**: Apache License 2.0
- **Copyright**: Copyright 2025 Aidan Cunniffe
- **Location in this project**: `git-ai-src/` (source code), `kiro-pugin/bin/` (compiled binaries)
- **Usage**: AI/human code attribution tracking engine. The compiled Rust binary is bundled
  inside the Kiro IDE plugin (VSIX) and invoked as a CLI tool for checkpoint management,
  post-commit processing, and stats calculation.
- **Modifications**: Yes. See `git-ai-src/MODIFICATIONS.md` for details.

### Apache License 2.0 (Summary)

Licensed under the Apache License, Version 2.0. You may obtain a copy at:
http://www.apache.org/licenses/LICENSE-2.0

The full license text is preserved in `git-ai-src/LICENSE`.

---

## Chart.js

- **Source**: https://www.chartjs.org/
- **License**: MIT License
- **Usage**: Frontend charting library loaded via CDN in the Dashboard web application.
- **Modifications**: None.

---

## DOMPurify

- **Source**: https://github.com/cure53/DOMPurify
- **License**: Apache License 2.0 / MPL 2.0 (dual-licensed)
- **Usage**: HTML sanitization library loaded via CDN in the Dashboard web application.
- **Modifications**: None.

---

## better-sqlite3

- **Source**: https://github.com/WiseLibs/better-sqlite3
- **License**: MIT License
- **Usage**: SQLite database driver for the Dashboard service.
- **Modifications**: None.

---

## AWS SDK for JavaScript v3

- **Source**: https://github.com/aws/aws-sdk-js-v3
- **License**: Apache License 2.0
- **Usage**: AWS service integration (IAM Identity Center, CloudTrail, S3) in the Dashboard service.
- **Modifications**: None.
