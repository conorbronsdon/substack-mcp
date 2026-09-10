#!/usr/bin/env python3
"""Exercise this repository's SSOT locators in disposable copies, without edits."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def main():
    cli = Path(sys.argv[1]).resolve()
    root = Path(__file__).resolve().parents[1]
    manifest_name = ".ssot-local.yaml" if (root / ".ssot-local.yaml").exists() else ".ssot.yaml"
    manifest_text = (root / manifest_name).read_text(encoding="utf-8")
    spec = importlib.util.spec_from_file_location("ssot_check", cli)
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    manifest = checker.parse_manifest(manifest_text)

    def run(at, command="check", expected=0, *extra):
        result = subprocess.run(
            [sys.executable, "-X", "utf8", str(cli), command, "--manifest", str(at / manifest_name), *extra],
            text=True, capture_output=True, encoding="utf-8", cwd=at,
            env={**os.environ, "GITHUB_WORKSPACE": str(at)},
        )
        if result.returncode != expected:
            raise AssertionError(f"{command}: expected {expected}, got {result.returncode}\n{result.stdout}\n{result.stderr}")
        return result.stdout

    run(root)
    tested = 0
    with tempfile.TemporaryDirectory(prefix="ssot-controls-") as directory:
        scratch = Path(directory)
        (scratch / manifest_name).write_text(manifest_text, encoding="utf-8")
        for fact in manifest["facts"]:
            for locator in [fact["canonical"], *fact["copies"]]:
                relative = locator["file"]
                target = scratch / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((root / relative).read_bytes())
        run(scratch)
        for fact in manifest["facts"]:
            for locator in fact["copies"]:
                target = scratch / locator["file"]
                original = target.read_text(encoding="utf-8")
                match = re.search(locator["pattern"], original, re.MULTILINE)
                if match is None:
                    raise AssertionError(f"Unmatched locator: {locator}")
                changed = original[:match.start(1)] + "987654" + original[match.end(1):]
                target.write_text(changed, encoding="utf-8")
                report = json.loads(run(scratch, "check", 1, "--json"))
                if report["summary"]["drifted"] < 1:
                    raise AssertionError(f"Mutation did not report drift: {locator}")
                # Discovery exclusions must not disable an explicitly registered copy.
                ignored = manifest_text.replace("ignore_paths:\n", f'ignore_paths:\n  - "{locator["file"]}"\n', 1)
                (scratch / manifest_name).write_text(ignored, encoding="utf-8")
                run(scratch, "check", 1)
                (scratch / manifest_name).write_text(manifest_text, encoding="utf-8")
                target.write_text(original, encoding="utf-8")
                run(scratch)
                target.unlink()
                run(scratch, "check", 1)
                target.write_text(original, encoding="utf-8")
                tested += 1
        (scratch / manifest_name).unlink()
        run(scratch, "check", 2)
        (scratch / manifest_name).write_text("facts: invalid\n", encoding="utf-8")
        run(scratch, "check", 2)

    # Synthetic, supported discovery values. Node/Python floors are not discoverable.
    with tempfile.TemporaryDirectory(prefix="ssot-discovery-") as directory:
        scratch = Path(directory)
        (scratch / manifest_name).write_text(r"""ignore_paths:
  - "CHANGELOG.md"
facts:
  - name: example-price
    type: currency
    canonical:
      file: current.md
      pattern: 'Price: \$(\d+)'
    copies:
      - file: guide.md
        pattern: 'Price: \$(\d+)'
""", encoding="utf-8")
        for name in ("current.md", "guide.md"):
            (scratch / name).write_text("Price: $100\n", encoding="utf-8")
        (scratch / "CHANGELOG.md").write_text("Historical price: $50\nOld price: $50\n", encoding="utf-8")
        run(scratch)
        clean = run(scratch, "discover", 0, "--untracked-only", "--github-annotations")
        if "::warning" in clean:
            raise AssertionError(f"Tracked or historical values generated warnings: {clean}")
        (scratch / "new-page.md").write_text("Price: $100\n", encoding="utf-8")
        run(scratch)
        warning = run(scratch, "discover", 0, "--untracked-only", "--github-annotations")
        if "::warning file=new-page.md" not in warning or "::warning file=CHANGELOG.md" in warning:
            raise AssertionError(f"Expected only the unregistered current copy warning: {warning}")
    print(f"SSOT controls passed: {tested} real copy locators; drift, restore, missing copy/manifest, invalid manifest, exclusion, advisory discovery.")


if __name__ == "__main__":
    main()
