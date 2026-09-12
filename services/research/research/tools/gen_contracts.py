"""Generate pydantic v2 models from packages/contracts/schemas/*.json into research/contracts/gen.py.

Lives outside research.contracts so it can run before gen.py exists. Run via `pnpm gen`.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from ..settings import SCHEMAS_DIR

OUT = Path(__file__).resolve().parent.parent / "contracts" / "gen.py"


def main() -> None:
    defs = {}
    for path in sorted(SCHEMAS_DIR.glob("*.json")):
        schema = json.loads(path.read_text())
        schema.pop("$schema", None)
        schema.pop("$id", None)
        defs[schema["title"]] = schema
    merged = {"$schema": "http://json-schema.org/draft-07/schema#", "title": "Contracts", "$defs": defs}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(merged, f)
        tmp = f.name
    cmd = [
        sys.executable, "-m", "datamodel_code_generator",
        "--input", tmp, "--input-file-type", "jsonschema",
        "--output", str(OUT),
        "--output-model-type", "pydantic_v2.BaseModel",
        "--use-standard-collections", "--use-union-operator",
        "--field-constraints", "--use-annotated",
        "--disable-timestamp",
    ]
    subprocess.run(cmd, check=True)
    print(f"generated {len(defs)} pydantic model(s) -> {OUT}")


if __name__ == "__main__":
    main()
