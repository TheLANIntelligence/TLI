#!/usr/bin/env bash
# Legacy native backend packaging is disabled before any build or installation work.
printf '%s\n' \
    'TLI native Linux package builds are not validated and this legacy builder is disabled.' \
    'For the reviewed source ZIP, run: python3 build_dist.py' \
    'To run a source checkout, follow the setup instructions in README.md.' \
    'No dependencies, files, packages, or services were changed.' >&2
exit 2
