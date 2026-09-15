---
id: D-T1
model_class: worker
review: false
allowed_paths:
  - demo/output/foundation.txt
verification:
  - >-
    python -c "import os; assert os.path.isfile(r'demo/output/foundation.txt')"
---

# Goal

Create demo/output/foundation.txt containing exactly: foundation.

# Required context

No project architecture is needed. This is only a harness smoke task.

# Scope

Create only the requested demo file.

# Out of scope

Do not modify harness code or project files.

# Acceptance criteria

The requested file exists with the requested content.
