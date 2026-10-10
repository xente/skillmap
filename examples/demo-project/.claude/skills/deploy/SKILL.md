---
name: deploy
description: Deploy a tagged build to production with a canary step.
allowed-tools: Bash
---
# Deploy
Push the image, shift 10% of traffic, watch error rates for 10 minutes.
If error rates climb, use the `rollback` skill immediately.
