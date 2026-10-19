# Upstream references

- No third-party code is copied into this plugin.
- Parsing semantics of Claude Code logs (deduplicate on `message.id:requestId`, first entry wins,
  four token buckets, skip `<synthetic>`) and of Codex rollout `token_count` events (cached input is
  a subset of input) were taken from the behaviour of ccusage
  (https://github.com/ryoppippi/ccusage, MIT, Copyright (c) 2025 ryoppippi) so that totals
  reconcile. The implementation here is written from scratch.
- Price data: built-in estimate table in `server/pricing.ts` (own values). The `pricingFile` setting
  reads the LiteLLM `model_prices_and_context_window.json` format (the dataset ccusage uses); no
  file is bundled. If a copy of that data or of ccusage code is ever added, keep the MIT notice
  here and in the file header.
