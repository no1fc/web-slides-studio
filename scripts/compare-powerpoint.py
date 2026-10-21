"""Measure diagnostic RGB differences and render paired browser/PowerPoint PNGs.

Run after powerpoint-fixture.mjs and verify-powerpoint.ps1. No Office process is
started. Metrics describe pixel differences, not fidelity scores or pass/fail.
Requires Pillow and numpy (available in the bundled Codex Python runtime).
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rgb_image(path: Path) -> Image.Image:
    with Image.open(path) as source:
        if "A" in source.getbands():
            canvas = Image.new("RGBA", source.size, (255, 255, 255, 255))
            return Image.alpha_composite(canvas, source.convert("RGBA")).convert("RGB")
        return source.convert("RGB")


def metrics(difference: np.ndarray, threshold: int) -> dict:
    if difference.size == 0:
        raise ValueError("A comparison region must contain at least one pixel.")
    per_pixel_max = difference.max(axis=2)
    changed = int(np.count_nonzero(per_pixel_max > threshold))
    pixels = int(per_pixel_max.size)
    return {
        "pixels": pixels,
        "rgbMeanAbsoluteDifference": round(float(difference.mean()), 6),
        "rgbMeanAbsoluteDifferenceByChannel": [round(float(value), 6) for value in difference.mean(axis=(0, 1))],
        "pixelsWithMaxChannelDifferenceAboveThreshold": changed,
        "fractionWithMaxChannelDifferenceAboveThreshold": round(changed / pixels, 8),
        "maxChannelDifference": int(per_pixel_max.max()),
    }


def object_regions(objects: list[dict], frame_size: tuple[int, int]):
    """Collected group children already have slide coordinates and rotation."""
    for obj in objects:
        if obj.get("hidden"):
            continue
        if all(isinstance(obj.get(key), (float, int)) and math.isfinite(obj[key]) for key in ("x", "y", "w", "h")):
            x, y, width, height = (float(obj[key]) for key in ("x", "y", "w", "h"))
            angle = math.radians(float(obj.get("rotate", 0)))
            half_width = (abs(math.cos(angle)) * width + abs(math.sin(angle)) * height) / 2
            half_height = (abs(math.sin(angle)) * width + abs(math.cos(angle)) * height) / 2
            center_x, center_y = x + width / 2, y + height / 2
            requested = [math.floor(center_x - half_width), math.floor(center_y - half_height), math.ceil(center_x + half_width), math.ceil(center_y + half_height)]
            clipped = [max(0, requested[0]), max(0, requested[1]), min(frame_size[0], requested[2]), min(frame_size[1], requested[3])]
            if clipped[2] > clipped[0] and clipped[3] > clipped[1]:
                yield {
                    "id": obj.get("id"), "kind": obj.get("kind"),
                    "groupChild": bool(obj.get("groupChild")),
                    "declaredFrame": {key: obj.get(key, 0) for key in ("x", "y", "w", "h", "rotate")},
                    "requestedBounds": requested, "comparedBounds": clipped,
                }
        yield from object_regions(obj.get("children", []), frame_size)


def make_sheet(browser: Image.Image, powerpoint: Image.Image, title: str, path: Path) -> None:
    # Keep source pixels unchanged. Both 1920x1080 captures appear at 1:1 scale.
    width, height = browser.size
    header = 76
    sheet = Image.new("RGB", (width * 2, height + header), "#f3f5f8")
    sheet.paste(browser, (0, header))
    sheet.paste(powerpoint, (width, header))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=26)
    small = ImageFont.load_default(size=19)
    draw.text((20, 10), title, fill="#142c45", font=font)
    draw.text((20, 46), "Browser reference | 1:1 pixels", fill="#42556a", font=small)
    draw.text((width + 20, 46), "Microsoft PowerPoint before editing | 1:1 pixels", fill="#42556a", font=small)
    draw.line((width, 0, width, height + header), fill="#8391a0", width=2)
    sheet.save(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parents[1] / "output" / "powerpoint")
    parser.add_argument("--threshold", type=int, default=24, help="Strict per-pixel max RGB-channel difference cutoff, default 24/255.")
    args = parser.parse_args()
    if not 0 <= args.threshold <= 255:
        parser.error("threshold must be between 0 and 255")
    root = args.directory.resolve()
    manifest_path = root / "fixture-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    state_path = root / "fixture-state.json"
    state = json.loads(state_path.read_text(encoding="utf-8-sig"))
    powerpoint_report_path = root / "powerpoint-report.json"
    powerpoint_report = json.loads(powerpoint_report_path.read_text(encoding="utf-8-sig"))
    if manifest["sha256"] != powerpoint_report["inputSha256"]:
        raise ValueError("Browser fixture and PowerPoint report refer to different PPTX files; regenerate both captures before comparing.")
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "description": "Diagnostic differences between two raster renderers; these are not fidelity scores or acceptance criteria.",
        "method": {
            "colorSpace": "Decoded 8-bit RGB values; no perceptual or gamma correction",
            "alpha": "Composited on white when present",
            "registration": "Original pixel coordinates; no alignment, resizing, or text masking",
            "rgbMeanAbsoluteDifference": "Mean absolute channel difference over all R/G/B samples, scale 0..255",
            "threshold": args.threshold,
            "fractionWithMaxChannelDifferenceAboveThreshold": "Fraction of pixels whose largest absolute R/G/B channel difference is strictly greater than threshold",
            "objectRegions": "Axis-aligned bounds of declared frames, accounting for rotation and clipping to the slide. Group-child frames are collected in slide coordinates. Overlap includes other objects; overflowing glyphs outside a frame are not measured in that object's region.",
            "limitations": "Font rasterization, antialiasing, chart tick formatting, line placement, JPEG background compression, and intentional unsupported-feature fallbacks all contribute. Low whole-slide differences can hide small but important local differences.",
        },
        "source": {"pptxSha256": manifest["sha256"], "manifestSha256": sha256(manifest_path), "stateSha256": sha256(state_path), "powerpointReportSha256": sha256(powerpoint_report_path), "powerpointValidationPassed": powerpoint_report.get("passed", False)},
        "slides": [],
    }
    for slide in manifest["slides"]:
        index = slide["index"]
        browser_path = root / f"browser-slide-{index}.png"
        powerpoint_path = root / f"powerpoint-before-slide-{index}.png"
        browser, powerpoint = rgb_image(browser_path), rgb_image(powerpoint_path)
        if browser.size != powerpoint.size or browser.size != (1920, 1080):
            raise ValueError(f"Slide {index}: expected two 1920x1080 images, got {browser.size} and {powerpoint.size}.")
        difference = np.abs(np.asarray(browser, dtype=np.int16) - np.asarray(powerpoint, dtype=np.int16))
        entry = {
            "index": index, "id": slide["id"], "size": list(browser.size),
            "browser": {"file": browser_path.name, "sha256": sha256(browser_path)},
            "powerpoint": {"file": powerpoint_path.name, "sha256": sha256(powerpoint_path)},
            "wholeSlide": metrics(difference, args.threshold), "regions": [],
        }
        state_by_id = {item["id"]: item for item in state.get("added", []) if item["slide"] == slide["id"]}
        for region in object_regions(slide["objects"], browser.size):
            left, top, right, bottom = region["comparedBounds"]
            region["metrics"] = metrics(difference[top:bottom, left:right], args.threshold)
            canonical = state_by_id.get(region["id"])
            if canonical:
                region["canonicalKind"] = canonical["kind"]
                if canonical["kind"] == "chart":
                    region["chartType"] = canonical["chart"]["type"]
            entry["regions"].append(region)
        sheet_path = root / f"comparison-slide-{index}.png"
        make_sheet(browser, powerpoint, f"Slide {index}: browser / PowerPoint comparison", sheet_path)
        entry["contactSheet"] = sheet_path.name
        report["slides"].append(entry)
    output_path = root / "visual-comparison.json"
    output_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(output_path), "slides": [{"index": item["index"], **item["wholeSlide"]} for item in report["slides"]]}, indent=2))


if __name__ == "__main__":
    main()
