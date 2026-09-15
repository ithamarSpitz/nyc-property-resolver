---
id: D-T4
model_class: worker
review: false
allowed_paths:
  - demo/output/joined.txt
verification:
  - >-
    python -c "import os; assert os.path.isfile(r'demo/output/joined.txt')"
---

# Goal

Create demo/output/joined.txt containing exactly: joined.

# Required context

No project architecture is needed. This is only a harness smoke task.

# Scope

Create only the requested demo file.

# Out of scope

Do not modify harness code or project files.

# Acceptance criteria

The requested file exists with the requested content.
