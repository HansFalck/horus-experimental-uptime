# horus-experimental-uptime

Probes https://app.horus-experimental.no/health from GitHub's runners every 5 minutes. Unreachable for 5 minutes -> one `For-Zazu: EXPERIMENTAL DOWN` issue here + a phone push (ntfy); closes itself on recovery.

Source of truth: starfleet-development `tools/horus-experimental/uptime/` (#470). Do not edit here.
