#!/usr/bin/env python3
"""Convert any USD variant (.usd binary Crate, .usda text) to a Three.js-compatible .usdz.

Three.js USDZLoader only parses USDA (text) format inside the ZIP.
So we export the stage root layer to USDA, then bundle it with textures.
"""
import sys
import os
import re
import zipfile
import shutil


def collect_textures(usda_text: str, src_dir: str) -> list[tuple[str, str]]:
    """
    Return [(local_fs_path, zip_path), ...] for all textures referenced in the USDA.
    Handles both @./textures/foo.png@ and @./SubUSDs/textures/foo.png@ style refs.
    """
    refs = re.findall(r'@([^@]+\.(?:png|jpg|jpeg|hdr|exr))@', usda_text, re.IGNORECASE)
    seen_zip: set[str] = set()
    result: list[tuple[str, str]] = []

    for ref in refs:
        # Normalise: strip leading ./ or /
        clean = ref.lstrip('./')
        # Flatten: always store as textures/<basename> in the zip
        basename = os.path.basename(clean)
        zip_path = f'textures/{basename}'
        if zip_path in seen_zip:
            continue

        # Try to find the texture on disk relative to src_dir
        candidates = [
            os.path.join(src_dir, clean),
            os.path.join(src_dir, 'textures', basename),
            os.path.join(src_dir, 'SubUSDs', 'textures', basename),
        ]
        for candidate in candidates:
            if os.path.isfile(candidate):
                seen_zip.add(zip_path)
                result.append((candidate, zip_path))
                break

    return result


def fix_texture_refs(usda_text: str) -> str:
    """Rewrite all texture refs to ./textures/<basename> so they match ZIP layout."""
    def replace_ref(m: re.Match) -> str:
        original = m.group(1)
        basename = os.path.basename(original)
        return f'@./textures/{basename}@'

    return re.sub(
        r'@([^@]+\.(?:png|jpg|jpeg|hdr|exr))@',
        replace_ref,
        usda_text,
        flags=re.IGNORECASE
    )


def convert(src: str, dst: str) -> None:
    from pxr import Usd  # type: ignore

    src_abs = os.path.abspath(src)
    dst_abs = os.path.abspath(dst)
    src_dir = os.path.dirname(src_abs)
    src_base = os.path.splitext(os.path.basename(src_abs))[0]

    original_cwd = os.getcwd()
    os.chdir(src_dir)

    try:
        stage = Usd.Stage.Open(os.path.basename(src_abs))

        # Export root layer as USDA text
        tmp_usda = dst_abs.replace('.usdz', '.usda')
        stage.GetRootLayer().Export(tmp_usda)

        with open(tmp_usda, 'r', encoding='utf-8') as f:
            usda_text = f.read()

        # Fix texture refs to ./textures/<basename>
        usda_fixed = fix_texture_refs(usda_text)
        with open(tmp_usda, 'w', encoding='utf-8') as f:
            f.write(usda_fixed)

        # Collect texture files
        textures = collect_textures(usda_fixed, src_dir)

        # Build USDZ ZIP (USDA must be the first entry, stored uncompressed per spec)
        usda_zip_name = f'{src_base}.usda'
        with zipfile.ZipFile(dst_abs, 'w', compression=zipfile.ZIP_STORED) as zf:
            zf.write(tmp_usda, usda_zip_name)
            for fs_path, zip_path in textures:
                zf.write(fs_path, zip_path)

        # Clean up temp USDA
        try:
            os.remove(tmp_usda)
        except OSError:
            pass

        if not os.path.exists(dst_abs) or os.path.getsize(dst_abs) == 0:
            raise RuntimeError(f'Output USDZ not created at {dst_abs}')

        print(f'[usd_to_usdz] Created {dst_abs} with {len(textures)} textures', file=sys.stderr)

    finally:
        os.chdir(original_cwd)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(f'Usage: {sys.argv[0]} <src.usd|src.usda> <dst.usdz>', file=sys.stderr)
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2])
