"""Source installation entrypoint; intentionally imports no application modules."""
import sys
from pathlib import Path

# -I excludes the script directory. Add only the trusted bundled module folder.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from storage_scan_worker import main

if __name__ == "__main__":
    main()
