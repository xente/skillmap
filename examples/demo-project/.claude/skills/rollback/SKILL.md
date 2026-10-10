---
name: rollback
description: Roll production back to the previous healthy release.
allowed-tools: Bash
---
# Rollback
Re-point traffic to the previous image. Once the fix is merged, use the
`deploy` skill again to ship it.
