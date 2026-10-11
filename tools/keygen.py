#!/usr/bin/env python3
"""
tools/keygen.py — TLI developer key generator.

Usage:
  python tools/keygen.py --tier pro --licensee "User Name"
  python tools/keygen.py --tier trial --licensee "Beta Tester" --expires 2025-12-31
  python tools/keygen.py --tier pro --licensee "User Name" --node-id <uuid>

Set TLI_LICENSE_SECRET env var to match the backend secret before generating keys.
"""

import argparse
import sys
import os

# Allow running from repo root or tools/ dir
_here = os.path.dirname(os.path.abspath(__file__))
_backend = os.path.join(os.path.dirname(_here), "backend")
if _backend not in sys.path:
    sys.path.insert(0, _backend)

import license as L


def main():
    parser = argparse.ArgumentParser(description="TLI License Key Generator")
    parser.add_argument("--tier", choices=["free", "trial", "pro"], required=True)
    parser.add_argument("--licensee", required=True, help="Name or email of licensee")
    parser.add_argument("--expires", default=None,
                        help="Expiry date YYYY-MM-DD (optional, pro keys default to no expiry)")
    parser.add_argument("--node-id", default=None,
                        help="Bind key to a specific machine node_id (optional)")
    parser.add_argument("--verify", action="store_true",
                        help="After generating, validate the key and print result")

    args = parser.parse_args()

    expires_at = None
    if args.expires:
        # Accept YYYY-MM-DD and convert to ISO8601
        try:
            from datetime import datetime
            dt = datetime.strptime(args.expires, "%Y-%m-%d")
            expires_at = dt.strftime("%Y-%m-%dT00:00:00Z")
        except ValueError:
            print(f"Error: --expires must be YYYY-MM-DD, got: {args.expires}", file=sys.stderr)
            sys.exit(1)

    key = L.generate_key(
        tier=args.tier,
        licensee=args.licensee,
        expires_at=expires_at,
        node_id=args.node_id,
    )

    print("\n" + "=" * 60)
    print("  TLI LICENSE KEY")
    print("=" * 60)
    print(f"  Tier:     {args.tier.upper()}")
    print(f"  Licensee: {args.licensee}")
    if expires_at:
        print(f"  Expires:  {expires_at}")
    else:
        print(f"  Expires:  Never")
    if args.node_id:
        print(f"  Node:     {args.node_id}")
    print("=" * 60)
    print(f"\n{key}\n")

    if args.verify:
        result = L.validate_key(key, current_node_id=args.node_id)
        print("Verification:", "PASS" if result["valid"] else "FAIL")
        if not result["valid"]:
            print("Error:", result.get("error"))
            sys.exit(1)
        print("Features unlocked:")
        for feat in ["mesh", "vault", "home_automation", "advanced_ai", "peer_nodes", "multi_shelly", "debug_panel"]:
            tick = "✓" if L.has_feature(result["tier"], feat) else "✗"
            print(f"  {tick} {feat}")

    print()


if __name__ == "__main__":
    main()
